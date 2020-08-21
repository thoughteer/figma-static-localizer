type Settings = {
    serializedDictionary: string;
    serializedExceptions: string;
    sourceLanguage: string;
    targetLanguage: string;
};

type Dictionary = {
    header: string[];
    rows: string[][];
};

type Mapping = {
    [source: string]: string;
};

type Style = {
    id: string;
    fills: Paint[];
    fillStyleId: string;
    fontName: FontName;
    fontSize: number;
    letterSpacing: LetterSpacing;
    lineHeight: LineHeight;
    textDecoration: TextDecoration;
    textStyleId: string;
};

type Section = {
    from: number;
    to: number;
    style: Style;
};

type Replacement = null | {
    node: TextNode;
    translation: string;
    baseStyle: Style;
    sections: Section[];
};

type ReplacementFailure = {
    nodeId: string;
    error: string;
    suggestions: string[];
};

type ReplacementAttempt = Replacement | ReplacementFailure;


namespace SettingsManager {
    const DEFAULT: Settings = {
        serializedDictionary: 'RU\tEN\nПривет!\tHello!',
        serializedExceptions: '',
        sourceLanguage: 'RU',
        targetLanguage: 'EN',
    };
    const FIELDS = Object.keys(DEFAULT);
    const CLIENT_STORAGE_PREFIX = 'StaticLocalizer.';

    export async function load(): Promise<Settings> {
        const result = <Settings> {};
        const promises = FIELDS.map(field => figma.clientStorage.getAsync(CLIENT_STORAGE_PREFIX + field).then(value => ({field, value: value === undefined ? DEFAULT[field] : value})));
        (await Promise.all(promises)).forEach(({field, value}) => {
            result[field] = value;
        });
        return result;
    }

    export async function save(settings: Settings): Promise<void> {
        await Promise.all(FIELDS.map(field => figma.clientStorage.setAsync(CLIENT_STORAGE_PREFIX + field, settings[field])));
    }
};


async function translateSelection(settings: Settings): Promise<void> {
    const dictionary = await parseDictionary(settings.serializedDictionary);
    const mapping = await getMapping(dictionary, settings.sourceLanguage, settings.targetLanguage);
    const exceptions = await parseExceptions(settings.serializedExceptions);
    await replaceAllTexts(mapping, exceptions);
}

async function parseDictionary(serializedDictionary: string): Promise<Dictionary> {
    const table = encodeURI(serializedDictionary).split('%0A').map(line => line.split('%09').map(field => decodeURI(field.trim())));
    if (table.length === 0) {
        throw {error: 'no header in the dictionary'};
    }
    const header = table[0];
    const expectedColumnCount = header.length;
    const rows = table.slice(1, table.length);
    console.log('Dictionary:', {header, rows});
    rows.forEach((row, index) => {
        if (row.length != expectedColumnCount) {
            throw {error: 'row ' + (index + 2) + ' of the dictionary has ' + row.length + ' (not ' + expectedColumnCount + ') columns'};
        }
    });
    return {header, rows};
}

async function getMapping(dictionary: Dictionary, sourceLanguage: string, targetLanguage: string): Promise<Mapping> {
    const sourceColumnIndex = dictionary.header.indexOf(sourceLanguage);
    if (sourceColumnIndex == -1) {
        throw {error: sourceLanguage + ' not listed in [' + dictionary.header + ']'};
    }
    const targetColumnIndex = dictionary.header.indexOf(targetLanguage);
    if (targetColumnIndex == -1) {
        throw {error: targetLanguage + ' not listed in [' + dictionary.header + ']'};
    }
    const result: Mapping = {};
    dictionary.rows.forEach(row => {
        const sourceString = row[sourceColumnIndex];
        const targetString = row[targetColumnIndex];
        if (targetString.trim() !== '') {
            result[sourceString] = targetString;
        }
    });
    console.log('Extracted mapping:', result);
    return result;
}

async function parseExceptions(serializedExceptions: string): Promise<RegExp[]> {
    return serializedExceptions.split('\n').filter(pattern => pattern !== '').map(pattern => {
        try {
            return new RegExp(pattern);
        } catch (_) {
            throw {error: 'invalid regular expression `' + pattern + '`'};
        }
    });
}

async function replaceAllTexts(mapping: Mapping, exceptions: RegExp[]): Promise<void> {
    const textNodes = await findSelectedTextNodes();

    const replacements = await mapWithRateLimit(textNodes, 200, node => computeReplacement(node, mapping, exceptions));
    const failures = replacements.filter(r => r !== null && 'error' in r) as ReplacementFailure[];
    if (failures.length > 0) {
        console.log('Failures:', failures);
        throw {error: 'found some untranslatable nodes', failures};
    }

    await mapWithRateLimit(replacements.filter(r => r !== null), 50, replaceText);
}

