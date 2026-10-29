import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
import { collectNlsCalls } from '../nls-utils.mjs';

function moduleUrl(source) {
	return `data:text/javascript;base64,${Buffer.from(
		ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
		}).outputText
	).toString('base64')}`;
}
const helpersSource = await fs.readFile(new URL('../../src/localization/languagePacks.ts', import.meta.url), 'utf8');
const helpersUrl = moduleUrl(helpersSource);
const rules = await import(helpersUrl);

test('NLS extraction parses escaped literals and static concatenation without touching comments or prose', () => {
	const source = String.raw`
// localize('comment', 'not a message')
const example = "localize('example', 'not a message')";
localize({ key: 'real', comment: ['translator note, with comma'] }, 'A\\B\n\u00e9\t' + "!");
nls.localize2('template', \`line one
line two\`);
localize('dynamic', \`value \${variable}\`);
`
		.replaceAll('\\`', '`')
		.replaceAll('\\${', '${');
	const calls = collectNlsCalls(source, 'sample.ts');
	assert.equal(calls.length, 2);
	assert.equal(calls[0].key, 'real');
	assert.equal(calls[0].message, 'A\\B\né\t!');
	assert.equal(calls[1].message, 'line one\nline two');
	assert.equal(source.slice(calls[0].start, calls[0].end), "{ key: 'real', comment: ['translator note, with comma'] }");
});

test('locale resolution handles Chinese script aliases, regions and explicit English', () => {
	assert.equal(rules.normalizeLocale('zh_Hans_CN'), 'zh-cn');
	assert.equal(rules.normalizeLocale('zh-Hant-HK'), 'zh-tw');
	assert.equal(rules.normalizeLocale('zh-HK'), 'zh-tw');
	assert.deepEqual(rules.localeCandidates('RU_ru'), ['ru-ru', 'ru']);
	assert.equal(rules.isEnglish('en-GB'), true);
	assert.equal(rules.isEnglish('enochian'), false);
});

test('third-party language packs are found by contribution and translation paths stay inside the extension', () => {
	const manifest = {
		name: 'community-translations',
		contributes: {
			localizations: [
				{
					languageId: 'ru',
					localizedLanguageName: 'Русский',
					translations: [{ id: 'vscode', path: './resources/ru.json' }]
				},
				{ languageId: 'zh-Hans', translations: [{ id: 'vscode', path: './resources/cn.json' }] },
				{ languageId: '../escape', translations: [{ id: 'vscode', path: '../stolen.json' }] }
			]
		}
	};
	const localizations = rules.getLocalizations(manifest);
	assert.equal(localizations.length, 2);
	assert.equal(rules.findLocalization(localizations, 'ru-RU')?.languageId, 'ru');
	assert.equal(rules.findLocalization(localizations, 'zh-CN')?.languageId, 'zh-Hans');
	for (const path of [
		'../secret',
		'sub/../../secret',
		'/etc/passwd',
		'C:\\secret',
		'\\\\host\\file',
		'https://example.com/pack',
		'x\0y'
	]) {
		assert.equal(rules.translationPath(path), undefined, path);
	}
	assert.equal(rules.translationPath('.\\translations\\main.i18n.json'), 'translations/main.i18n.json');
	const malformed = rules.getLocalizations({
		contributes: {
			localizations: [
				{
					languageId: 'de',
					translations: [
						null,
						{ path: 'broken.json' },
						{ id: 'vscode', path: '../outside.json' },
						{ id: 'vscode', path: './valid.json' }
					]
				}
			]
		}
	});
	assert.deepEqual(malformed[0].translations, [{ id: 'vscode', path: 'valid.json' }]);
});

test('VS Code bundles keep identical keys in different modules isolated and reject incompatible placeholders', () => {
	const translations = rules.parseTranslationBundle(
		'\uFEFF' +
			JSON.stringify({
				contents: {
					'vs/first': { title: 'Первый {0}', empty: '', invalid: 123 },
					'vs/second': { title: 'Второй {0}' }
				}
			})
	);
	assert.equal(translations['vs/first\0title'], 'Первый {0}');
	assert.equal(translations['vs/second\0title'], 'Второй {0}');
	assert.equal(Object.keys(translations).length, 2);
	assert.equal(rules.parseTranslationBundle('<!doctype html>'), undefined);
	assert.equal(rules.usableTranslation('Файл {0}', 'File {0}'), true);
	assert.equal(rules.usableTranslation('Файл {1}', 'File {0}'), false);
	assert.equal(rules.usableTranslation('{10}: {0}', '{0}: {10}'), true);
});

