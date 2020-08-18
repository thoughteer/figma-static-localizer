const DEFAULTS = {
    serializedDictionary: 'RU\tEN\nПривет!\tHi!',
    serializedExceptions: 'Joom',
    sourceLanguage: 'RU',
    targetLanguage: 'EN',
};


async function loadSettings() {
    const result = {};
    const promises = Object.keys(DEFAULTS).map(field => figma.clientStorage.getAsync('StaticLocalizer.' + field).then(value => ({field, value: value || DEFAULTS[field]})));
    (await Promise.all(promises)).forEach(({field, value}) => {
        result[field] = value;
    });
    return result;
}

async function translateSelection(settings) {
    const dictionary = await parseDictionary(settings.serializedDictionary);
    const mapping = await getMapping(dictionary, settings.sourceLanguage, settings.targetLanguage);
    const exceptions = await parseExceptions(settings.serializedExceptions);
    await replaceAllTexts(mapping, exceptions);
}

async function parseDictionary(serializedDictionary) {
    const table = escape(serializedDictionary).split('%0A').map(line => line.split('%09').map(field => unescape(field.trim())));
    if (table.length < 2) {
        throw 'empty dictionary';
    }
    const header = table[0];
    const expectedColumnCount = header.length;
    const rows = table.slice(1, table.length);
    console.log('Dictionary:', {header, rows});
    rows.forEach((row, index) => {
        if (row.length != expectedColumnCount) {
            throw 'row #' + (index + 2) + ' of the dictionary has ' + row.length + ' (not ' + expectedColumnCount + ') columns';
        }
    });
    return {header, rows};
}

async function getMapping(dictionary, sourceLanguage, targetLanguage) {
    const sourceColumnIndex = dictionary.header.indexOf(sourceLanguage);
    if (sourceColumnIndex == -1) {
        throw sourceLanguage + ' not listed in [' + dictionary.header + ']';
    }
    const targetColumnIndex = dictionary.header.indexOf(targetLanguage);
    if (targetColumnIndex == -1) {
        throw targetLanguage + ' not listed in [' + dictionary.header + ']';
    }
    const result = {};
    dictionary.rows.forEach(row => {
        const sourceString = row[sourceColumnIndex];
        const targetString = row[targetColumnIndex];
        if (targetString.trim() === '') {
            throw 'no translation for `' + sourceString + '` in the dictionary';
        }
        result[sourceString] = targetString;
    });
    console.log('Extracted mapping:', result);
    return result;
}

async function parseExceptions(serializedExceptions) {
    return serializedExceptions.split('\n').filter(pattern => pattern !== '').map(pattern => new RegExp(pattern));
}

async function replaceAllTexts(mapping, exceptions) {
    const textNodes = await findSelectedTextNodes();

    const replacements = await Promise.all(textNodes.map(node => computeReplacement(node, mapping, exceptions)));
    const failures = replacements.filter(r => r !== null && 'error' in r);
    if (failures.length > 0) {
        figma.viewport.scrollAndZoomIntoView([failures[0].node]);
        console.log('Failures:', failures);
        throw 'found some untranslatable nodes (see console)';
    }

    await Promise.all(replacements.filter(r => r !== null).map(replaceText));
}

async function findSelectedTextNodes() {
    const result = [];
    figma.currentPage.selection.forEach(root => {
        if (root.type === 'TEXT') {
            result.push(root as TextNode);
        } else if ('findAll' in root) {
            (root as ChildrenMixin).findAll(node => node.type === 'TEXT').forEach(node => result.push(node as TextNode));
        }
    });
    return result;
}

