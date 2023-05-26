# Localizer

A Figma plugin that allows you to localize your content using a static dictionary.

## Usage

The plugin includes several modules:

- [Translation](#translation)

Note that the plugin will always remember the last used settings.

### Translation

- Select nodes to translate
- Invoke this plugin
- Specify a [dictionary](#dictionary) explicitly or load it from a file
- Specify [exceptions](#exceptions) explicitly or load them from a file
- Specify source and target languages
- Choose what format of Image PNG or JPG (PNG is default)
- Hit `Translate`

#### Dictionary

Should be in the [TSV](https://en.wikipedia.org/wiki/Tab-separated_values) format.
The first row is a header containing language codes.
Each of the following rows contains translations of some phrase into corresponding languages.

For instance,

```
RU	EN	DE
Привет!	Hello!	Hallo!
день	day	Tag
```

#### Exceptions

Define patterns to ignore during translation.
There should be one regular expression per line.

For instance,

```
^$
^-?[0-9. ]+%?$
```

Here are some commonly used patterns:

| Pattern            | Description                     |
| ------------------ | ------------------------------- |
| `^$`               | an empty text                   |
| `^\s*$`            | whitespaces                     |
| `^[+-]?[0-9.,]+%?` | decimal numbers and percentages |
| `^Joom$`           | some brand name                 |

Also, check out this [tutorial on regular expressions](https://medium.com/factory-mind/regex-tutorial-a-simple-cheatsheet-by-examples-649dc1c3f285).

#### Troubleshooting

If translation fails, you will see the list of untranslatable nodes right in the UI.
For each untranslatable node you will get

- a hyperlink to it
- a full error description

The plugin will then also suggest a list of phrases that should be translated in order to complete the translation.

You might get a `... does not fit into the box` error while translating into an RTL language
if your font doesn't have the required symbols.
Try [font substitution](#font-substitution) in this case.

## Development

Just follow this guide: https://www.figma.com/plugin-docs/setup/.
