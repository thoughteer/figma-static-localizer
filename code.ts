type Settings = {
    serializedDictionary: string;
    serializedExceptions: string;
    serializedCurrencies: string;
    sourceLanguage: string;
    targetLanguage: string;
    targetLanguageIsRTL: boolean;
    sourceCurrencyCode: string;
    targetCurrencyCode: string;
    serializedFontSubstitutions: string;
};

namespace SettingsManager {
    const DEFAULT: Settings = {
        serializedDictionary: 'RU\tEN\nПривет!\tHello!',
        serializedExceptions: '',
        serializedCurrencies: '[\n\t{\n\t\t"code": "RU",\n\t\t"schema": "123 \\u20bd",\n\t\t"digitGroupSeparator": " ",\n\t\t"decimalSeparator": "",\n\t\t"precision": 0,\n\t\t"rate": 1},\n\t{\n\t\t"code": "US",\n\t\t"schema": "$123",\n\t\t"digitGroupSeparator": ",",\n\t\t"decimalSeparator": ".",\n\t\t"precision": 2,\n\t\t"rate": 0.013\n\t}\n]',
        sourceLanguage: 'RU',
        targetLanguage: 'EN',
        targetLanguageIsRTL: false,
        sourceCurrencyCode: 'RU',
        targetCurrencyCode: 'US',
        serializedFontSubstitutions: '[]',
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


// *

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


// Translation

type Dictionary = {
    header: string[];
    rows: string[][];
};

type Mapping = {
    [source: string]: string;
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


async function translateSelection(settings: Settings): Promise<void> {
    const dictionary = await parseDictionary(settings.serializedDictionary);
    const mapping = await getMapping(dictionary, settings.sourceLanguage, settings.targetLanguage);
    const exceptions = await parseExceptions(settings.serializedExceptions);
    await replaceAllTexts(mapping, exceptions, settings.targetLanguageIsRTL);
}

async function parseDictionary(serializedDictionary: string): Promise<Dictionary> {
    const table = serializedDictionary.split('\n').map(line => line.split('\t').map(field => field.trim()));
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
            if (sourceString in result) {
                throw {error: 'multiple translations for `' + sourceString + '` in the dictionary'};
            }
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

async function replaceAllTexts(mapping: Mapping, exceptions: RegExp[], targetLanguageIsRTL: boolean): Promise<void> {
    const textNodes = await findSelectedTextNodes();

    let replacements = (await mapWithRateLimit(textNodes, 200, node => computeReplacement(node, mapping, exceptions))).filter(r => r !== null);
    let failures = replacements.filter(r => 'error' in r) as ReplacementFailure[];
    if (failures.length == 0 && targetLanguageIsRTL) {
        replacements = await mapWithRateLimit(replacements, 100, reverseAndWrapReplacement);
        failures = replacements.filter(r => 'error' in r) as ReplacementFailure[];
    }
    if (failures.length > 0) {
        console.log('Failures:', failures);
        throw {error: 'found some untranslatable nodes', failures};
    }

    if (targetLanguageIsRTL) {
        await reverseNodeAlignments(textNodes);
    }

    await mapWithRateLimit(replacements, 50, replaceText);
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

    const result: Replacement = {
        node,
        translation: mapping[content],
        baseStyle: null,
        sections: [],
    };

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
    return content.replace(/[\u000A\u00A0\u2028\u202F]/g, ' ').replace(/ +/g, ' ');
}

function keepAsIs(content: string, exceptions: RegExp[]): boolean {
    for (let regex of exceptions) {
        if (content.match(regex)) {
            return true;
        }
    }
    return false;
};

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

async function reverseAndWrapReplacement(replacement: Replacement): Promise<ReplacementAttempt> {
    const reversedReplacement = await reverseReplacement(replacement);
    if (replacement.node.textAutoResize === 'WIDTH_AND_HEIGHT') {
        return reversedReplacement;
    }
    return wrapReplacement(reversedReplacement);
}

async function reverseReplacement(replacement: Replacement): Promise<Replacement> {
    const {reversedText: reversedTranslation, nonReversibleRanges} = reverseText(replacement.translation);
    const n = replacement.translation.length;
    const reversedSections = replacement.sections.map(({from, to, style}) => ({from: n - to, to: n - from, style}));
    const overridingSections: Section[] = [];

    for (let range of nonReversibleRanges) {
        overridingSections.push({...range, style: replacement.baseStyle});
        for (let {from, to, style} of reversedSections) {
            if (from < range.to && to > range.from) {
                overridingSections.push({
                    from: range.from + range.to - Math.min(to, range.to),
                    to: range.from + range.to - Math.max(from, range.from),
                    style,
                });
            }
        }
    }

    const result = {
        node: replacement.node,
        translation: reversedTranslation,
        baseStyle: replacement.baseStyle,
        sections: reversedSections.concat(overridingSections),
    };

    console.log('Reversed replacement:', result);

    return result;
}

function reverseText(text: string): {reversedText: string, nonReversibleRanges: {from: number, to: number}[]} {
    // TODO: replace with a proper implementation for RTL languages
    const words: string[] = [];
    const nonReversibleWordStack: string[] = [];
    const nonReversibleRanges: {from: number, to: number}[] = [];
    const dumpNonReversibleWordStack = (to: number) => {
        if (nonReversibleWordStack.length > 0) {
            const phrase = nonReversibleWordStack.reverse().join(' ');
            words.push(phrase);
            nonReversibleRanges.push({from: to - phrase.length, to});
            nonReversibleWordStack.length = 0;
        }
    };
    let offset = -1;
    for (let word of text.split(' ').reverse()) {
        if (isReversible(word)) {
            dumpNonReversibleWordStack(offset);
            words.push(word.split('').reverse().join(''));
        } else {
            nonReversibleWordStack.push(word);
        }
        offset += word.length + 1;
    };
    dumpNonReversibleWordStack(offset);
    return {reversedText: words.join(' '), nonReversibleRanges};
}

function isReversible(word: string): boolean {
    return /[\u0500-\u0700]|^$/.test(word);
}

async function wrapReplacement(replacement: Replacement): Promise<ReplacementAttempt> {
    await loadFontsForReplacement(replacement);

    const bufferNode = replacement.node.clone();
    bufferNode.opacity = 0;
    bufferNode.characters = '';
    bufferNode.textAutoResize = 'HEIGHT';

    let wrappedTranslationLines: string[] = [];
    let wrappedSections: Section[] = [];

    const words = replacement.translation.split(' ');
    let wordIndex = words.length - 1;
    let lineStart = replacement.translation.length;
    let lineEnd = lineStart;
    let currentLineOffset = 0;
    while (wordIndex >= 0) {
        let currentLine = '';
        let lineBreakStyle = replacement.baseStyle;
        while (wordIndex >= 0) {
            const word = words[wordIndex];
            const insertion = wordIndex > 0 ? (' ' + word) : word;
            const originalBufferHeight = bufferNode.height;
            bufferNode.insertCharacters(currentLineOffset, insertion, 'AFTER');
            lineStart -= insertion.length;
            for (let {from, to, style} of replacement.sections) {
                if (from < lineStart + insertion.length && to > lineStart) {
                    setSectionStyle(bufferNode, currentLineOffset + Math.max(0, from - lineStart), currentLineOffset + Math.min(to - lineStart, insertion.length), style);
                }
            }
            const newBufferHeight = bufferNode.height;
            if (newBufferHeight > originalBufferHeight) {
                bufferNode.deleteCharacters(currentLineOffset, currentLineOffset + insertion.length);
                lineStart += insertion.length;
                if (lineStart == lineEnd) {
                    bufferNode.remove();
                    return {nodeId: replacement.node.id, error: 'Word `' + reverseText(insertion).reversedText + '` does not fit into the box', suggestions: []};
                }
                const lineBreakOffset = currentLineOffset + currentLine.length;
                bufferNode.insertCharacters(lineBreakOffset, '\u2028', 'BEFORE');
                for (let {from, to, style} of replacement.sections.reverse()) {
                    if (from <= lineStart - 1 && lineStart - 1 < to) {
                        lineBreakStyle = style;
                        break;
                    }
                }
                setSectionStyle(bufferNode, lineBreakOffset, lineBreakOffset + 1, lineBreakStyle);
                break;
            }
            currentLine = insertion + currentLine;
            wordIndex --;
        }

        wrappedTranslationLines.push(currentLine);
        for (let {from, to, style} of replacement.sections) {
            if (from < lineEnd && to > lineStart) {
                wrappedSections.push({from: currentLineOffset + Math.max(0, from - lineStart), to: currentLineOffset + Math.min(to, lineEnd) - lineStart, style});
            }
        }
        if (wordIndex >= 0) {
            wrappedSections.push({from: currentLineOffset + currentLine.length, to: currentLineOffset + currentLine.length + 1, style: lineBreakStyle});
        }
        lineEnd = lineStart;
        currentLineOffset += currentLine.length + 1;
    }

    const result = {
        node: replacement.node,
        translation: wrappedTranslationLines.join('\u2028'),
        baseStyle: replacement.baseStyle,
        sections: wrappedSections,
    };

    bufferNode.remove();

    console.log('Wrapped replacement:', result);

    return result;
}

async function reverseNodeAlignments(nodes: TextNode[]): Promise<void> {
    const alignments = nodes.map(node => ({node, alignment: node.textAlignHorizontal}));
    await mapWithRateLimit(alignments, 500, async ({node, alignment}) => {
        if (alignment !== 'LEFT' && alignment !== 'RIGHT') {
            return;
        }
        await loadFontsForNode(node);
        if (alignment === 'LEFT') {
            node.textAlignHorizontal = 'RIGHT';
        } else if (alignment === 'RIGHT') {
            node.textAlignHorizontal = 'LEFT';
        }
    });
}

async function replaceText(replacement: Replacement): Promise<void> {
    await loadFontsForReplacement(replacement);

    const {node, translation, baseStyle, sections} = replacement;
    node.characters = translation;
    if (sections.length > 0) {
        setSectionStyle(node, 0, translation.length, baseStyle);
        for (let {from, to, style} of sections) {
            setSectionStyle(node, from, to, style);
        }
    }
}

async function loadFontsForReplacement(replacement: Replacement): Promise<void> {
    await figma.loadFontAsync(replacement.baseStyle.fontName);
    await Promise.all(replacement.sections.map(({style}) => figma.loadFontAsync(style.fontName)));
}

async function loadFontsForNode(node: TextNode): Promise<void> {
    await Promise.all(Array.from({length: node.characters.length}, (_, k) => k).map(i => {
        return figma.loadFontAsync(node.getRangeFontName(i, i + 1) as FontName);
    }));
}


// Currency conversion

type Currency = {
    code: string;
    schema: string;
    digitGroupSeparator: string;
    decimalSeparator: string;
    precision: number;
    rate: number;
};

async function convertCurrencyInSelection(settings: Settings): Promise<void> {
    const currencies = parseCurrencies(settings.serializedCurrencies);
    console.log('Currencies:', currencies);
    const sourceCurrency = currencies.filter(currency => currency.code === settings.sourceCurrencyCode)[0];
    if (sourceCurrency === undefined) {
        throw {error: 'unknown currency code `' + settings.sourceCurrencyCode + '`'};
    }
    const targetCurrency = currencies.filter(currency => currency.code === settings.targetCurrencyCode)[0];
    if (targetCurrency === undefined) {
        throw {error: 'unknown currency code `' + settings.targetCurrencyCode + '`'};
    }
    await replaceCurrencyInAllTexts(sourceCurrency, targetCurrency);
}

function parseCurrencies(serializedCurrencies: string): Currency[] {
    const codeSet = new Set<string>();
    return JSON.parse(serializedCurrencies).map((x: any, index: number) => {
        const currency: Currency = {
            code: null,
            schema: null,
            digitGroupSeparator: null,
            decimalSeparator: null,
            precision: null,
            rate: null,
        };
        Object.keys(currency).forEach(key => {
            if (x[key] === undefined || x[key] === null) {
                throw {error: 'invalid currency definition: no `' + key + '` in entry #' + (index + 1)};
            }
            if (key === 'schema' && x[key].indexOf('123') === -1) {
                throw {error: 'schema in entry #' + (index + 1) + ' should contain `123`'};
            }
            if (key === 'rate' && x[key] <= 0) {
                throw {error: 'non-positive rate in entry #' + (index + 1)};
            }
            currency[key] = x[key];
        });
        if (currency.precision > 0 && currency.decimalSeparator === '') {
            throw {error: 'entry #' + (index + 1) + ' must have a non-empty decimal separator'};
        }
        if (codeSet.has(currency.code)) {
            throw {error: 'multiple entries for `' + currency.code + '`'};
        }
        codeSet.add(currency.code);
        return currency;
    });
}

async function replaceCurrencyInAllTexts(sourceCurrency: Currency, targetCurrency: Currency): Promise<void> {
    const textNodes = await findSelectedTextNodes();

    const escapedSchema = escapeForRegExp(sourceCurrency.schema);
    const escapedDigitGroupSeparator = escapeForRegExp(sourceCurrency.digitGroupSeparator);
    const escapedDecimalSeparator = escapeForRegExp(sourceCurrency.decimalSeparator);
    const sourceValueRegExpString = '((?:[0-9]|' + escapedDigitGroupSeparator + ')+' + escapedDecimalSeparator + '[0-9]{' + sourceCurrency.precision + '})';
    const sourceRegExp = new RegExp('^' + escapedSchema.replace('123', sourceValueRegExpString) + '$');
    console.log('Source regular expression:', sourceRegExp.toString());

    await mapWithRateLimit(textNodes, 250, async node => {
        const content = node.characters;
        const match = content.match(sourceRegExp);
        if (match !== null && match[1] !== null && match[1] !== undefined) {
            const style = getSectionStyle(node, 0, node.characters.length);
            if (style === figma.mixed) {
                throw {error: 'node `' + content + '` has a mixed style'};
            }

            let sourceValueString = match[1].replace(new RegExp(escapedDigitGroupSeparator, 'g'), '');
            if (sourceCurrency.decimalSeparator !== '') {
                sourceValueString = sourceValueString.replace(sourceCurrency.decimalSeparator, '.');
            }
            const sourceValue = parseFloat(sourceValueString);
            const targetValue = sourceValue * targetCurrency.rate / sourceCurrency.rate;
            const truncatedTargetValue = Math.trunc(targetValue);
            const targetValueFraction = targetValue - truncatedTargetValue;
            const targetValueString = (
                truncatedTargetValue.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,').replace(/,/g, targetCurrency.digitGroupSeparator) +
                targetCurrency.decimalSeparator +
                targetValueFraction.toFixed(targetCurrency.precision).slice(2)
            );

            await figma.loadFontAsync(style.fontName);
            node.characters = targetCurrency.schema.replace('123', targetValueString);
        }
    });
}

function escapeForRegExp(s: string): string {
    return s.replace(/([[\^$.|?*+()])/g, '\\$1');
}


// Font substitution

async function sendAvailableFonts() {
    const availableFonts = (await figma.listAvailableFontsAsync()).map(f => f.fontName);
    figma.ui.postMessage({type: 'available-fonts', availableFonts});
}

async function sendSelectionFonts() {
    const textNodes = await findSelectedTextNodes();
    const selectionFontIds = new Set();
    const selectionFonts = [];
    await mapWithRateLimit(textNodes, 250, async node => {
        if (node.characters === '') {
            return;
        }
        const sections = sliceIntoSections(node);
        for (let {style} of sections) {
            const fontId = JSON.stringify(style.fontName);
            if (!selectionFontIds.has(fontId)) {
                selectionFontIds.add(fontId);
                selectionFonts.push(style.fontName);
            }
        }
    });
    figma.ui.postMessage({type: 'selection-fonts', selectionFonts});
}

async function substituteFontsInSelection(settings: Settings): Promise<void> {
    const substitutions = JSON.parse(settings.serializedFontSubstitutions);
    const fontMapping = new Map<string, FontName>();
    for (let substitution of substitutions) {
        const sourceFontId = JSON.stringify(substitution.sourceFont);
        fontMapping.set(sourceFontId, substitution.targetFont);
        await figma.loadFontAsync(substitution.targetFont);
    }

    const textNodes = await findSelectedTextNodes();
    await mapWithRateLimit(textNodes, 250, async node => {
        if (node.characters === '') {
            return;
        }
        const sections = sliceIntoSections(node);
        for (let {style} of sections) {
            await figma.loadFontAsync(style.fontName);
        }
        for (let {from, to, style} of sections) {
            const fontId = JSON.stringify(style.fontName);
            if (fontMapping.has(fontId)) {
                const newStyle = {...style};
                newStyle.fontName = fontMapping.get(fontId);
                setSectionStyle(node, from, to, newStyle);
            }
        }
    });
}


// Mirroring

type MirroringFailure = {
    nodeId: string;
    error: string;
};

async function mirrorSelection(settings: Settings): Promise<void> {
    const selection = figma.currentPage.selection;
    const nodesToMirror = selection.concat(findMirrorableNodes(selection));

    const componentIds: Set<string> = new Set();
    findNodesOfType(selection, 'COMPONENT').forEach(node => {
        componentIds.add(node.id);
    });

    const failures: MirroringFailure[] = [];
    findNodesOfType(selection, 'INSTANCE').forEach((node: InstanceNode) => {
        const componentId = node.mainComponent.id;
        if (node.locked) {
            if (componentIds.has(componentId) && !node.mainComponent.locked) {
                failures.push({nodeId: node.id, error: 'Locked, but its main component is not'});
                return;
            }
        } else {
            if (!componentIds.has(componentId)) {
                failures.push({nodeId: node.id, error: 'Unlocked, but its main component is not selected'});
                return;
            }
        }
    });
    if (failures.length > 0) {
        throw {error: 'found some unmirrorable nodes', failures};
    }

    await mapWithRateLimit(nodesToMirror, 300, mirrorNode);
}

function findMirrorableNodes(roots: readonly SceneNode[]): SceneNode[] {
    const result = [];
    roots.forEach(root => {
        if ('findAll' in root && !root.locked) {
            if (root.type !== 'INSTANCE') {
                findMirrorableNodes(root.children).forEach(node => result.push(node));
            }
        } else {
            result.push(root);
        }
    });
    return result;
}

function findNodesOfType(roots: readonly SceneNode[], nodeType: 'COMPONENT'|'INSTANCE'): SceneNode[] {
    const result = [];
    roots.forEach(root => {
        if (root.type === nodeType) {
            result.push(root);
        } else if ('findAll' in root && !root.locked) {
            findNodesOfType(root.children, nodeType).forEach(node => result.push(node));
        }
    });
    return result;
}

async function mirrorNode(node: SceneNode): Promise<void> {
    const w = node.width;
    const t = node.relativeTransform;
    node.relativeTransform = [
        [-t[0][0], t[0][1], w * t[0][0] + t[0][2]],
        [-t[1][0], t[1][1], w * t[1][0] + t[1][2]],
    ];
}


// Utilities

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

function sliceIntoSections(node: TextNode, from: number = 0, to: number = node.characters.length): Section[] {
    if (to == from) {
        return [];
    }

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
    node.setRangeTextStyleId(from, to, style.textStyleId);

    node.setRangeFills(from, to, style.fills);
    node.setRangeFillStyleId(from, to, style.fillStyleId);
    node.setRangeFontName(from, to, style.fontName);
    node.setRangeFontSize(from, to, style.fontSize);
    node.setRangeLetterSpacing(from, to, style.letterSpacing);
    node.setRangeLineHeight(from, to, style.lineHeight);
    node.setRangeTextDecoration(from, to, style.textDecoration);
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
    } else if (message.type === 'load-available-fonts') {
        await sendAvailableFonts();
    } else if (message.type === 'load-selection-fonts') {
        await sendSelectionFonts();
    } else if (message.type === 'translate') {
        await SettingsManager.save(message.settings);
        await translateSelection(message.settings)
            .then(() => {
                figma.notify('Done');
                figma.ui.postMessage({type: 'translation-failures', failures: []});
                figma.ui.postMessage({type: 'ready'});
            })
            .catch(reason => {
                if ('error' in reason) {
                    figma.notify('Translation failed: ' + reason.error);
                    if ('failures' in reason) {
                        figma.ui.postMessage({type: 'translation-failures', failures: reason.failures});
                    }
                } else {
                    figma.notify(reason.toString());
                }
                figma.ui.postMessage({type: 'ready'});
            });
    } else if (message.type === 'convert-currency') {
        await SettingsManager.save(message.settings);
        await convertCurrencyInSelection(message.settings)
            .then(() => {
                figma.notify('Done');
                figma.ui.postMessage({type: 'ready'});
            })
            .catch(reason => {
                if ('error' in reason) {
                    figma.notify('Currency conversion failed: ' + reason.error);
                } else {
                    figma.notify(reason.toString());
                }
                figma.ui.postMessage({type: 'ready'});
            });
    } else if (message.type === 'mirror') {
        await SettingsManager.save(message.settings);
        await mirrorSelection(message.settings)
            .then(() => {
                figma.notify('Done');
                figma.ui.postMessage({type: 'mirroring-failures', failures: []});
                figma.ui.postMessage({type: 'ready'});
            })
            .catch(reason => {
                if ('error' in reason) {
                    figma.notify('Mirroring failed: ' + reason.error);
                    if ('failures' in reason) {
                        figma.ui.postMessage({type: 'mirroring-failures', failures: reason.failures});
                    }
                } else {
                    figma.notify(reason.toString());
                }
                figma.ui.postMessage({type: 'ready'});
            });
    } else if (message.type === 'substitute-fonts') {
        await SettingsManager.save(message.settings);
        await substituteFontsInSelection(message.settings)
            .then(() => sendSelectionFonts().then(() => {
                figma.notify('Done');
                figma.ui.postMessage({type: 'ready'});
            }))
            .catch(reason => {
                if ('error' in reason) {
                    figma.notify('Font substitution failed: ' + reason.error);
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

figma.on("selectionchange", sendSelectionFonts);