test('formatting supports multi-digit positional arguments and preserves localize2 original text', async () => {
	const source = await fs.readFile(new URL('../../src/vs/nls.ts', import.meta.url), 'utf8');
	const nls = await import(moduleUrl(source));
	const argumentsList = Array.from({ length: 11 }, (_, index) => String(index));
	assert.equal(nls.localize('test', '{10} / {1}', ...argumentsList), '10 / 1');
	globalThis._VSCODE_NLS_MESSAGES = ['Перевод {10}'];
	assert.deepEqual(nls.localize2(0, 'Original {10}', ...argumentsList), {
		value: 'Перевод 10',
		original: 'Original 10'
	});
	delete globalThis._VSCODE_NLS_MESSAGES;
});

test('startup loads bundled Russian offline, validates placeholders, and never calls the marketplace', async () => {
	const saved = new Map([['vscode.nls.locale', 'ru-RU']]);
	globalThis.localStorage = {
		getItem: key => saved.get(key) ?? null,
		setItem: (key, value) => saved.set(key, value),
		removeItem: key => saved.delete(key)
	};
	const originalFetch = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async url => {
		requests.push(url);
		if (url === '/nls.messages.json')
			return new Response(
				JSON.stringify({
					modules: ['vs/test'],
					messages: [
						[0, 'hello', 'Hello {0}'],
						[0, 'bad', 'Message {0}']
					]
				})
			);
		if (url === '/locales/ru.json')
			return new Response(JSON.stringify({ contents: { 'vs/test': { hello: 'Привет, {0}', bad: 'Сообщение {1}' } } }));
		throw new Error(`Unexpected external startup request: ${url}`);
	};
	try {
		const source = (await fs.readFile(new URL('../../src/nls-loader.ts', import.meta.url), 'utf8')).replace(
			"'./localization/languagePacks.js'",
			JSON.stringify(helpersUrl)
		);
		const loader = await import(moduleUrl(source));
		await loader.loadNlsMessages();
		assert.equal(globalThis._VSCODE_NLS_LANGUAGE, 'ru');
		assert.deepEqual(globalThis._VSCODE_NLS_MESSAGES, ['Привет, {0}', 'Message {0}']);
		assert.deepEqual(requests.sort(), ['/locales/ru.json', '/nls.messages.json']);
		assert.equal(globalThis._SIDEX_NLS_COVERAGE.fallback, 1);
		saved.set('vscode.nls.locale', 'en');
		await loader.loadNlsMessages();
		assert.equal(globalThis._VSCODE_NLS_LANGUAGE, 'en');
		assert.equal(globalThis._VSCODE_NLS_MESSAGES, undefined);
		assert.equal(globalThis._SIDEX_NLS_COVERAGE, undefined);
	} finally {
		globalThis.fetch = originalFetch;
		delete globalThis.localStorage;
		delete globalThis._VSCODE_NLS_MESSAGES;
		delete globalThis._VSCODE_NLS_LANGUAGE;
	}
});

test('startup reads a third-party regional pack from its actual portable extension path', async () => {
	const saved = new Map([
		['vscode.nls.locale', 'de-AT'],
		['vscode.nls.languagePackExtensionId', 'community.translations']
	]);
	globalThis.localStorage = {
		getItem: key => saved.get(key) ?? null,
		setItem: (key, value) => saved.set(key, value),
		removeItem: key => saved.delete(key)
	};
	globalThis.__TAURI_INTERNALS__ = {};
	const originalFetch = globalThis.fetch;
	const paths = [];
	globalThis.__testNativeInvoke = async (command, args) => {
		if (command === 'list_available_extensions')
			return [
				{
					id: 'community.translations',
					version: '2.3.4',
					path: '/portable/data/extensions/community.translations-2.3.4',
					contributesKeys: ['localizations']
				}
			];
		assert.equal(command, 'read_file');
		paths.push(args.path);
		if (args.path.endsWith('/package.json'))
			return JSON.stringify({
				contributes: { localizations: [{ languageId: 'de', translations: [{ id: 'vscode', path: './i18n/de.json' }] }] }
			});
		assert.equal(args.path, '/portable/data/extensions/community.translations-2.3.4/i18n/de.json');
		return JSON.stringify({ contents: { 'vs/test': { hello: 'Hallo {0}' } } });
	};
	globalThis.fetch = async url => {
		assert.equal(url, '/nls.messages.json');
		return new Response(JSON.stringify({ modules: ['vs/test'], messages: [[0, 'hello', 'Hello {0}']] }));
	};
	try {
		const nativeUrl = moduleUrl('export const invoke = globalThis.__testNativeInvoke;');
		const portableHelpersUrl = moduleUrl(helpersSource.replaceAll("'@tauri-apps/api/core'", JSON.stringify(nativeUrl)));
		const source = (await fs.readFile(new URL('../../src/nls-loader.ts', import.meta.url), 'utf8'))
			.replace("'./localization/languagePacks.js'", JSON.stringify(portableHelpersUrl))
			.replaceAll("'@tauri-apps/api/core'", JSON.stringify(nativeUrl));
		await (await import(moduleUrl(source))).loadNlsMessages();
		assert.equal(globalThis._VSCODE_NLS_LANGUAGE, 'de');
		assert.deepEqual(globalThis._VSCODE_NLS_MESSAGES, ['Hallo {0}']);
		assert.equal(globalThis._SIDEX_NLS_COVERAGE.fallback, 0);
		assert.equal(paths.length, 2);
		assert.equal(saved.get('vscode.nls.languagePackExtensionId'), 'community.translations');
	} finally {
		globalThis.fetch = originalFetch;
		for (const key of [
			'localStorage',
			'__TAURI_INTERNALS__',
			'__testNativeInvoke',
			'_VSCODE_NLS_MESSAGES',
			'_VSCODE_NLS_LANGUAGE',
			'_SIDEX_NLS_COVERAGE',
			'_SIDEX_NLS_NATIVE_LABELS'
		])
			delete globalThis[key];
	}
});

