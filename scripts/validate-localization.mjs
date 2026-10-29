import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNlsEntries, placeholders } from './nls-utils.mjs';
import { findUnlocalizedUi } from './ui-localization.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'public/locales/ru.json'), 'utf8')).contents;
const entries = collectNlsEntries(root);
const originals = new Map();
const failures = [];
let neutral = 0;
const neutralTerms = new Set([
	'OK',
	'Windows',
	'Super',
	'Git',
	'SideX',
	'Marketplace',
	'VSIX',
	'LF',
	'CRLF',
	'SSH',
	'GitHub Codespaces',
	'meta'
]);
for (const entry of entries) {
	const identity = `${entry.module}#${entry.key}`;
	const original = originals.get(identity);
	if (original !== undefined && original !== entry.message) failures.push(`Ambiguous NLS key: ${identity}`);
	originals.set(identity, entry.message);
	const translated = catalog[entry.module]?.[entry.key];
	if (typeof translated !== 'string' || !translated.length)
		failures.push(`Missing Russian translation: ${identity}: ${entry.message}`);
	else if (placeholders(translated) !== placeholders(entry.message))
		failures.push(`Incompatible placeholders: ${identity}`);
	else if (translated === entry.message) {
		if (neutralTerms.has(translated) || !/[a-zA-Z]/.test(translated.replace(/\{\d+\}/g, ''))) neutral++;
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
	const russianFile = path.join(extensionRoot, 'package.nls.ru.json');
	if (!fs.existsSync(russianFile)) {
		failures.push(`Missing built-in language pack: ${directory}`);
		continue;
	}
	const russian = JSON.parse(fs.readFileSync(russianFile, 'utf8'));
	manifests++;
	for (const [key, message] of Object.entries(english)) {
		const source = typeof message === 'string' ? message : message.message;
		const translation = russian[key];
		if (typeof translation !== 'string' || !translation.length || placeholders(translation) !== placeholders(source))
			failures.push(`Invalid built-in translation: ${directory}#${key}`);
		else manifestKeys++;
	}
}
const allowlist = JSON.parse(fs.readFileSync(path.join(root, 'locales/ui-literal-allowlist.json'), 'utf8'));
for (const literal of findUnlocalizedUi(root)) {
	if (
		!allowlist.some(allowed => allowed.file === literal.file && allowed.message === literal.message && allowed.reason)
	) {
		failures.push(`Hardcoded SideX UI text: ${literal.file}: ${literal.message}`);
	}
}
if (process.argv.includes('--dist')) {
	const index = JSON.parse(fs.readFileSync(path.join(root, 'dist/nls.messages.json'), 'utf8'));
	for (const [moduleId, key, message] of index.messages) {
		const translated = catalog[index.modules[moduleId]]?.[key];
		if (typeof translated !== 'string' || placeholders(translated) !== placeholders(message))
			failures.push(`Missing built translation: ${index.modules[moduleId]}#${key}`);
	}
	console.log(`Built bundle: ${index.messages.length} NLS calls validated.`);
}
if (failures.length) {
	console.error(failures.join('\n'));
	process.exitCode = 1;
} else {
	console.log(
		`RU/EN: ${entries.length}/${entries.length} source NLS calls; ${originals.size} unique keys; ${neutral} explicit neutral names/formats.`
	);
	console.log(
		`Built-in extensions: ${manifests} catalogs, ${manifestKeys} Russian keys. No unapproved hardcoded SideX UI strings.`
	);
}