async function computeReplacement(node, mapping, exceptions) {
    const content = normalizeContent(node.characters);
    if (keepAsIs(content, exceptions)) {
        return null;
    }

    if (!(content in mapping)) {
        return {node, error: 'no translation', content};
    }

    console.log('Computing replacement for `' + content + '`');

    const sections = sliceIntoSections(node);
    console.log('Sections:', sections);

    const styles = [];
    const styleIds = new Set();
    sections.forEach(({style}) => {
        if (!styleIds.has(style.id)) {
            styleIds.add(style.id);
            styles.push(style);
        }
    });

    const result = {
        node,
        translation: mapping[content],
        baseStyle: null,
        modifiers: [],
    };

    for (let baseStyleCandidate of styles) {
        console.log('Base style candidate:', baseStyleCandidate);
        let ok = true;
        result.modifiers.length = 0;
        for (let {from, to, style} of sections) {
            if (style.id === baseStyleCandidate.id) {
                console.log('Section `' + node.characters.slice(from, to) + '` has the base style: ignore');
                continue;
            }
            const sectionContent = normalizeContent(node.characters.slice(from, to));
            console.log('Section `' + sectionContent + '` has a non-base style: needs translation');
            if (!(sectionContent in mapping)) {
                console.log('No translation found for the section: skipping the base style candidate');
                ok = false;
                break;
            }
            const sectionTranslation = mapping[sectionContent];
            const index = result.translation.indexOf(sectionTranslation);
            if (index == -1) {
                console.log('Cannot find `' + sectionTranslation + '` within `' + result.translation + '`: skipping the base style candidate');
                ok = false;
                break;
            }
            if (result.translation.indexOf(sectionTranslation, index + 1) != -1) {
                console.log('Found multiple occurrencies of `' + sectionTranslation + '` within `' + result.translation + '`: skipping the base style candidate');
                ok = false;
                break;
            }
            console.log('Translated the section');
            result.modifiers.push({from: index, to: index + sectionTranslation.length, style});
        }
        if (ok) {
            result.baseStyle = baseStyleCandidate;
            break;
        }
    }
    if (result.baseStyle === null) {
        console.log('Failed to determine a base style for `' + content + '`');
        return {node, error: 'failed to determine a base style', content};
    }

    console.log('Replacement:', result);

    return result;
}

function normalizeContent(string) {
    return string.replace(/[\u000A\u202F\u00A0]/g, ' ').replace(/ +/g, ' ');
}

function keepAsIs(string, exceptions) {
    for (let regex of exceptions) {
        if (string.match(regex)) {
            return true;
        }
    }
    return false;
};

function sliceIntoSections(node: TextNode, from: number = 0, to: number = node.characters.length) {
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

async function replaceText(replacement) {
    const {node, translation, baseStyle, modifiers} = replacement;
    await figma.loadFontAsync(baseStyle.fontName);
    await Promise.all(modifiers.map(({style}) => figma.loadFontAsync(style.fontName)));
    node.characters = translation;
    if (modifiers.length > 0) {
        setSectionStyle(node, 0, translation.length, baseStyle);
        for (let {from, to, style} of modifiers) {
            setSectionStyle(node, from, to, style);
        }
    }
}

function getSectionStyle(node: TextNode, from, to) {
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

function setSectionStyle(node: TextNode, from, to, style) {
    node.setRangeFills(from, to, style.fills);
    node.setRangeFillStyleId(from, to, style.fillStyleId);
    node.setRangeFontName(from, to, style.fontName);
    node.setRangeFontSize(from, to, style.fontSize);
    node.setRangeLetterSpacing(from, to, style.letterSpacing);
    node.setRangeLineHeight(from, to, style.lineHeight);
    node.setRangeTextDecoration(from, to, style.textDecoration);
    node.setRangeTextStyleId(from, to, style.textStyleId);
}


figma.showUI(__html__, {width: 400, height: 300});

figma.ui.onmessage = async message => {
    if (message.type === 'load-settings') {
        const settings = await loadSettings();
        console.log('Loaded settings:', settings);
        const response = {
            type: 'settings',
            settings,
        };
        figma.ui.postMessage(response);
        return;
    }

    if (message.type === 'translate-selection') {
        const promises = Object.keys(message.settings).map(field => figma.clientStorage.setAsync('StaticLocalizer.' + field, message.settings[field]));
        await Promise.all(promises);
        await translateSelection(message.settings)
            .then(() => {
                figma.notify('Successfully localized selected components');
            })
            .catch(reason => {
                figma.notify('Localization failed: ' + reason, {timeout: 10000});
            });
    }

    figma.closePlugin();
};
