import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const assetsRoot = resolve(root, 'public/extensions');
export const assetLock = JSON.parse(readFileSync(resolve(root, 'scripts/builtin-extensions.lock.json'), 'utf8'));

export function parseJSONC(file) {
  const result = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  if (result.error) throw new Error(`Invalid JSON in ${file}: ${result.error.messageText}`);
  return result.config;
}

function containedFile(directory, path) {
  const file = resolve(directory, path);
  const rel = relative(assetsRoot, file);
  if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`Missing or out-of-bounds built-in resource: ${file}`);
  }
  return file;
}

export function validateBuiltinAssets() {
  for (const [path, expected] of Object.entries(assetLock.files)) {
    const actual = createHash('sha256').update(readFileSync(containedFile(assetsRoot, path))).digest('hex');
    if (actual !== expected) throw new Error(`Built-in resource differs from its pinned VS Code source: ${path}`);
  }
  const visited = new Set();
  function checkResource(file) {
    if (visited.has(file) || !file.endsWith('.json')) return;
    visited.add(file);
    const data = parseJSONC(file);
    for (const path of [data.include, typeof data.tokenColors === 'string' ? data.tokenColors : undefined]) {
      if (path) checkResource(containedFile(dirname(file), path));
    }
    for (const icon of Object.values(data.iconDefinitions ?? {})) {
      if (icon.iconPath) containedFile(dirname(file), icon.iconPath);
    }
    for (const font of data.fonts ?? []) {
      for (const source of font.src ?? []) containedFile(dirname(file), source.path);
    }
  }
  let grammars = 0;
  let themes = 0;
  for (const dir of assetLock.extensions) {
    const directory = resolve(assetsRoot, dir);
    const manifest = parseJSONC(containedFile(directory, 'package.json'));
    if (manifest.main || manifest.browser) throw new Error(`Unbuilt executable extension in declarative catalog: ${dir}`);
    const contributions = manifest.contributes ?? {};
    for (const key of ['themes', 'grammars', 'snippets', 'iconThemes', 'productIconThemes', 'css']) {
      for (const item of contributions[key] ?? []) checkResource(containedFile(directory, item.path));
    }
    for (const language of contributions.languages ?? []) {
      if (language.configuration) checkResource(containedFile(directory, language.configuration));
    }
    grammars += contributions.grammars?.length ?? 0;
    themes += contributions.themes?.length ?? 0;
  }
  return { extensions: assetLock.extensions.length, grammars, themes, files: Object.keys(assetLock.files).length };
}

// Resolve the exact same inheritance chain used by the VS Code theme loader.
export function readColorTheme(file, stack = new Set()) {
  if (stack.has(file)) throw new Error(`Circular theme include: ${file}`);
  stack.add(file);
  const theme = parseJSONC(file);
  const base = theme.include ? readColorTheme(containedFile(dirname(file), theme.include), stack) : {};
  stack.delete(file);
  if (theme.tokenColors && !Array.isArray(theme.tokenColors)) throw new Error(`Unsupported bundled token color file: ${file}`);
  return {
    colors: { ...base.colors, ...theme.colors },
    tokenColors: [...(base.tokenColors ?? []), ...(theme.tokenColors ?? [])],
    semanticTokenColors: { ...base.semanticTokenColors, ...theme.semanticTokenColors },
    semanticHighlighting: theme.semanticHighlighting ?? base.semanticHighlighting ?? false,
  };
}

export function readBuiltinThemes() {
  const result = [];
  for (const dir of assetLock.extensions) {
    const directory = resolve(assetsRoot, dir);
    const pkg = parseJSONC(resolve(directory, 'package.json'));
    const nlsFile = resolve(directory, 'package.nls.json');
    const nls = existsSync(nlsFile) ? parseJSONC(nlsFile) : {};
    for (const theme of pkg.contributes?.themes ?? []) {
      const label = theme.label?.replace(/^%(.+)%$/, (_, key) => nls[key] ?? key) ?? theme.id;
      result.push({ id: theme.id ?? label, label, uiTheme: theme.uiTheme, ...readColorTheme(resolve(directory, theme.path)) });
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('Validated pinned VS Code assets:', validateBuiltinAssets());
}
