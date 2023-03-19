type Settings = {
  serializedDictionary: string;
  serializedExceptions: string;
  sourceLanguage: string;
  imageExtensionIsJPG: boolean;
};

namespace SettingsManager {
  const DEFAULT: Settings = {
    serializedDictionary: "RU\tEN\tES\nПривет!\tHello!\tHola!\nПока!\tBye!\tHasta luego!\nкласс\tclass\tclasse",
    serializedExceptions: "",
    sourceLanguage: "RU",
    imageExtensionIsJPG: false,
  };
  const FIELDS = Object.keys(DEFAULT);
  const CLIENT_STORAGE_PREFIX = "StaticLocalizer.";

  export async function load(): Promise<Settings> {
    const result = <Settings>{};
    const promises = FIELDS.map((field) =>
      figma.clientStorage
        .getAsync(CLIENT_STORAGE_PREFIX + field)
        .then((value) => ({ field, value: value === undefined ? DEFAULT[field] : value }))
    );
    (await Promise.all(promises)).forEach(({ field, value }) => {
      result[field] = value;
    });
    return result;
  }

  export async function save(settings: Settings): Promise<void> {
    await Promise.all(
      FIELDS.map((field) => figma.clientStorage.setAsync(CLIENT_STORAGE_PREFIX + field, settings[field]))
    );
  }
}

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

type Translations = {
  sourceLanguage: string;
  targetLanguage: string;
  mapping: Mapping;
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

let content = [];

async function translateSelectionAndSave(settings: Settings): Promise<void> {
  content = [];
  const dictionary = await parseDictionary(settings.serializedDictionary, settings.sourceLanguage);
  const mappings = await getTranslations(dictionary, settings.sourceLanguage);
  const exceptions = await parseExceptions(settings.serializedExceptions);
  await replaceAllTextsAndSave(mappings, exceptions, settings.imageExtensionIsJPG);
}

async function parseDictionary(serializedDictionary: string, sourceLanguage: string): Promise<Dictionary> {
  const table = serializedDictionary.split("\n").map((line) => line.split("\t").map((field) => field.trim()));
  if (table.length === 0) {
    throw { error: "no header in the dictionary" };
  }
  const unshiftSelectedItem = (strings: string[], idx: number): string[] => {
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
        error:
          "row " + (index + 2) + " of the dictionary has " + row.length + " (not " + expectedColumnCount + ") columns",
      };
    }
  });
  return { header, rows };
}

async function getTranslations(dictionary: Dictionary, sourceLanguage: string): Promise<Translations[]> {
  let sourceColumnIndex = dictionary.header.indexOf(sourceLanguage);
  if (sourceColumnIndex == -1) {
    throw { error: sourceLanguage + " not listed in [" + dictionary.header + "]" };
  }

  const result = dictionary.header.map((language, languageIdx) => {
    const _mapping: Mapping = {};
    const translation: Translations = {
      sourceLanguage: language,
      targetLanguage: dictionary.header[(languageIdx + 1) % dictionary.header.length],
      mapping: _mapping,
    };
    dictionary.rows.forEach((row, idx) => {
      const sourceWord: string = row[languageIdx];
      const targetWord: string = row[(languageIdx + 1) % dictionary.header.length];
      _mapping[sourceWord] = targetWord;
    });
    return translation;
  });

  return result;
}

async function parseExceptions(serializedExceptions: string): Promise<RegExp[]> {
  return serializedExceptions
    .split("\n")
    .filter((pattern) => pattern !== "")
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch (_) {
        throw { error: "invalid regular expression `" + pattern + "`" };
      }
    });
}

async function replaceAllTextsAndSave(
  mappings: Translations[],
  exceptions: RegExp[],
  imageExtensionIsJPG: boolean
): Promise<void> {
  const textNodes = await findSelectedTextNodes();

  for (const mapping of mappings) {
    let replacements = (
      await mapWithRateLimit(textNodes, 20, (node) => computeReplacement(node, mapping.mapping, exceptions))
    ).filter((r) => r !== null);
    let failures = replacements.filter((r) => "error" in r) as ReplacementFailure[];
    if (failures.length > 0) {
      console.log("Failures:", failures);
      throw { error: "found some untranslatable nodes", failures };
    }
    const selected = figma.currentPage.selection;
    Promise.all(
      selected.map(async (node, index) => {
        let bytesMainImage = await node.exportAsync({ format: imageExtensionIsJPG ? "JPG" : "PNG" });
        let name = node.name;
        let lang = mapping.sourceLanguage;
        let imageExtension = imageExtensionIsJPG ? "JPG" : "PNG";
        content.push({ bytesMainImage, lang, name, imageExtension });
        if (!content) {
          return;
        }
      })
    );
    await mapWithRateLimit(replacements, 250, replaceText);
  }
}

