/** Shared language-pack rules used before the workbench and by its language picker. */
export interface LocalizationContribution {
	languageId: string;
	languageName?: string;
	localizedLanguageName?: string;
	translations: { id: string; path: string }[];
}

export interface InstalledLanguagePack {
	extensionId: string;
	extensionPath: string;
	version: string;
	localizations: LocalizationContribution[];
}

export const BUILTIN_LANGUAGES = [
	{ id: 'en', label: 'English' },
	{ id: 'ru', label: 'Русский' }
] as const;

export function normalizeLocale(locale: string): string {
	const normalized = locale.trim().toLowerCase().replace(/_/g, '-');
	if (/^zh-(hans(?:-|$)|cn$|sg$)/.test(normalized)) return 'zh-cn';
	if (/^zh-(hant(?:-|$)|tw$|hk$|mo$)/.test(normalized)) return 'zh-tw';
	return normalized;
}

export function localeCandidates(locale: string): string[] {
	const normalized = normalizeLocale(locale);
	const candidates = [normalized];
	let separator = normalized.lastIndexOf('-');
	while (separator > 0) {
		candidates.push(normalized.slice(0, separator));
		separator = normalized.lastIndexOf('-', separator - 1);
	}
	return candidates;
}

export function isEnglish(locale: string): boolean {
	return normalizeLocale(locale).split('-')[0] === 'en';
}

/** Translation paths are extension-relative, never URLs or paths outside the extension. */
export function translationPath(relativePath: string): string | undefined {
	if (typeof relativePath !== 'string' || /[\0:]/.test(relativePath)) return undefined;
	const normalized = relativePath.replace(/\\/g, '/');
	if (normalized.startsWith('/')) return undefined;
	const parts = normalized.split('/').filter(part => part !== '.' && part !== '');
	if (parts.length === 0 || parts.includes('..')) return undefined;
	return parts.join('/');
}

export function getLocalizations(manifest: unknown): LocalizationContribution[] {
	const contributions = (manifest as { contributes?: { localizations?: unknown } })?.contributes?.localizations;
	if (!Array.isArray(contributions)) return [];
	const localizations: LocalizationContribution[] = [];
	for (const entry of contributions) {
		if (
			!entry ||
			typeof entry.languageId !== 'string' ||
			!/^[a-zA-Z]{2,8}(?:[-_][a-zA-Z0-9]{1,8})*$/.test(entry.languageId) ||
			!Array.isArray(entry.translations)
		)
			continue;
		const translations: LocalizationContribution['translations'] = [];
		for (const translation of entry.translations) {
			if (!translation || typeof translation.id !== 'string' || typeof translation.path !== 'string') continue;
			const path = translationPath(translation.path);
			if (path) translations.push({ id: translation.id.toLowerCase(), path });
		}
		if (!translations.some(translation => translation.id === 'vscode')) continue;
		localizations.push({
			languageId: entry.languageId,
			languageName: typeof entry.languageName === 'string' ? entry.languageName : undefined,
			localizedLanguageName: typeof entry.localizedLanguageName === 'string' ? entry.localizedLanguageName : undefined,
			translations
		});
	}
	return localizations;
}

export function findLocalization(
	localizations: readonly LocalizationContribution[],
	locale: string
): LocalizationContribution | undefined {
	for (const candidate of localeCandidates(locale)) {
		const match = localizations.find(item => normalizeLocale(item.languageId) === candidate);
		if (match) return match;
	}
	return undefined;
}

/** Use Rust's actual extension locations (including portable/configured roots and versioned folders). */
export async function scanInstalledLanguagePacks(): Promise<InstalledLanguagePack[]> {
	if (!(globalThis as any).__TAURI_INTERNALS__ && !(globalThis as any).__SIDEX_TAURI__) return [];
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		const extensions =
			await invoke<{ id: string; path: string; version: string; contributesKeys?: string[] }[]>(
				'list_available_extensions'
			);
		const packs = await Promise.all(
			extensions
				.filter(extension => extension.contributesKeys?.includes('localizations'))
				.map(async extension => {
					try {
						const raw = await invoke<string>('read_file', {
							path: `${extension.path.replace(/[\\/]$/, '')}/package.json`
						});
						const localizations = getLocalizations(JSON.parse(raw.replace(/^\uFEFF/, '')));
						return localizations.length
							? { extensionId: extension.id, extensionPath: extension.path, version: extension.version, localizations }
							: undefined;
					} catch {
						return undefined;
					}
				})
		);
		return packs.filter((pack): pack is InstalledLanguagePack => !!pack);
	} catch {
		return [];
	}
}

export function storedValue(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function storeValue(key: string, value: string | undefined): void {
	try {
		if (value === undefined) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		/* A blocked storage backend must not prevent the workbench from starting. */
	}
}

export function requestedLocale(): string {
	return normalizeLocale(
		storedValue('vscode.nls.locale') || (typeof navigator !== 'undefined' && navigator.language) || 'en'
	);
}

export function scopedTranslationKey(module: string, key: string): string {
	return `${module}\0${key}`;
}

export function placeholders(message: string): string {
	return [...new Set([...message.matchAll(/\{(\d+)\}/g)].map(match => match[1]))].sort().join(',');
}

export function usableTranslation(message: unknown, original: string): message is string {
	return typeof message === 'string' && message.length > 0 && placeholders(message) === placeholders(original);
}

export function parseTranslationBundle(raw: string): Record<string, string> | undefined {
	try {
		const contents = JSON.parse(raw.replace(/^\uFEFF/, ''))?.contents;
		if (!contents || typeof contents !== 'object' || Array.isArray(contents)) return undefined;
		const messages: Record<string, string> = Object.create(null);
		for (const [module, bundle] of Object.entries(contents)) {
			if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) continue;
			for (const [key, message] of Object.entries(bundle)) {
				if (typeof message === 'string' && message.length > 0) messages[scopedTranslationKey(module, key)] = message;
			}
		}
		return Object.keys(messages).length ? messages : undefined;
	} catch {
		return undefined;
	}
}
