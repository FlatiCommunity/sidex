import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNlsEntries, placeholders } from './nls-utils.mjs';
import { findUnlocalizedUi } from './ui-localization.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const entries = collectNlsEntries(root);
const originals = new Map();
const failures = [];
const neutralTerms = new Set([
	'OK',
	'Windows',
	'Super',
	'Git',
	'SideX',
	'Sidex',
	'Shell',
	'Marketplace',
	'VSIX',
	'ID',
	'LF',
	'CRLF',
	'SSH',
	'GitHub Codespaces',
	'Remote-Tunnels',
	'Remote-SSH',
	'Remote-WSL',
	'Dev Containers',
	'user@hostname[:port]',
	'meta'
]);
function isNeutral(entry) {
	if (neutralTerms.has(entry.message) || !/[a-zA-Z]/.test(entry.message.replace(/\{\d+\}/g, ''))) return true;
	if (
		entry.module === 'vs/base/common/keybindingLabels' &&
		['Ctrl', 'Control', 'Shift', 'Alt', 'Option', 'Command'].includes(entry.message)
	)
		return true;
	if (entry.module === 'vs/editor/common/languages' && entry.key === 'Null' && entry.message === 'null') return true;
	if (entry.module === 'vs/platform/files/common/files' && /^\{0\}(?:[KMGT]?B)$/.test(entry.message)) return true;
	return entry.message === '{0}K' || (entry.key === 'manyProblems' && entry.message === '10K+');
}
for (const entry of entries) {
	const identity = `${entry.module}#${entry.key}`;
	const original = originals.get(identity);
	if (original !== undefined && original !== entry.message) failures.push(`Ambiguous NLS key: ${identity}`);
	originals.set(identity, entry.message);
}
const localeArgument = process.argv.indexOf('--locale');
const locales = localeArgument >= 0 ? [process.argv[localeArgument + 1]] : ['ru', 'zh-cn', 'zh-tw'];
const reports = [];
for (const locale of locales) {
	if (!['ru', 'zh-cn', 'zh-tw'].includes(locale)) throw new Error(`Unsupported bundled locale: ${locale}`);
	const filename = path.join(root, `public/locales/${locale}.json`);
	if (!fs.existsSync(filename)) {
		failures.push(`Missing bundled catalog: ${locale}`);
		continue;
	}
	const catalog = JSON.parse(fs.readFileSync(filename, 'utf8')).contents;
	let neutral = 0;
	for (const entry of entries) {
		const identity = `${locale}:${entry.module}#${entry.key}`;
		const translated = catalog[entry.module]?.[entry.key];
		if (typeof translated !== 'string' || !translated.length)
			failures.push(`Missing translation: ${identity}: ${entry.message}`);
		else if (placeholders(translated) !== placeholders(entry.message))
			failures.push(`Incompatible placeholders: ${identity}`);
		else if (translated === entry.message) {
			if (isNeutral(entry)) neutral++;
			else failures.push(`Untranslated English: ${identity}: ${entry.message}`);
		}
	}
	let manifests = 0;
	let manifestKeys = 0;
	for (const directory of fs.readdirSync(path.join(root, 'public/extensions'))) {
		const extensionRoot = path.join(root, 'public/extensions', directory);
		const manifestFile = path.join(extensionRoot, 'package.json');
		if (!fs.existsSync(manifestFile)) continue;
		const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
		if (manifest.publisher !== 'vscode') continue;
		const englishFile = path.join(extensionRoot, 'package.nls.json');
		if (!fs.existsSync(englishFile)) continue;
		const english = JSON.parse(fs.readFileSync(englishFile, 'utf8'));
		const translatedFile = path.join(extensionRoot, `package.nls.${locale}.json`);
		if (!fs.existsSync(translatedFile)) {
			failures.push(`Missing built-in language pack: ${locale}:${directory}`);
			continue;
		}
		const translated = JSON.parse(fs.readFileSync(translatedFile, 'utf8'));
		manifests++;
		for (const [key, message] of Object.entries(english)) {
			const source = typeof message === 'string' ? message : message.message;
			const translation = translated[key];
			if (typeof translation !== 'string' || !translation.length || placeholders(translation) !== placeholders(source))
				failures.push(`Invalid built-in translation: ${locale}:${directory}#${key}`);
			else manifestKeys++;
		}
	}
	if (process.argv.includes('--dist')) {
		const index = JSON.parse(fs.readFileSync(path.join(root, 'dist/nls.messages.json'), 'utf8'));
		for (const [moduleId, key, message] of index.messages) {
			const translated = catalog[index.modules[moduleId]]?.[key];
			if (typeof translated !== 'string' || placeholders(translated) !== placeholders(message))
				failures.push(`Missing built translation: ${locale}:${index.modules[moduleId]}#${key}`);
		}
		reports.push(`${locale}: ${index.messages.length} built NLS entries validated.`);
	}
	reports.push(
		`${locale}: ${entries.length}/${entries.length} source NLS calls; ${originals.size} unique keys; ${neutral} explicit neutral names/formats; ${manifests} built-in catalogs, ${manifestKeys} translated manifest keys.`
	);
}
const allowlist = JSON.parse(fs.readFileSync(path.join(root, 'locales/ui-literal-allowlist.json'), 'utf8'));
for (const literal of findUnlocalizedUi(root)) {
	if (
		!allowlist.some(allowed => allowed.file === literal.file && allowed.message === literal.message && allowed.reason)
	)
		failures.push(`Hardcoded SideX UI text: ${literal.file}: ${literal.message}`);
}
if (failures.length) {
	console.error(failures.join('\n'));
	process.exitCode = 1;
} else {
	console.log(reports.join('\n'));
	console.log('No unapproved hardcoded SideX UI strings. English remains the source-language baseline.');
}