async function computeReplacement(node: TextNode, mapping: Mapping, exceptions: RegExp[]): Promise<ReplacementAttempt> {
  const content = normalizeContent(node.characters);
  if (keepAsIs(content, exceptions)) {
    return null;
  }
  const sections = sliceIntoSections(node);
  const suggestions = suggest(node, content, sections, mapping, exceptions);

  if (!(content in mapping)) {
    return { nodeId: node.id, error: "No translation for `" + content + "`", suggestions };
  }

  const result: Replacement = {
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
  const styleIds = new Set<string>();
  sections.forEach(({ from, to, style }) => {
    if (!styleIds.has(style.id)) {
      styleIds.add(style.id);
      styles.push({ humanId: from + "-" + to, ...style });
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
      } else if (!keepAsIs(sectionContent, exceptions)) {
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
        errorLog.push(
          prelude + "found multiple occurrencies of `" + sectionTranslation + "` within `" + result.translation + "`"
        );
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

  return result;
}

function normalizeContent(content: string): string {
  return content.replace(/[\u000A\u00A0\u2028\u202F]/g, " ").replace(/ +/g, " ");
}

function keepAsIs(content: string, exceptions: RegExp[]): boolean {
  for (let regex of exceptions) {
    if (content.match(regex)) {
      return true;
    }
  }
  return false;
}

function suggest(
  node: TextNode,
  content: string,
  sections: Section[],
  mapping: Mapping,
  exceptions: RegExp[]
): string[] {
  const n = content.length;
  const styleScores = new Map<string, number>();
  for (let { from, to, style } of sections) {
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


async function replaceText(replacement: Replacement): Promise<void> {
  await loadFontsForReplacement(replacement);

  const { node, translation, baseStyle, sections } = replacement;
  node.characters = translation;
  if (sections.length > 0) {
    setSectionStyle(node, 0, translation.length, baseStyle);
    for (let { from, to, style } of sections) {
      setSectionStyle(node, from, to, style);
    }
  }
}

async function loadFontsForReplacement(replacement: Replacement): Promise<void> {
  await figma.loadFontAsync(replacement.baseStyle.fontName);
  await Promise.all(replacement.sections.map(({ style }) => figma.loadFontAsync(style.fontName)));
}

// Font substitution

async function sendAvailableFonts() {
  const availableFonts = (await figma.listAvailableFontsAsync()).map((f) => f.fontName);
  figma.ui.postMessage({ type: "available-fonts", availableFonts });
}

async function sendSelectionFonts() {
  const textNodes = await findSelectedTextNodes();
  const selectionFontIds = new Set();
  const selectionFonts = [];
  await mapWithRateLimit(textNodes, 250, async (node) => {
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
  });
  figma.ui.postMessage({ type: "selection-fonts", selectionFonts });
}

// Utilities
async function findSelectedTextNodes(): Promise<TextNode[]> {
  const result: TextNode[] = [];

  figma.currentPage.selection.forEach((root) => {
    if (root.type === "TEXT") {
      result.push(root as TextNode);
    } else if ("findAll" in root) {
      (root as ChildrenMixin).findAll((node) => node.type === "TEXT").forEach((node) => result.push(node as TextNode));
    }
  });
  return result;
}

function sliceIntoSections(node: TextNode, from: number = 0, to: number = node.characters.length): Section[] {
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

function getSectionStyle(node: TextNode, from: number, to: number): Style | PluginAPI["mixed"] {
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
      } else {
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
figma.ui.onmessage = async (message) => {
  if (message.type === "load-settings") {
    const settings = await SettingsManager.load();
    figma.ui.postMessage({ type: "settings", settings });
    figma.ui.postMessage({ type: "ready" });
  } else if (message.type === "translate-and-save") {
    await translateSelectionAndSave(message.settings)
      .then(async () => {
        figma.ui.postMessage({ type: "content", content });
        figma.ui.postMessage({ type: "translation-failures", failures: [] });
        figma.ui.postMessage({ type: "ready" });
        figma.notify("Done");
      })
      .catch((reason) => {
        if ("error" in reason) {
          figma.notify("Translation failed: " + reason.error);
          if ("failures" in reason) {
            figma.ui.postMessage({ type: "translation-failures", failures: reason.failures });
          }
        } else {
          figma.notify(reason.toString());
        }
        figma.ui.postMessage({ type: "ready" });
      });
  }
};