test('translated setting labels preserve saved enum values and custom options', async () => {
	const fakeNls = moduleUrl("export const localize = (_key, message) => '[translated] ' + message;");
	const source = (
		await fs.readFile(
			new URL('../../src/vs/workbench/contrib/sidexChat/browser/settings/settingLabels.ts', import.meta.url),
			'utf8'
		)
	).replace("'../../../../../nls.js'", JSON.stringify(fakeNls));
	const { localizedSettingOptions } = await import(moduleUrl(source));
	const custom = { value: 'model-id', label: 'Model Name' };
	assert.deepEqual(localizedSettingOptions(['Auto', 'Send after current message', 'vendor/model', custom]), [
		{ value: 'Auto', label: '[translated] Auto' },
		{ value: 'Send after current message', label: '[translated] Send after current message' },
		{ value: 'vendor/model', label: 'vendor/model' },
		custom
	]);
	assert.equal(localizedSettingOptions([custom])[0], custom);
});

test('codebase mentions keep the search query separate from translated suggestion details', async () => {
	const fakeNls = moduleUrl("export const localize = (_key, message) => '[translated] ' + message;");
	const fakeUri = moduleUrl('export const URI = {};');
	const source = (
		await fs.readFile(
			new URL('../../src/vs/workbench/contrib/sidexChat/browser/context/mentionResolver.ts', import.meta.url),
			'utf8'
		)
	)
		.replace("'../../../../../nls.js'", JSON.stringify(fakeNls))
		.replace("'../../../../../base/common/uri.js'", JSON.stringify(fakeUri));
	const { MentionResolver } = await import(moduleUrl(source));
	const resolver = new MentionResolver({}, { search: async query => query });
	const [suggestion] = await resolver.getSuggestions('codebase find entry point');
	assert.equal(suggestion.detail, '[translated] Search the entire indexed codebase');
	assert.equal(await resolver.resolve(suggestion), 'find entry point');
});

test('Simplified and Traditional Chinese aliases load complete local catalogs without installing an extension', async () => {
	const originalFetch = globalThis.fetch;
	try {
		for (const [requested, locale, translated] of [
			['zh-Hans-CN', 'zh-cn', '你好，{0}'],
			['zh-Hant-HK', 'zh-tw', '你好，{0}']
		]) {
			const saved = new Map([['vscode.nls.locale', requested]]);
			globalThis.localStorage = {
				getItem: key => saved.get(key) ?? null,
				setItem: (key, value) => saved.set(key, value),
				removeItem: key => saved.delete(key)
			};
			const requests = [];
			globalThis.fetch = async url => {
				requests.push(url);
				if (url === '/nls.messages.json')
					return new Response(JSON.stringify({ modules: ['vs/test'], messages: [[0, 'hello', 'Hello {0}']] }));
				assert.equal(url, `/locales/${locale}.json`);
				return new Response(JSON.stringify({ contents: { 'vs/test': { hello: translated } } }));
			};
			const source =
				(await fs.readFile(new URL('../../src/nls-loader.ts', import.meta.url), 'utf8')).replace(
					"'./localization/languagePacks.js'",
					JSON.stringify(helpersUrl)
				) + `\n// fixture ${locale}`;
			await (await import(moduleUrl(source))).loadNlsMessages();
			assert.equal(globalThis._VSCODE_NLS_LANGUAGE, locale);
			assert.deepEqual(globalThis._VSCODE_NLS_MESSAGES, [translated]);
			assert.equal(globalThis._SIDEX_NLS_COVERAGE.fallback, 0);
			assert.deepEqual(requests.sort(), [`/locales/${locale}.json`, '/nls.messages.json']);
		}
	} finally {
		globalThis.fetch = originalFetch;
		for (const key of [
			'localStorage',
			'_VSCODE_NLS_MESSAGES',
			'_VSCODE_NLS_LANGUAGE',
			'_SIDEX_NLS_COVERAGE',
			'_SIDEX_NLS_NATIVE_LABELS'
		])
			delete globalThis[key];
	}
});
