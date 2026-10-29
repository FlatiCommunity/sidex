# Display languages and translation maintenance

SideX includes English and a complete Russian catalog. Both work without a Marketplace connection. Russian is selected automatically when the system language is Russian, or explicitly through **Configure Display Language** in the command palette. Choosing English stores an explicit preference; a Russian system locale does not override it on the next launch.

Other VS Code language packs can be installed from the configured extension gallery or from a VSIX. SideX discovers packs through `contributes.localizations`, including packs from third-party publishers, and reads the `vscode` translation contribution from the extension's actual installation directory. Portable installations, custom extension directories, versioned folders, regional locales, and Chinese script aliases are supported. Language selection takes effect after reload and is passed to the native menus and extension host.

## Coverage and fallbacks

The Russian catalog contains every static `localize` and `localize2` message in the checked-in VS Code and SideX source. It also includes Russian manifest translations for all bundled VS Code extensions. SideX's additional UI, including its settings, chat, orchestration view, native menus, and Git commands, uses this same localization pipeline. User text, model output, source code, command identifiers, model identifiers, and product or programming-language names retain their original spelling.

An installed language pack supplies the messages it actually contains. Missing SideX-specific messages fall back individually to English. Existing supplementary Chinese, Japanese, and Korean translations cover some SideX messages and are applied only together with an installed pack; they are not advertised as complete bundled languages. The runtime exposes actual per-message counts as `globalThis._SIDEX_NLS_COVERAGE` for diagnostics. English source fallback is not counted as translated coverage.

Damaged JSON, missing packs, and translations with incompatible positional parameters do not block startup. Keys are scoped by source module, so identical keys from different modules cannot overwrite one another. A translated `{10}` remains the eleventh argument rather than being confused with `{1}`. Language loading performs local file and application-resource reads only; it does not fetch a pack from the Marketplace during startup.

## Translation sources

`locales/sources.json` pins the official Microsoft [vscode-loc](https://github.com/microsoft/vscode-loc) revisions. The primary catalog is the VS Code 1.110 generation, matching SideX's supported extension API and bundled assets; a pinned newer catalog supplies missing compatible keys. Both retain Microsoft's MIT license in `locales/LICENSE.vscode-loc.txt`. SideX-specific translations and reviewed corrections live in `locales/ru-overrides.json` and take precedence during generation.

`public/locales/ru.json` is generated and checked in, so builds do not depend on network access. `public/locales/ru/extensions/` contains the original-format built-in extension translation bundles; `public/extensions/*/package.nls.ru.json` supplies their manifest text. `src/localization/builtinTranslations.ts` records the corresponding available extension identifiers.

## Updating translations

When adding a user-facing string, use a static NLS key and an English source message. Supply changing values with positional parameters instead of constructing sentence fragments. Add its Russian translation to the matching module in `locales/ru-overrides.json`. Translate setting labels, while retaining the existing stored option values.

Generate and validate the catalog:

```sh
node scripts/generate-locales.mjs
node scripts/validate-localization.mjs
node scripts/tests/localization.test.mjs
```

The generation command downloads only the pinned source catalogs. To work offline, place the filenames listed in `locales/sources.json` in a directory and pass `--source-dir /path/to/catalogs`. Refreshing the bundled extension catalogs is a separate explicit operation:

```sh
node scripts/generate-locales.mjs --update-extensions
```

After a production build, validate the exact emitted message index with:

```sh
node scripts/validate-localization.mjs --dist
```

Validation rejects missing Russian keys, incompatible placeholders, conflicting uses of one module/key pair, and untranslated English sentences. Neutral names and pure formatting patterns are recorded explicitly. A contextual TypeScript audit also checks SideX and Git UI literals; narrowly reviewed exceptions, with reasons, are kept in `locales/ui-literal-allowlist.json`. This check complements the full NLS catalog check and does not claim to analyze arbitrary dynamically generated text or text supplied by external extensions.