async function findSelectedTextNodes(): Promise<TextNode[]> {
    const result: TextNode[] = [];
    figma.currentPage.selection.forEach(root => {
        if (root.type === 'TEXT') {
            result.push(root as TextNode);
        } else if ('findAll' in root) {
            (root as ChildrenMixin).findAll(node => node.type === 'TEXT').forEach(node => result.push(node as TextNode));
        }
    });
    return result;
}

async function computeReplacement(node: TextNode, mapping: Mapping, exceptions: RegExp[]): Promise<ReplacementAttempt> {
    const content = normalizeContent(node.characters);
    if (keepAsIs(content, exceptions)) {
        return null;
    }

    const sections = sliceIntoSections(node);

    const suggestions = suggest(node, content, sections, mapping, exceptions);

    if (!(content in mapping)) {
        return {nodeId: node.id, error: 'No translation for `' + content + '`', suggestions};
    }

    const errorLog = [
        'Cannot determine a base style for `' + content + '`',
        'Split into ' + sections.length + ' sections',
    ];

    const styles = [];
    const styleIds = new Set<string>();
    sections.forEach(({from, to, style}) => {
        if (!styleIds.has(style.id)) {
            styleIds.add(style.id);
            styles.push({humanId: from + '-' + to, ...style});
        }
    });

    const result: Replacement = {
        node,
        translation: mapping[content],
        baseStyle: null,
        sections: [],
    };

    for (let baseStyleCandidate of styles) {
        const prelude = 'Style ' + baseStyleCandidate.humanId + ' is not base: ';
        let ok = true;
        result.sections.length = 0;
        for (let {from, to, style} of sections) {
            if (style.id === baseStyleCandidate.id) {
                continue;
            }
            const sectionContent = normalizeContent(node.characters.slice(from, to));
            let sectionTranslation = sectionContent;
            if (sectionContent in mapping) {
                sectionTranslation = mapping[sectionContent];
            } else if (!keepAsIs(sectionContent, exceptions)) {
                errorLog.push(prelude + 'no translation for `' + sectionContent + '`');
                ok = false;
                break;
            }
            const index = result.translation.indexOf(sectionTranslation);
            if (index == -1) {
                errorLog.push(prelude + '`' + sectionTranslation + '` not found within `' + result.translation + '`');
                ok = false;
                break;
            }
            if (result.translation.indexOf(sectionTranslation, index + 1) != -1) {
                errorLog.push(prelude + 'found multiple occurrencies of `' + sectionTranslation + '` within `' + result.translation + '`');
                ok = false;
                break;
            }
            result.sections.push({from: index, to: index + sectionTranslation.length, style});
        }
        if (ok) {
            result.baseStyle = baseStyleCandidate;
            break;
        }
    }

    if (result.baseStyle === null) {
        return {nodeId: node.id, error: errorLog.join('. '), suggestions};
    }

    console.log('Replacement:', result);

    return result;
}

function normalizeContent(content: string): string {
    return content.replace(/[\u000A\u2028\u202F\u00A0]/g, ' ').replace(/ +/g, ' ');
}

function keepAsIs(content: string, exceptions: RegExp[]): boolean {
    for (let regex of exceptions) {
        if (content.match(regex)) {
            return true;
        }
    }
    return false;
};

function sliceIntoSections(node: TextNode, from: number = 0, to: number = node.characters.length): Section[] {
    const style = getSectionStyle(node, from, to);
    if (style !== figma.mixed) {
        return [{from, to, style}];
    }

    const center = Math.floor((from + to) / 2);
    const leftSections = sliceIntoSections(node, from, center);
    const rightSections = sliceIntoSections(node, center, to);
    const lastLeftSection = leftSections[leftSections.length-1];
    const firstRightSection = rightSections[0];
    if (lastLeftSection.style.id === firstRightSection.style.id) {
        firstRightSection.from = lastLeftSection.from;
        leftSections.pop();
    }
    return leftSections.concat(rightSections);
}

function suggest(node: TextNode, content: string, sections: Section[], mapping: Mapping, exceptions: RegExp[]): string[] {
    const n = content.length;
    const styleScores = new Map<string, number>();
    for (let {from, to, style} of sections) {
        styleScores.set(style.id, n + to - from + (styleScores.get(style.id) || 0));
    }
    let suggestedBaseStyleId: string = null;
    let suggestedBaseStyleScore = 0;
    for (let [styleId, styleScore] of styleScores) {
        if (styleScore > suggestedBaseStyleScore) {
            suggestedBaseStyleId = styleId;
            suggestedBaseStyleScore = styleScore;
        }
    }

    const result: string[] = [];
    if (!(content in mapping)) {
        result.push(content);
    }
    for (let {from, to, style} of sections) {
        if (style.id === suggestedBaseStyleId) {
            continue;
        }
        const sectionContent = normalizeContent(node.characters.slice(from, to));
        if (!keepAsIs(sectionContent, exceptions) && !(sectionContent in mapping)) {
            result.push(sectionContent);
        }
    }
    return result;
}

