# Static Localizer

A simple plugin that allows you to translate texts using a static dictionary.

It gracefully handles mixed text formatting.

## Installation

To install the plugin locally, download this repo, then click

    Plugins > Development > Create new plugin

in Figma Desktop, and select the downloaded `manifest.json` file.

## Usage

- Select components to localize
- Invoke this plugin
- Specify a [dictionary](#Dictionary) explicitly or load it from a file
- Specify [exceptions](#Exceptions) explicitly or load them from a file
- Specify source and target language codes
- Hit `Translate`

The plugin will always remember the last used settings.

### Dictionary

Should be in a [TSV](https://en.wikipedia.org/wiki/Tab-separated_values) format.
The first row is a header containing language codes.
Each of the following rows contains translations of some phrase into corresponding languages.

For instance,
```
RU	EN	DE
Привет!	Hello!	Hallo!
день	day	Tag
```

### Exceptions

Define patterns to ignore during translation.
There should be one regular expression per line.

For instance,
```
^$
^-?[0-9. ]+%?$
```

## Troubleshooting

If localization fails, you will see the list of untranslatable nodes right in the UI.
For each untranslatable node we provide
- a hyperlink to it
- a short error description
- a translation log

## Development

Just follow this guide: https://www.figma.com/plugin-docs/setup/.

# License

**Static Localizer** is released under the MIT license.
