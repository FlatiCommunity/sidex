import {
	BUILTIN_LANGUAGES,
	findLocalization,
	isEnglish,
	localeCandidates,
	normalizeLocale,
	parseTranslationBundle,
	requestedLocale,
	scanInstalledLanguagePacks,
	scopedTranslationKey,
	storedValue,
	storeValue,
	translationPath,
	usableTranslation
} from './localization/languagePacks.js';

export interface NlsIndex {
	modules: string[];
	messages: [moduleId: number, key: string, message: string][];
}

let nlsIndexPromise: Promise<NlsIndex | null> | undefined;

async function localResource(path: string): Promise<string | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 4000);
	try {
		const response = await fetch(path, { signal: controller.signal });
		return response.ok ? await response.text() : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

export function getNlsIndex(): Promise<NlsIndex | null> {
	return (nlsIndexPromise ??= localResource('/nls.messages.json').then(raw => {
		try {
			const index = raw ? JSON.parse(raw) : undefined;
			if (
				!Array.isArray(index?.modules) ||
				!index.modules.every((item: unknown) => typeof item === 'string') ||
				!Array.isArray(index.messages) ||
				!index.messages.every(
					(entry: unknown) =>
						Array.isArray(entry) &&
						Number.isInteger(entry[0]) &&
						entry[0] >= 0 &&
						entry[0] < index.modules.length &&
						typeof entry[1] === 'string' &&
						typeof entry[2] === 'string'
				)
			)
				return null;
			return index as NlsIndex;
		} catch {
			return null;
		}
	}));
}

async function loadInstalledMessages(
	locale: string
): Promise<{ messages: Record<string, string>; locale: string } | undefined> {
	const preferredId = storedValue('vscode.nls.languagePackExtensionId')?.toLowerCase();
	const candidates = localeCandidates(locale);
	const packs = (await scanInstalledLanguagePacks())
		.map(pack => ({ pack, localization: findLocalization(pack.localizations, locale) }))
		.filter(item => !!item.localization)
		.sort((a, b) => {
			const localeOrder =
				candidates.indexOf(normalizeLocale(a.localization!.languageId)) -
				candidates.indexOf(normalizeLocale(b.localization!.languageId));
			return (
				localeOrder ||
				Number(b.pack.extensionId.toLowerCase() === preferredId) -
					Number(a.pack.extensionId.toLowerCase() === preferredId)
			);
		});
	for (const { pack, localization } of packs) {
		const relativePath = translationPath(
			localization!.translations.find(translation => translation.id === 'vscode')!.path
		);
		if (!relativePath) continue;
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			const raw = await invoke<string>('read_file', {
				path: `${pack.extensionPath.replace(/[\\/]$/, '')}/${relativePath}`
			});
			const messages = parseTranslationBundle(raw);
			if (messages) {
				storeValue('vscode.nls.languagePackExtensionId', pack.extensionId);
				return { messages, locale: normalizeLocale(localization!.languageId) };
			}
		} catch {
			/* A damaged/uninstalled pack must not prevent another pack or English from loading. */
		}
	}
	storeValue('vscode.nls.languagePackExtensionId', undefined);
	return undefined;
}

export async function loadNlsMessages(): Promise<void> {
	// This runs before any VS Code module is imported. No marketplace/network request is allowed here.
	const global = globalThis as any;
	global._VSCODE_NLS_MESSAGES = undefined;
	global._VSCODE_NLS_TRANSLATIONS = undefined;
	global._SIDEX_NLS_NATIVE_LABELS = undefined;
	global._SIDEX_NLS_COVERAGE = undefined;
	global._VSCODE_NLS_LANGUAGE = 'en';
	if (typeof document !== 'undefined') document.documentElement.lang = 'en';
	const requested = requestedLocale();
	if (isEnglish(requested)) {
		storeValue('vscode.nls.languagePackExtensionId', undefined);
		return;
	}

	const bundledLocale = localeCandidates(requested).find(locale =>
		BUILTIN_LANGUAGES.some(builtin => builtin.id === locale && builtin.id !== 'en')
	);
	const [index, installed, bundledRaw] = await Promise.all([
		getNlsIndex(),
		loadInstalledMessages(requested),
		bundledLocale ? localResource(`/locales/${bundledLocale}.json`) : undefined
	]);
	const bundled = bundledRaw ? parseTranslationBundle(bundledRaw) : undefined;
	const locale = installed?.locale ?? (bundled ? bundledLocale : undefined);
	if (!locale) return;
	let extra: Record<string, string> | undefined;
	if (installed && ['ja', 'ko'].includes(locale)) {
		const raw = await localResource(`/locales/${locale}.overrides.json`);
		extra = raw ? parseTranslationBundle(raw) : undefined;
	}

	let covered = 0;
	let rejected = 0;
	if (index) {
		global._VSCODE_NLS_MESSAGES = index.messages.map(([moduleId, key, message]) => {
			const identity = scopedTranslationKey(index.modules[moduleId], key);
			for (const source of [installed?.messages, bundled, extra]) {
				const translation = source?.[identity];
				if (translation === undefined) continue;
				if (usableTranslation(translation, message)) {
					covered++;
					return translation;
				}
				rejected++;
			}
			return message;
		});
		const labels = new Map<string, string | undefined>();
		index.messages.forEach(([, , original], index) => {
			const translated = global._VSCODE_NLS_MESSAGES[index];
			if (original === translated) return;
			const key = original.replace(/&&/g, '').replace(/(?:\.\.\.|…)$/, '');
			const value = translated.replace(/&&/g, '');
			if (!labels.has(key)) labels.set(key, value);
			else if (labels.get(key) !== value) labels.set(key, undefined);
		});
		global._SIDEX_NLS_NATIVE_LABELS = Object.fromEntries([...labels].filter(([, value]) => value !== undefined));
		global._SIDEX_NLS_COVERAGE = {
			locale,
			total: index.messages.length,
			covered,
			fallback: index.messages.length - covered,
			rejected
		};
	} else {
		console.warn('[SideX NLS] The message index is unavailable; using source messages.');
		return;
	}
	global._VSCODE_NLS_LANGUAGE = locale;
	if (typeof document !== 'undefined') document.documentElement.lang = locale;
	if (rejected) console.warn(`[SideX NLS] Ignored ${rejected} translations with incompatible placeholders.`);
}
