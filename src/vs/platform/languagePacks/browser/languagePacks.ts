/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	BUNDLED_TRANSLATED_EXTENSIONS,
	BUNDLED_TRANSLATION_LOCALES
} from '../../../../localization/builtinTranslations.js';
import { URI } from '../../../base/common/uri.js';
import { ILanguagePackItem, ILanguagePackService } from '../common/languagePacks.js';
import { IExtensionGalleryService } from '../../extensionManagement/common/extensionManagement.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import {
	BUILTIN_LANGUAGES,
	findLocalization,
	getLocalizations,
	normalizeLocale,
	localeCandidates,
	scanInstalledLanguagePacks,
	storedValue,
	translationPath,
	InstalledLanguagePack
} from '../../../../localization/languagePacks.js';

export class WebLanguagePacksService implements ILanguagePackService {
	declare readonly _serviceBrand: undefined;
	private nativePacks: Promise<InstalledLanguagePack[]> | undefined;

	constructor(
		@IExtensionGalleryService private readonly galleryService: IExtensionGalleryService,
		@IExtensionService private readonly extensionService: IExtensionService
	) {}

	async getBuiltInExtensionTranslationsUri(id: string, language: string): Promise<URI | undefined> {
		const preferred = storedValue('vscode.nls.languagePackExtensionId')?.toLowerCase();
		// All built-in manifests are resolved during startup; share one native scan among them.
		const installed = await (this.nativePacks ??= scanInstalledLanguagePacks());
		installed.sort(
			(a, b) => Number(b.extensionId.toLowerCase() === preferred) - Number(a.extensionId.toLowerCase() === preferred)
		);
		for (const pack of installed) {
			const contribution = findLocalization(pack.localizations, language);
			const path = contribution?.translations.find(
				translation => translation.id.toLowerCase() === id.toLowerCase()
			)?.path;
			const relativePath = path && translationPath(path);
			if (relativePath) return URI.joinPath(URI.file(pack.extensionPath), relativePath);
		}
		for (const extension of this.extensionService.extensions) {
			const contribution = findLocalization(getLocalizations(extension), language);
			const path = contribution?.translations.find(
				translation => translation.id.toLowerCase() === id.toLowerCase()
			)?.path;
			const relativePath = path && translationPath(path);
			if (relativePath) return URI.joinPath(extension.extensionLocation, relativePath);
		}
		const bundledLocale = localeCandidates(language).find(locale => BUNDLED_TRANSLATION_LOCALES.has(locale));
		if (bundledLocale && BUNDLED_TRANSLATED_EXTENSIONS.has(id.toLowerCase())) {
			return URI.parse(
				new URL(
					`/locales/${bundledLocale}/extensions/${id.toLowerCase()}.i18n.json`,
					globalThis.location.href
				).toString()
			);
		}
		return undefined;
	}

	async getAvailableLanguages(): Promise<ILanguagePackItem[]> {
		const items = new Map<string, ILanguagePackItem>(BUILTIN_LANGUAGES.map(language => [language.id, { ...language }]));
		if (!this.galleryService.isEnabled()) return [...items.values()];
		try {
			const result = await this.galleryService.query(
				{ text: '@category:"language packs"', pageSize: 100 },
				CancellationToken.None
			);
			for (const extension of result.firstPage) {
				const taggedLocale = extension.tags.find(tag => tag.startsWith('lp-'))?.slice(3);
				if (!taggedLocale) continue;
				const id = normalizeLocale(taggedLocale);
				if (items.has(id)) continue;
				items.set(id, {
					id,
					label: extension.displayName ?? extension.name,
					description: extension.description,
					extensionId: extension.identifier.id,
					galleryExtension: extension
				});
			}
		} catch {
			/* Built-in languages remain usable offline. */
		}
		return [...items.values()];
	}

	async getInstalledLanguages(): Promise<ILanguagePackItem[]> {
		const items = new Map<string, ILanguagePackItem>(BUILTIN_LANGUAGES.map(language => [language.id, { ...language }]));
		// Disabled packs still supply translations; they do not need an extension-host entry point.
		// Opening the language picker refreshes the cache after an install or uninstall.
		for (const pack of await (this.nativePacks = scanInstalledLanguagePacks())) {
			for (const localization of pack.localizations) {
				const id = normalizeLocale(localization.languageId);
				items.set(id, {
					id,
					label: localization.localizedLanguageName || localization.languageName || id,
					extensionId: pack.extensionId
				});
			}
		}
		for (const extension of this.extensionService.extensions) {
			for (const localization of getLocalizations(extension)) {
				const id = normalizeLocale(localization.languageId);
				if (items.has(id) && !BUILTIN_LANGUAGES.some(language => language.id === id)) continue;
				items.set(id, {
					id,
					label: localization.localizedLanguageName || localization.languageName || id,
					extensionId: extension.identifier.value
				});
			}
		}
		// An old preference is not evidence that the pack is still installed.
		return [...items.values()];
	}
}
