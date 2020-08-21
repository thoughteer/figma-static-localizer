var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var SettingsManager;
(function (SettingsManager) {
    const DEFAULT = {
        serializedDictionary: 'RU\tEN\nПривет!\tHello!',
        serializedExceptions: '',
        serializedCurrencies: '[\n\t{\n\t\t"code": "RUB",\n\t\t"schema": "123 \\u20bd",\n\t\t"digitGroupSeparator": " ",\n\t\t"decimalSeparator": "",\n\t\t"precision": 0,\n\t\t"rate": 1},\n\t{\n\t\t"code": "USD",\n\t\t"schema": "$123",\n\t\t"digitGroupSeparator": ",",\n\t\t"decimalSeparator": ".",\n\t\t"precision": 2,\n\t\t"rate": 0.013\n\t}\n]',
        sourceLanguage: 'RU',
        targetLanguage: 'EN',
        sourceCurrencyCode: 'RUB',
        targetCurrencyCode: 'USD',
    };
    const FIELDS = Object.keys(DEFAULT);
    const CLIENT_STORAGE_PREFIX = 'StaticLocalizer.';
    function load() {
        return __awaiter(this, void 0, void 0, function* () {
            const result = {};
            const promises = FIELDS.map(field => figma.clientStorage.getAsync(CLIENT_STORAGE_PREFIX + field).then(value => ({ field, value: value === undefined ? DEFAULT[field] : value })));
            (yield Promise.all(promises)).forEach(({ field, value }) => {
                result[field] = value;
            });
            return result;
        });
    }
    SettingsManager.load = load;
    function save(settings) {
        return __awaiter(this, void 0, void 0, function* () {
            yield Promise.all(FIELDS.map(field => figma.clientStorage.setAsync(CLIENT_STORAGE_PREFIX + field, settings[field])));
        });
    }
    SettingsManager.save = save;
})(SettingsManager || (SettingsManager = {}));
;
function translateSelection(settings) {
    return __awaiter(this, void 0, void 0, function* () {
        const dictionary = yield parseDictionary(settings.serializedDictionary);
        const mapping = yield getMapping(dictionary, settings.sourceLanguage, settings.targetLanguage);
        const exceptions = yield parseExceptions(settings.serializedExceptions);
        yield replaceAllTexts(mapping, exceptions);
    });
}
function parseDictionary(serializedDictionary) {
    return __awaiter(this, void 0, void 0, function* () {
        const table = encodeURI(serializedDictionary).split('%0A').map(line => line.split('%09').map(field => decodeURI(field.trim())));
        if (table.length === 0) {
            throw { error: 'no header in the dictionary' };
        }
        const header = table[0];
        const expectedColumnCount = header.length;
        const rows = table.slice(1, table.length);
        console.log('Dictionary:', { header, rows });
        rows.forEach((row, index) => {
            if (row.length != expectedColumnCount) {
                throw { error: 'row ' + (index + 2) + ' of the dictionary has ' + row.length + ' (not ' + expectedColumnCount + ') columns' };
            }
        });
        return { header, rows };
    });
}
function getMapping(dictionary, sourceLanguage, targetLanguage) {
    return __awaiter(this, void 0, void 0, function* () {
        const sourceColumnIndex = dictionary.header.indexOf(sourceLanguage);
        if (sourceColumnIndex == -1) {
            throw { error: sourceLanguage + ' not listed in [' + dictionary.header + ']' };
        }
        const targetColumnIndex = dictionary.header.indexOf(targetLanguage);
        if (targetColumnIndex == -1) {
            throw { error: targetLanguage + ' not listed in [' + dictionary.header + ']' };
        }
        const result = {};
        dictionary.rows.forEach(row => {
            const sourceString = row[sourceColumnIndex];
            const targetString = row[targetColumnIndex];
            if (targetString.trim() !== '') {
                result[sourceString] = targetString;
            }
        });
        console.log('Extracted mapping:', result);
        return result;
    });
}
function parseExceptions(serializedExceptions) {
    return __awaiter(this, void 0, void 0, function* () {
        return serializedExceptions.split('\n').filter(pattern => pattern !== '').map(pattern => {
            try {
                return new RegExp(pattern);
            }
            catch (_) {
                throw { error: 'invalid regular expression `' + pattern + '`' };
            }
        });
    });
}
function replaceAllTexts(mapping, exceptions) {
    return __awaiter(this, void 0, void 0, function* () {
        const textNodes = yield findSelectedTextNodes();
        const replacements = yield mapWithRateLimit(textNodes, 200, node => computeReplacement(node, mapping, exceptions));
        const failures = replacements.filter(r => r !== null && 'error' in r);
        if (failures.length > 0) {
            console.log('Failures:', failures);
            throw { error: 'found some untranslatable nodes', failures };
        }
        yield mapWithRateLimit(replacements.filter(r => r !== null), 50, replaceText);
    });
}
function computeReplacement(node, mapping, exceptions) {
    return __awaiter(this, void 0, void 0, function* () {
        const content = normalizeContent(node.characters);
        if (keepAsIs(content, exceptions)) {
            return null;
        }
        const sections = sliceIntoSections(node);
        const suggestions = suggest(node, content, sections, mapping, exceptions);
        if (!(content in mapping)) {
            return { nodeId: node.id, error: 'No translation for `' + content + '`', suggestions };
        }
        const errorLog = [
            'Cannot determine a base style for `' + content + '`',
            'Split into ' + sections.length + ' sections',
        ];
        const styles = [];
        const styleIds = new Set();
        sections.forEach(({ from, to, style }) => {
            if (!styleIds.has(style.id)) {
                styleIds.add(style.id);
                styles.push(Object.assign({ humanId: from + '-' + to }, style));
            }
        });
        const result = {
            node,
            translation: mapping[content],
            baseStyle: null,
            sections: [],
        };
        for (let baseStyleCandidate of styles) {
            const prelude = 'Style ' + baseStyleCandidate.humanId + ' is not base: ';
            let ok = true;
            result.sections.length = 0;
            for (let { from, to, style } of sections) {
                if (style.id === baseStyleCandidate.id) {
                    continue;
                }
                const sectionContent = normalizeContent(node.characters.slice(from, to));
                let sectionTranslation = sectionContent;
                if (sectionContent in mapping) {
                    sectionTranslation = mapping[sectionContent];
                }
                else if (!keepAsIs(sectionContent, exceptions)) {
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
                result.sections.push({ from: index, to: index + sectionTranslation.length, style });
            }
            if (ok) {
                result.baseStyle = baseStyleCandidate;
                break;
            }
        }
        if (result.baseStyle === null) {
            return { nodeId: node.id, error: errorLog.join('. '), suggestions };
        }
        console.log('Replacement:', result);
        return result;
    });
}
function normalizeContent(content) {
    return content.replace(/[\u000A\u2028\u202F\u00A0]/g, ' ').replace(/ +/g, ' ');
}
function keepAsIs(content, exceptions) {
    for (let regex of exceptions) {
        if (content.match(regex)) {
            return true;
        }
    }
    return false;
}
;
function sliceIntoSections(node, from = 0, to = node.characters.length) {
    const style = getSectionStyle(node, from, to);
    if (style !== figma.mixed) {
        return [{ from, to, style }];
    }
    const center = Math.floor((from + to) / 2);
    const leftSections = sliceIntoSections(node, from, center);
    const rightSections = sliceIntoSections(node, center, to);
    const lastLeftSection = leftSections[leftSections.length - 1];
    const firstRightSection = rightSections[0];
    if (lastLeftSection.style.id === firstRightSection.style.id) {
        firstRightSection.from = lastLeftSection.from;
        leftSections.pop();
    }
    return leftSections.concat(rightSections);
}
function suggest(node, content, sections, mapping, exceptions) {
    const n = content.length;
    const styleScores = new Map();
    for (let { from, to, style } of sections) {
        styleScores.set(style.id, n + to - from + (styleScores.get(style.id) || 0));
    }
    let suggestedBaseStyleId = null;
    let suggestedBaseStyleScore = 0;
    for (let [styleId, styleScore] of styleScores) {
        if (styleScore > suggestedBaseStyleScore) {
            suggestedBaseStyleId = styleId;
            suggestedBaseStyleScore = styleScore;
        }
    }
    const result = [];
    if (!(content in mapping)) {
        result.push(content);
    }
    for (let { from, to, style } of sections) {
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
function replaceText(replacement) {
    return __awaiter(this, void 0, void 0, function* () {
        const { node, translation, baseStyle, sections } = replacement;
        yield figma.loadFontAsync(baseStyle.fontName);
        yield Promise.all(sections.map(({ style }) => figma.loadFontAsync(style.fontName)));
        node.characters = translation;
        if (sections.length > 0) {
            setSectionStyle(node, 0, translation.length, baseStyle);
            for (let { from, to, style } of sections) {
                setSectionStyle(node, from, to, style);
            }
        }
    });
}
function convertCurrencyInSelection(settings) {
    return __awaiter(this, void 0, void 0, function* () {
        const currencies = parseCurrencies(settings.serializedCurrencies);
        console.log('Currencies:', currencies);
        const sourceCurrency = currencies.filter(currency => currency.code === settings.sourceCurrencyCode)[0];
        if (sourceCurrency === undefined) {
            throw { error: 'unknown currency code `' + settings.sourceCurrencyCode + '`' };
        }
        const targetCurrency = currencies.filter(currency => currency.code === settings.targetCurrencyCode)[0];
        if (targetCurrency === undefined) {
            throw { error: 'unknown currency code `' + settings.targetCurrencyCode + '`' };
        }
        yield replaceCurrencyInAllTexts(sourceCurrency, targetCurrency);
    });
}
function parseCurrencies(serializedCurrencies) {
    return JSON.parse(serializedCurrencies).map((x, index) => {
        const currency = {
            code: null,
            schema: null,
            digitGroupSeparator: null,
            decimalSeparator: null,
            precision: null,
            rate: null,
        };
        Object.keys(currency).forEach(key => {
            if (x[key] === undefined || x[key] === null) {
                throw { error: 'invalid currency definition: no `' + key + '` in entry #' + (index + 1) };
            }
            if (key === 'schema' && x[key].indexOf('123') === -1) {
                throw { error: 'schema in entry #' + (index + 1) + ' should contain `123`' };
            }
            if (key === 'rate' && x[key] <= 0) {
                throw { error: 'non-positive rate in entry #' + (index + 1) };
            }
            currency[key] = x[key];
        });
        if (currency.precision > 0 && currency.decimalSeparator === '') {
            throw { error: 'entry #' + (index + 1) + ' must have a non-empty decimal separator' };
        }
        return currency;
    });
}
function replaceCurrencyInAllTexts(sourceCurrency, targetCurrency) {
    return __awaiter(this, void 0, void 0, function* () {
        const textNodes = yield findSelectedTextNodes();
        const escapedSchema = escapeForRegExp(sourceCurrency.schema);
        const escapedDigitGroupSeparator = escapeForRegExp(sourceCurrency.digitGroupSeparator);
        const escapedDecimalSeparator = escapeForRegExp(sourceCurrency.decimalSeparator);
        const sourceValueRegExpString = '((?:[0-9]|' + escapedDigitGroupSeparator + ')+' + escapedDecimalSeparator + '[0-9]{' + sourceCurrency.precision + '})';
        const sourceRegExp = new RegExp('^' + escapedSchema.replace('123', sourceValueRegExpString) + '$');
        console.log('Source regular expression:', sourceRegExp.toString());
        yield Promise.all(textNodes.map((node) => __awaiter(this, void 0, void 0, function* () {
            const content = node.characters;
            const match = content.match(sourceRegExp);
            if (match !== null && match[1] !== null && match[1] !== undefined) {
                const style = getSectionStyle(node, 0, node.characters.length);
                if (style === figma.mixed) {
                    throw { error: 'node `' + content + '` has a mixed style' };
                }
                let sourceValueString = match[1].replace(new RegExp(escapedDigitGroupSeparator, 'g'), '');
                if (sourceCurrency.decimalSeparator !== '') {
                    sourceValueString = sourceValueString.replace(sourceCurrency.decimalSeparator, '.');
                }
                const sourceValue = parseFloat(sourceValueString);
                const targetValue = sourceValue * targetCurrency.rate / sourceCurrency.rate;
                const truncatedTargetValue = Math.trunc(targetValue);
                const targetValueFraction = targetValue - truncatedTargetValue;
                const targetValueString = (truncatedTargetValue.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,').replace(/,/g, targetCurrency.digitGroupSeparator) +
                    targetCurrency.decimalSeparator +
                    targetValueFraction.toFixed(targetCurrency.precision).slice(2));
                yield figma.loadFontAsync(style.fontName);
                node.characters = targetCurrency.schema.replace('123', targetValueString);
            }
        })));
    });
}
function escapeForRegExp(s) {
    return s.replace(/([[\^$.|?*+()])/g, '\\$1');
}
// Utilities
function findSelectedTextNodes() {
    return __awaiter(this, void 0, void 0, function* () {
        const result = [];
        figma.currentPage.selection.forEach(root => {
            if (root.type === 'TEXT') {
                result.push(root);
            }
            else if ('findAll' in root) {
                root.findAll(node => node.type === 'TEXT').forEach(node => result.push(node));
            }
        });
        return result;
    });
}
function getSectionStyle(node, from, to) {
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
    return Object.assign({ id: JSON.stringify(parameters) }, parameters);
}
function setSectionStyle(node, from, to, style) {
    node.setRangeFills(from, to, style.fills);
    node.setRangeFillStyleId(from, to, style.fillStyleId);
    node.setRangeFontName(from, to, style.fontName);
    node.setRangeFontSize(from, to, style.fontSize);
    node.setRangeLetterSpacing(from, to, style.letterSpacing);
    node.setRangeLineHeight(from, to, style.lineHeight);
    node.setRangeTextDecoration(from, to, style.textDecoration);
    node.setRangeTextStyleId(from, to, style.textStyleId);
}
function mapWithRateLimit(array, rateLimit, mapper) {
    return new Promise((resolve, reject) => {
        const result = new Array(array.length);
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
            }
            else {
                const delay = computeDelay();
                if (delay >= 0) {
                    setTimeout(schedule, delay);
                }
            }
        };
        schedule();
    });
}
figma.showUI(__html__, { width: 400, height: 400 });
figma.ui.onmessage = (message) => __awaiter(this, void 0, void 0, function* () {
    if (message.type === 'load-settings') {
        const settings = yield SettingsManager.load();
        console.log('Loaded settings:', settings);
        figma.ui.postMessage({ type: 'settings', settings });
        figma.ui.postMessage({ type: 'ready' });
    }
    else if (message.type === 'translate') {
        yield SettingsManager.save(message.settings);
        yield translateSelection(message.settings)
            .then(() => {
            figma.notify('Done');
            figma.closePlugin();
        })
            .catch(reason => {
            if ('error' in reason) {
                figma.notify('Localization failed: ' + reason.error);
                if ('failures' in reason) {
                    figma.ui.postMessage({ type: 'failures', failures: reason.failures });
                }
            }
            else {
                figma.notify(reason.toString());
            }
            figma.ui.postMessage({ type: 'ready' });
        });
    }
    else if (message.type === 'convert-currency') {
        yield SettingsManager.save(message.settings);
        yield convertCurrencyInSelection(message.settings)
            .then(() => {
            figma.notify('Done');
            figma.closePlugin();
        })
            .catch(reason => {
            if ('error' in reason) {
                figma.notify('Currency conversion failed: ' + reason.error);
            }
            else {
                figma.notify(reason.toString());
            }
            figma.ui.postMessage({ type: 'ready' });
        });
    }
    else if (message.type === 'focus-node') {
        figma.viewport.zoom = 1000.0;
        figma.viewport.scrollAndZoomIntoView([figma.getNodeById(message.id)]);
        figma.viewport.zoom = 0.75 * figma.viewport.zoom;
    }
});