async function replaceText(replacement: Replacement): Promise<void> {
    const {node, translation, baseStyle, sections} = replacement;
    await figma.loadFontAsync(baseStyle.fontName);
    await Promise.all(sections.map(({style}) => figma.loadFontAsync(style.fontName)));
    node.characters = translation;
    if (sections.length > 0) {
        setSectionStyle(node, 0, translation.length, baseStyle);
        for (let {from, to, style} of sections) {
            setSectionStyle(node, from, to, style);
        }
    }
}

function getSectionStyle(node: TextNode, from: number, to: number): Style | PluginAPI['mixed'] {
    const fills = node.getRangeFills(from, to);
    if (fills === figma.mixed) {
        return figma.mixed;
    }
    const fillStyleId = node.getRangeFillStyleId(from, to);
    if (fillStyleId === figma.mixed) {
        return figma.mixed;
    }
    const fontName = node.getRangeFontName(from, to);
    if (fontName === figma.mixed) {
        return figma.mixed;
    }
    const fontSize = node.getRangeFontSize(from, to);
    if (fontSize === figma.mixed) {
        return figma.mixed;
    }
    const letterSpacing = node.getRangeLetterSpacing(from, to);
    if (letterSpacing === figma.mixed) {
        return figma.mixed;
    }
    const lineHeight = node.getRangeLineHeight(from, to);
    if (lineHeight === figma.mixed) {
        return figma.mixed;
    }
    const textDecoration = node.getRangeTextDecoration(from, to);
    if (textDecoration === figma.mixed) {
        return figma.mixed;
    }
    const textStyleId = node.getRangeTextStyleId(from, to);
    if (textStyleId === figma.mixed) {
        return figma.mixed;
    }
    const parameters = {
        fills,
        fillStyleId,
        fontName,
        fontSize,
        letterSpacing,
        lineHeight,
        textDecoration,
        textStyleId,
    };
    return {
        id: JSON.stringify(parameters),
        ...parameters,
    };
}

function setSectionStyle(node: TextNode, from: number, to: number, style: Style): void {
    node.setRangeFills(from, to, style.fills);
    node.setRangeFillStyleId(from, to, style.fillStyleId);
    node.setRangeFontName(from, to, style.fontName);
    node.setRangeFontSize(from, to, style.fontSize);
    node.setRangeLetterSpacing(from, to, style.letterSpacing);
    node.setRangeLineHeight(from, to, style.lineHeight);
    node.setRangeTextDecoration(from, to, style.textDecoration);
    node.setRangeTextStyleId(from, to, style.textStyleId);
}

function mapWithRateLimit<X, Y>(array: X[], rateLimit: number, mapper: (x: X) => Promise<Y>): Promise<Y[]> {
    return new Promise((resolve, reject) => {
        const result = new Array<Y>(array.length);
        let index = 0;
        let done = 0;
        var startTime = Date.now();

        const computeDelay = () => startTime + index * 1000.0 / rateLimit - Date.now();

        const schedule = () => {
            while (index < array.length && computeDelay() < 0) {
                (i => {
                    mapper(array[i]).then(y => {
                        result[i] = y;
                        ++done;
                        schedule();
                    }, reject);
                })(index);
                ++index;
            }
            if (done === array.length) {
                resolve(result);
            } else {
                const delay = computeDelay();
                if (delay >= 0) {
                    setTimeout(schedule, delay);
                }
            }
        }

        schedule();
    });
}


figma.showUI(__html__, {width: 400, height: 400});

figma.ui.onmessage = async message => {
    if (message.type === 'load-settings') {
        const settings = await SettingsManager.load();
        console.log('Loaded settings:', settings);
        figma.ui.postMessage({type: 'settings', settings});
        figma.ui.postMessage({type: 'ready'});
    } else if (message.type === 'translate-selection') {
        await SettingsManager.save(message.settings);
        await translateSelection(message.settings)
            .then(() => {
                figma.notify('Done');
                figma.closePlugin();
            })
            .catch(reason => {
                if ('error' in reason) {
                    figma.notify('Localization failed: ' + reason.error);
                    if ('failures' in reason) {
                        figma.ui.postMessage({type: 'failures', failures: reason.failures});
                    }
                } else {
                    figma.notify(reason.toString());
                }
                figma.ui.postMessage({type: 'ready'});
            });
    } else if (message.type === 'focus-node') {
        figma.viewport.zoom = 1000.0;
        figma.viewport.scrollAndZoomIntoView([figma.getNodeById(message.id)]);
        figma.viewport.zoom = 0.75 * figma.viewport.zoom;
    }
};

