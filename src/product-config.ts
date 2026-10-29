/** Product defaults and gallery selection shared by startup and the workbench. */
export const DEFAULT_GALLERY_URL = 'https://open-vsx.org/vscode/gallery';
export const SIDEX_GALLERY_URL = 'https://marketplace.siden.ai/api/gallery';
export const GALLERY_SETTING = 'sidex.extensions.galleryUrl';
export const GALLERY_ORIGINS_SETTING = 'sidex.extensions.allowedGalleryOrigins';

export function normalizeGalleryUrl(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		return DEFAULT_GALLERY_URL;
	}
	const url = new URL(value.trim());
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
		throw new Error('A gallery URL must use HTTPS without credentials, a query, or a fragment.');
	}
	url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/extensionquery$/, '');
	return url.toString().replace(/\/$/, '');
}

export function createProductConfiguration(galleryUrl: unknown = DEFAULT_GALLERY_URL) {
	const serviceUrl = normalizeGalleryUrl(galleryUrl);
	const openVsx = serviceUrl === DEFAULT_GALLERY_URL;
	return {
		nameShort: 'SideX',
		nameLong: 'SideX',
		applicationName: 'sidex',
		dataFolderName: '.sidex',
		urlProtocol: 'sidex',
		version: '1.110.0',
		commit: '',
		quality: 'stable',
		reportIssueUrl: 'https://github.com/naulbi-dump-projects/sidex/issues/new',
		documentationUrl: 'https://github.com/naulbi-dump-projects/sidex/blob/main/README.md',
		serverDocumentationUrl: 'https://github.com/naulbi-dump-projects/sidex/blob/main/README.md',
		licenseName: 'MIT',
		licenseUrl: 'https://github.com/naulbi-dump-projects/sidex/blob/main/LICENSE',
		serverLicenseUrl: 'https://github.com/naulbi-dump-projects/sidex/blob/main/LICENSE',
		extensionsGallery: {
			serviceUrl,
			itemUrl: openVsx ? 'https://open-vsx.org/vscode/item' : '',
			publisherUrl: '',
			controlUrl: '',
			nlsBaseUrl: '',
			extensionUrlTemplate: '',
			// A custom/combined gallery supplies its own asset URLs in extensionquery.
			// Never construct Open VSX or Microsoft URLs for an extension from another registry.
			resourceUrlTemplate: openVsx ? 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}' : ''
		}
	};
}

export async function initializeProductConfiguration(): Promise<void> {
	let galleryUrl: unknown;
	if ((globalThis as any).__TAURI_INTERNALS__) {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			const target = await invoke<string>('extension_get_target_platform');
			const arch = /-(x64|ia32|arm64|armhf)$/.exec(target)?.[1];
			(globalThis as any).__SIDEX_ARCH__ = arch === 'armhf' ? 'arm' : arch;
			const root = await invoke<string>('get_user_data_dir');
			// Reload after a window reload, including edits made through VS Code settings.
			try {
				await invoke('settings_load', { path: `${root}/User/settings.json`, scope: 'user' });
			} catch {
				/* First launch. */
			}
			const user = await invoke<Record<string, unknown>>('settings_get', { scope: 'user' });
			galleryUrl = user[GALLERY_SETTING];
		} catch (error) {
			console.warn('[SideX] Could not read extension gallery settings', error);
		}
	} else {
		try {
			galleryUrl = localStorage.getItem(GALLERY_SETTING);
		} catch {
			/* Storage unavailable. */
		}
	}
	try {
		(globalThis as any)._VSCODE_PRODUCT_JSON = createProductConfiguration(galleryUrl);
	} catch (error) {
		console.warn('[SideX] Invalid extension gallery URL; using Open VSX', error);
		(globalThis as any)._VSCODE_PRODUCT_JSON = createProductConfiguration();
	}
	(globalThis as any)._VSCODE_PACKAGE_JSON = { version: '1.110.0', name: 'sidex' };
}
