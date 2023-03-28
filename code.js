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
        serializedDictionary: "",
        sourceLanguage: "en-US",
        imageExtensionIsJPG: false,
    };
    const FIELDS = Object.keys(DEFAULT);
    function load() {
        return __awaiter(this, void 0, void 0, function* () {
            const result = {};
            const promises = FIELDS.map((field) => figma.clientStorage
                .getAsync(field)
                .then((value) => ({ field, value: value === undefined ? DEFAULT[field] : value })));
            (yield Promise.all(promises)).forEach(({ field, value }) => {
                result[field] = value;
            });
            return result;
        });
    }
    SettingsManager.load = load;
})(SettingsManager || (SettingsManager = {}));
let content = [];
let contentToSave = [];
function translateSelectionAndSave(settings) {
    return __awaiter(this, void 0, void 0, function* () {
        content = [];
        const dictionary = yield parseDictionary(settings.serializedDictionary, settings.sourceLanguage);
        const mappings = yield getTranslations(dictionary, settings.sourceLanguage);
        yield replaceAllTextsAndSave(mappings, settings.imageExtensionIsJPG);
    });
}
function translateSelectionAndCopy(settings) {
    return __awaiter(this, void 0, void 0, function* () {
        const dictionary = yield parseDictionary(settings.serializedDictionary, settings.sourceLanguage);
        const mappings = yield getTranslations(dictionary, settings.sourceLanguage);
        yield cloneAllTexts(mappings);
    });
}
function SaveSelectedToBuffer(imageExtensionIsJPG) {
    return __awaiter(this, void 0, void 0, function* () {
        contentToSave = [];
        const selected = figma.currentPage.selection;
        yield Promise.all(selected.map((node) => __awaiter(this, void 0, void 0, function* () {
            const [, lang, nodeName] = node.name.match(/^([^_]*)_(.*)/);
            let bytesMainImage = yield node.exportAsync({ format: imageExtensionIsJPG ? "JPG" : "PNG" });
            let language = lang;
            let name = nodeName;
            let imageExtension = imageExtensionIsJPG ? "JPG" : "PNG";
            contentToSave.push({ bytesMainImage, name, imageExtension, language });
        })));
    });
}
function parseDictionary(serializedDictionary, sourceLanguage) {
    return __awaiter(this, void 0, void 0, function* () {
        const table = serializedDictionary.split("\n").map((line) => line.split("\t").map((field) => field.trim()));
        if (table.length === 0) {
            throw { error: "no header in the dictionary" };
        }
        const unshiftSelectedItem = (strings, idx) => {
            const sourceItem = strings.splice(idx, 1)[0];
            const updatedStrings = [sourceItem, ...strings];
            return updatedStrings;
        };
        const sourceColumnIndex = table[0].indexOf(sourceLanguage);
        const header = unshiftSelectedItem(table[0], sourceColumnIndex);
        const expectedColumnCount = header.length;
        const rows = table.slice(1, table.length).map((row) => unshiftSelectedItem(row, sourceColumnIndex));
        rows.forEach((row, index) => {
            if (row.length != expectedColumnCount) {
                throw {
                    error: "row " + (index + 2) + " of the dictionary has " + row.length + " (not " + expectedColumnCount + ") columns",
                };
            }
        });
        return { header, rows };
    });
}
function getTranslations(dictionary, sourceLanguage) {
    return __awaiter(this, void 0, void 0, function* () {
        let sourceColumnIndex = dictionary.header.indexOf(sourceLanguage);
        if (sourceColumnIndex == -1) {
            throw { error: sourceLanguage + " not listed in [" + dictionary.header + "]" };
        }
        const result = dictionary.header.map((language, languageIdx) => {
            const _mapping = {};
            const translation = {
                sourceLanguage: language,
                targetLanguage: dictionary.header[(languageIdx + 1) % dictionary.header.length],
                mapping: _mapping,
            };
            dictionary.rows.forEach((row, idx) => {
                const sourceWord = row[languageIdx];
                const targetWord = row[(languageIdx + 1) % dictionary.header.length];
                _mapping[sourceWord] = targetWord;
            });
            return translation;
        });
        return result;
    });
}
function replaceAllTextsAndSave(mappings, imageExtensionIsJPG) {
    return __awaiter(this, void 0, void 0, function* () {
        const textNodes = yield findSelectedTextNodes();
        figma.ui.postMessage({ type: 'start-to-translate' });
        for (const mapping of mappings) {
            const currentLanguage = mapping.sourceLanguage;
            figma.ui.postMessage({ type: 'current-lang', currentLanguage });
            let replacements = (yield mapWithRateLimit(textNodes, 20, (node) => computeReplacement(node, mapping.mapping))).filter((r) => r !== null);
            const selected = figma.currentPage.selection;
            Promise.all(selected.map((node, index) => __awaiter(this, void 0, void 0, function* () {
                let bytesMainImage = yield node.exportAsync({ format: imageExtensionIsJPG ? "JPG" : "PNG" });
                let name = node.name;
                let lang = mapping.sourceLanguage;
                let imageExtension = imageExtensionIsJPG ? "JPG" : "PNG";
                content.push({ bytesMainImage, lang, name, imageExtension });
                if (!content) {
                    return;
                }
            })));
            yield mapWithRateLimit(replacements, 250, replaceText);
        }
    });
}
function cloneAllTexts(mappings) {
    return __awaiter(this, void 0, void 0, function* () {
        const textNodes = yield findSelectedTextNodes();
        const selected = figma.currentPage.selection;
        let minX = +Infinity;
        let maxX = -Infinity;
        let minY = +Infinity;
        let maxY = -Infinity;
        selected.forEach((node) => {
            if (node.x < minX) {
                minX = node.x;
            }
            if (node.x + node.width > maxX) {
                maxX = node.x + node.width;
            }
            if (node.y < minY) {
                minY = node.y;
            }
            if (node.y + node.height > maxY) {
                maxY = node.y + node.height;
            }
        });
        const selectionHeight = maxY - minY;
        const selectionWidth = maxX - minX;
        const offsetY = Math.floor(selectionHeight / 8);
        const offsetX = Math.floor(selectionWidth / 8);
        const squareSidesSize = Math.ceil(Math.sqrt(mappings.length));
        for (const [idx, mapping] of mappings.entries()) {
            let replacements = yield mapWithRateLimit(textNodes, 20, (node) => computeReplacement(node, mapping.mapping));
            const i = Math.floor(idx / squareSidesSize);
            const j = idx % squareSidesSize;
            const xTransition = (selectionWidth + offsetX) * (1 + j);
            const yTransition = (selectionHeight + offsetY) * i;
            selected.forEach((node) => {
                let originalInstanceNode = node;
                let instanceNodeCopy = originalInstanceNode.clone();
                instanceNodeCopy.x = Math.floor(originalInstanceNode.x + xTransition);
                instanceNodeCopy.y = Math.floor(originalInstanceNode.y + yTransition);
                instanceNodeCopy.name = `${mapping.sourceLanguage}_${originalInstanceNode.name}`;
            });
            yield mapWithRateLimit(replacements, 250, replaceText);
        }
    });
}
function computeReplacement(node, mapping) {
    return __awaiter(this, void 0, void 0, function* () {
        const content = normalizeContent(node.characters);
        const sections = sliceIntoSections(node);
        const result = {
            node,
            translation: !(content in mapping) ? content : mapping[content],
            baseStyle: null,
            sections: [],
        };
        const errorLog = [
            "Cannot determine a base style for `" + content + "`",
            "Split into " + sections.length + " sections",
        ];
        const styles = [];
        const styleIds = new Set();
        sections.forEach(({ from, to, style }) => {
            if (!styleIds.has(style.id)) {
                styleIds.add(style.id);
                styles.push(Object.assign({ humanId: from + "-" + to }, style));
            }
        });
        for (let baseStyleCandidate of styles) {
            const prelude = "Style " + baseStyleCandidate.humanId + " is not base: ";
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
                const index = result.translation.indexOf(sectionTranslation);
                if (index == -1) {
                    errorLog.push(prelude + "`" + sectionTranslation + "` not found within `" + result.translation + "`");
                    ok = false;
                    break;
                }
                if (result.translation.indexOf(sectionTranslation, index + 1) != -1) {
                    errorLog.push(prelude + "found multiple occurrencies of `" + sectionTranslation + "` within `" + result.translation + "`");
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
        return result;
    });
}
function normalizeContent(content) {
    return content.replace(/[\u000A\u00A0\u2028\u202F]/g, " ").replace(/ +/g, " ");
}
function replaceText(replacement) {
    return __awaiter(this, void 0, void 0, function* () {
        yield loadFontsForReplacement(replacement);
        const { node, translation, baseStyle, sections } = replacement;
        node.characters = translation;
        if (sections.length > 0) {
            setSectionStyle(node, 0, translation.length, baseStyle);
            for (let { from, to, style } of sections) {
                setSectionStyle(node, from, to, style);
            }
        }
    });
}
function loadFontsForReplacement(replacement) {
    return __awaiter(this, void 0, void 0, function* () {
        yield figma.loadFontAsync(replacement.baseStyle.fontName);
        yield Promise.all(replacement.sections.map(({ style }) => figma.loadFontAsync(style.fontName)));
    });
}
// Font substitution
function sendAvailableFonts() {
    return __awaiter(this, void 0, void 0, function* () {
        const availableFonts = (yield figma.listAvailableFontsAsync()).map((f) => f.fontName);
        figma.ui.postMessage({ type: "available-fonts", availableFonts });
    });
}
function sendSelectionFonts() {
    return __awaiter(this, void 0, void 0, function* () {
        const textNodes = yield findSelectedTextNodes();
        const selectionFontIds = new Set();
        const selectionFonts = [];
        yield mapWithRateLimit(textNodes, 250, (node) => __awaiter(this, void 0, void 0, function* () {
            if (node.characters === "") {
                return;
            }
            const sections = sliceIntoSections(node);
            for (let { style } of sections) {
                const fontId = JSON.stringify(style.fontName);
                if (!selectionFontIds.has(fontId)) {
                    selectionFontIds.add(fontId);
                    selectionFonts.push(style.fontName);
                }
            }
        }));
        figma.ui.postMessage({ type: "selection-fonts", selectionFonts });
    });
}
// Utilities
function findSelectedTextNodes() {
    return __awaiter(this, void 0, void 0, function* () {
        const result = [];
        figma.currentPage.selection.forEach((root) => {
            if (root.type === "TEXT") {
                result.push(root);
            }
            else if ("findAll" in root) {
                root.findAll((node) => node.type === "TEXT").forEach((node) => result.push(node));
            }
        });
        return result;
    });
}
function sliceIntoSections(node, from = 0, to = node.characters.length) {
    if (to === from) {
        return [];
    }
    const style = getSectionStyle(node, from, to);
    if (style !== figma.mixed) {
        return [{ from, to, style }];
    }
    if (to - from === 1) {
        console.log("WARNING! Unexpected problem at node `" + node.characters + '`: a single character has "mixed" style');
        return []; // TODO: fix the problem
    }
    const center = Math.floor((from + to) / 2);
    const leftSections = sliceIntoSections(node, from, center);
    if (leftSections.length === 0) {
        return []; // TODO: fix the problem
    }
    const rightSections = sliceIntoSections(node, center, to);
    if (rightSections.length === 0) {
        return []; // TODO: fix the problem
    }
    const lastLeftSection = leftSections[leftSections.length - 1];
    const firstRightSection = rightSections[0];
    if (lastLeftSection.style.id === firstRightSection.style.id) {
        firstRightSection.from = lastLeftSection.from;
        leftSections.pop();
    }
    return leftSections.concat(rightSections);
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
    node.setRangeTextStyleId(from, to, style.textStyleId);
    node.setRangeFills(from, to, style.fills);
    node.setRangeFillStyleId(from, to, style.fillStyleId);
    node.setRangeFontName(from, to, style.fontName);
    node.setRangeFontSize(from, to, style.fontSize);
    node.setRangeLetterSpacing(from, to, style.letterSpacing);
    node.setRangeLineHeight(from, to, style.lineHeight);
    node.setRangeTextDecoration(from, to, style.textDecoration);
}
function mapWithRateLimit(array, rateLimit, mapper) {
    return new Promise((resolve, reject) => {
        const result = new Array(array.length);
        let index = 0;
        let done = 0;
        var startTime = Date.now();
        const computeDelay = () => startTime + (index * 1000.0) / rateLimit - Date.now();
        const schedule = () => {
            while (index < array.length && computeDelay() < 0) {
                ((i) => {
                    mapper(array[i]).then((y) => {
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
    if (message.type === "load-settings") {
        const settings = yield SettingsManager.load();
        figma.ui.postMessage({ type: "settings", settings });
        figma.ui.postMessage({ type: "ready" });
    }
    else if (message.type === "translate-and-save") {
        yield translateSelectionAndSave(message.settings)
            .then(() => __awaiter(this, void 0, void 0, function* () {
            figma.ui.postMessage({ type: "content", content });
            figma.ui.postMessage({ type: "translation-failures", failures: [] });
            figma.ui.postMessage({ type: 'translation-ended' });
            figma.ui.postMessage({ type: "ready" });
            figma.notify("Done");
        }))
            .catch((reason) => {
            if ("error" in reason) {
                figma.notify("Translation failed: " + reason.error);
                if ("failures" in reason) {
                    figma.ui.postMessage({ type: "translation-failures", failures: reason.failures });
                }
            }
            else {
                figma.notify(reason.toString());
            }
            figma.ui.postMessage({ type: "ready" });
        });
    }
    else if (message.type === "copy") {
        yield translateSelectionAndCopy(message.settings)
            .then(() => __awaiter(this, void 0, void 0, function* () {
            figma.ui.postMessage({ type: "ready" });
            figma.notify("Done");
        }))
            .catch((reason) => {
            if ("error" in reason) {
                figma.notify("Translation failed: " + reason.error);
                if ("failures" in reason) {
                    figma.ui.postMessage({ type: "translation-failures", failures: reason.failures });
                }
            }
            else {
                figma.notify(reason.toString());
            }
            figma.ui.postMessage({ type: "ready" });
        });
    }
    else if ((message.type = "save-content")) {
        yield SaveSelectedToBuffer(message.settings.imageExtensionIsJPG).then(() => __awaiter(this, void 0, void 0, function* () {
            figma.ui.postMessage({ type: "content-to-save", contentToSave });
            figma.ui.postMessage({ type: "ready" });
            figma.notify("Done");
        }));
    }
});
