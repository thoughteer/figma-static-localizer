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
        serializedDictionary: "RU\tEN\tES\nПривет!\tHello!\tHola!\nПока!\tBye!\tHasta luego!\nкласс\tclass\tclasse",
        serializedExceptions: "",
        sourceLanguage: "RU",
        serializedFontSubstitutions: "[]",
    };
    const FIELDS = Object.keys(DEFAULT);
    const CLIENT_STORAGE_PREFIX = "StaticLocalizer.";
    function load() {
        return __awaiter(this, void 0, void 0, function* () {
            const result = {};
            const promises = FIELDS.map((field) => figma.clientStorage
                .getAsync(CLIENT_STORAGE_PREFIX + field)
                .then((value) => ({ field, value: value === undefined ? DEFAULT[field] : value })));
            (yield Promise.all(promises)).forEach(({ field, value }) => {
                result[field] = value;
            });
            return result;
        });
    }
    SettingsManager.load = load;
    function save(settings) {
        return __awaiter(this, void 0, void 0, function* () {
            yield Promise.all(FIELDS.map((field) => figma.clientStorage.setAsync(CLIENT_STORAGE_PREFIX + field, settings[field])));
        });
    }
    SettingsManager.save = save;
})(SettingsManager || (SettingsManager = {}));
function translateSelectionAndSave(settings) {
    return __awaiter(this, void 0, void 0, function* () {
        const dictionary = yield parseDictionary(settings.serializedDictionary, settings.sourceLanguage);
        const mappings = yield getTranslations(dictionary, settings.sourceLanguage);
        const exceptions = yield parseExceptions(settings.serializedExceptions);
        yield replaceAllTextsAndSave(mappings, exceptions);
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
        console.log("Dictionary:", { header, rows });
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
            console.log(translation);
            return translation;
        });
        console.log("Extracted mapping:", result);
        return result;
    });
}
function parseExceptions(serializedExceptions) {
    return __awaiter(this, void 0, void 0, function* () {
        return serializedExceptions
            .split("\n")
            .filter((pattern) => pattern !== "")
            .map((pattern) => {
            try {
                return new RegExp(pattern);
            }
            catch (_) {
                throw { error: "invalid regular expression `" + pattern + "`" };
            }
        });
    });
}
let content = [];
function replaceAllTextsAndSave(mappings, exceptions) {
    return __awaiter(this, void 0, void 0, function* () {
        const textNodes = yield findSelectedTextNodes();
        for (const mapping of mappings) {
            let replacements = (yield mapWithRateLimit(textNodes, 20, (node) => computeReplacement(node, mapping.mapping, exceptions))).filter((r) => r !== null);
            console.log(replacements);
            let failures = replacements.filter((r) => "error" in r);
            // если RTL
            // if (failures.length == 0) {
            //   replacements = await mapWithRateLimit(replacements, 100, reverseAndWrapReplacement);
            //   failures = replacements.filter((r) => "error" in r) as ReplacementFailure[];
            // }
            if (failures.length > 0) {
                console.log("Failures:", failures);
                throw { error: "found some untranslatable nodes", failures };
            }
            const selected = figma.currentPage.selection;
            console.log(selected);
            Promise.all(selected.map((node, index) => __awaiter(this, void 0, void 0, function* () {
                let bytesMainImage = yield node.exportAsync({ format: "PNG" });
                let name = node.name;
                let lang = mapping.sourceLanguage;
                content.push({ bytesMainImage, lang, name });
                if (!content) {
                    return;
                }
            })));
            yield mapWithRateLimit(replacements, 250, replaceText);
        }
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
            return { nodeId: node.id, error: "No translation for `" + content + "`", suggestions };
        }
        const result = {
            node,
            translation: mapping[content],
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
                else if (!keepAsIs(sectionContent, exceptions)) {
                    errorLog.push(prelude + "no translation for `" + sectionContent + "`");
                    ok = false;
                    break;
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
        if (result.baseStyle === null) {
            return { nodeId: node.id, error: errorLog.join(". "), suggestions };
        }
        console.log("Replacement:", result);
        return result;
    });
}
function normalizeContent(content) {
    return content.replace(/[\u000A\u00A0\u2028\u202F]/g, " ").replace(/ +/g, " ");
}
function keepAsIs(content, exceptions) {
    for (let regex of exceptions) {
        if (content.match(regex)) {
            return true;
        }
    }
    return false;
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
function reverseAndWrapReplacement(replacement) {
    return __awaiter(this, void 0, void 0, function* () {
        const reversedReplacement = yield reverseReplacement(replacement);
        if (replacement.node.textAutoResize === "WIDTH_AND_HEIGHT") {
            return reversedReplacement;
        }
        return wrapReplacement(reversedReplacement);
    });
}
function reverseReplacement(replacement) {
    return __awaiter(this, void 0, void 0, function* () {
        const { reversedText: reversedTranslation, nonReversibleRanges } = reverseText(replacement.translation);
        const n = replacement.translation.length;
        const reversedSections = replacement.sections.map(({ from, to, style }) => ({ from: n - to, to: n - from, style }));
        const overridingSections = [];
        for (let range of nonReversibleRanges) {
            overridingSections.push(Object.assign(Object.assign({}, range), { style: replacement.baseStyle }));
            for (let { from, to, style } of reversedSections) {
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
        // console.log("Reversed replacement:", result);
        return result;
    });
}
function reverseText(text) {
    // TODO: replace with a proper implementation for RTL languages
    const words = [];
    const nonReversibleWordStack = [];
    const nonReversibleRanges = [];
    const dumpNonReversibleWordStack = (to) => {
        if (nonReversibleWordStack.length > 0) {
            const phrase = nonReversibleWordStack.reverse().join(" ");
            words.push(phrase);
            nonReversibleRanges.push({ from: to - phrase.length, to });
            nonReversibleWordStack.length = 0;
        }
    };
    let offset = -1;
    for (let word of text.split(" ").reverse()) {
        if (isReversible(word)) {
            dumpNonReversibleWordStack(offset);
            words.push(reverseSpecialSymbols(word.split("").reverse().join("")));
        }
        else {
            nonReversibleWordStack.push(word);
        }
        offset += word.length + 1;
    }
    dumpNonReversibleWordStack(offset);
    return { reversedText: words.join(" "), nonReversibleRanges };
}
function isReversible(word) {
    return /[\u0500-\u0700]|^$/.test(word);
}
function reverseSpecialSymbols(word) {
    const reversalTable = new Map([
        ["(", ")"],
        [")", "("],
        ["[", "]"],
        ["]", "["],
        ["{", "}"],
        ["}", "{"],
    ]);
    return word
        .split("")
        .map((c) => reversalTable.get(c) || c)
        .join("");
}
function wrapReplacement(replacement) {
    return __awaiter(this, void 0, void 0, function* () {
        yield loadFontsForReplacement(replacement);
        const bufferNode = replacement.node.clone();
        bufferNode.opacity = 0;
        bufferNode.characters = "";
        bufferNode.textAutoResize = "HEIGHT";
        let wrappedTranslationLines = [];
        let wrappedSections = [];
        const words = replacement.translation.split(" ");
        let wordIndex = words.length - 1;
        let lineStart = replacement.translation.length;
        let lineEnd = lineStart;
        let currentLineOffset = 0;
        while (wordIndex >= 0) {
            let currentLine = "";
            let lineBreakStyle = replacement.baseStyle;
            while (wordIndex >= 0) {
                const word = words[wordIndex];
                const insertion = wordIndex > 0 ? " " + word : word;
                const originalBufferHeight = bufferNode.height;
                bufferNode.insertCharacters(currentLineOffset, insertion, "AFTER");
                lineStart -= insertion.length;
                for (let { from, to, style } of replacement.sections) {
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
                        return {
                            nodeId: replacement.node.id,
                            error: "Word `" + reverseText(insertion).reversedText + "` does not fit into the box",
                            suggestions: [],
                        };
                    }
                    const lineBreakOffset = currentLineOffset + currentLine.length;
                    bufferNode.insertCharacters(lineBreakOffset, "\u2028", "BEFORE");
                    for (let { from, to, style } of replacement.sections.reverse()) {
                        if (from <= lineStart - 1 && lineStart - 1 < to) {
                            lineBreakStyle = style;
                            break;
                        }
                    }
                    setSectionStyle(bufferNode, lineBreakOffset, lineBreakOffset + 1, lineBreakStyle);
                    break;
                }
                currentLine = insertion + currentLine;
                wordIndex--;
            }
            wrappedTranslationLines.push(currentLine);
            for (let { from, to, style } of replacement.sections) {
                if (from < lineEnd && to > lineStart) {
                    wrappedSections.push({
                        from: currentLineOffset + Math.max(0, from - lineStart),
                        to: currentLineOffset + Math.min(to, lineEnd) - lineStart,
                        style,
                    });
                }
            }
            if (wordIndex >= 0) {
                wrappedSections.push({
                    from: currentLineOffset + currentLine.length,
                    to: currentLineOffset + currentLine.length + 1,
                    style: lineBreakStyle,
                });
            }
            lineEnd = lineStart;
            currentLineOffset += currentLine.length + 1;
        }
        const result = {
            node: replacement.node,
            translation: wrappedTranslationLines.join("\u2028"),
            baseStyle: replacement.baseStyle,
            sections: wrappedSections,
        };
        bufferNode.remove();
        console.log("Wrapped replacement:", result);
        return result;
    });
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
function substituteFontsInSelection(settings) {
    return __awaiter(this, void 0, void 0, function* () {
        const substitutions = JSON.parse(settings.serializedFontSubstitutions);
        const fontMapping = new Map();
        for (let substitution of substitutions) {
            const sourceFontId = JSON.stringify(substitution.sourceFont);
            fontMapping.set(sourceFontId, substitution.targetFont);
            yield figma.loadFontAsync(substitution.targetFont);
        }
        const textNodes = yield findSelectedTextNodes();
        yield mapWithRateLimit(textNodes, 250, (node) => __awaiter(this, void 0, void 0, function* () {
            if (node.characters === "") {
                return;
            }
            const sections = sliceIntoSections(node);
            for (let { style } of sections) {
                yield figma.loadFontAsync(style.fontName);
            }
            for (let { from, to, style } of sections) {
                const fontId = JSON.stringify(style.fontName);
                if (fontMapping.has(fontId)) {
                    const newStyle = Object.assign({}, style);
                    newStyle.fontName = fontMapping.get(fontId);
                    setSectionStyle(node, from, to, newStyle);
                }
            }
        }));
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
        console.log(result);
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
        console.log("Loaded settings:", settings);
        figma.ui.postMessage({ type: "settings", settings });
        figma.ui.postMessage({ type: "ready" });
    }
    else if (message.type === "translate-and-save") {
        yield translateSelectionAndSave(message.settings)
            .then(() => __awaiter(this, void 0, void 0, function* () {
            figma.ui.postMessage({ type: "content", content });
            figma.ui.postMessage({ type: "translation-failures", failures: [] });
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
    else if (message.type === "substitute-fonts") {
        yield SettingsManager.save(message.settings);
        yield substituteFontsInSelection(message.settings)
            .then(() => sendSelectionFonts().then(() => {
            figma.notify("Done");
            figma.ui.postMessage({ type: "ready" });
        }))
            .catch((reason) => {
            if ("error" in reason) {
                figma.notify("Font substitution failed: " + reason.error);
            }
            else {
                figma.notify(reason.toString());
            }
            figma.ui.postMessage({ type: "ready" });
        });
    }
});
