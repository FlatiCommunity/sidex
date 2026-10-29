/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_GALLERY_URL, SIDEX_GALLERY_URL, GALLERY_SETTING, GALLERY_ORIGINS_SETTING, normalizeGalleryUrl } from '../../../../../product-config.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IHostService } from '../../../services/host/browser/host.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'sidex.extensions', title: localize('sidex.extensionRegistry.settings', 'Extension Registry'),
	type: 'object', properties: {
		[GALLERY_SETTING]: {
			type: 'string', default: DEFAULT_GALLERY_URL, scope: ConfigurationScope.APPLICATION,
			description: localize('sidex.extensionRegistry.url', 'HTTPS base URL of a VS Code-compatible extension gallery. Reload SideX after changing this setting. Workspace settings cannot override this value.')
		},
		[GALLERY_ORIGINS_SETTING]: {
			type: 'array', items: { type: 'string' }, default: [], scope: ConfigurationScope.APPLICATION,
			description: localize('sidex.extensionRegistry.origins', 'Additional HTTPS origins used for assets by your custom extension gallery. Enter complete origins, for example https://cdn.example.com. Reload SideX after changing this setting.')
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'sidex.extensions.selectRegistry', title: localize2('sidex.extensionRegistry.select', 'Extensions: Select Extension Registry'), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const configuration = accessor.get(IConfigurationService);
		const host = accessor.get(IHostService);
		const choice = await quickInput.pick([
			{ label: 'Open VSX', description: 'open-vsx.org', url: DEFAULT_GALLERY_URL },
			{ label: localize('sidex.extensionRegistry.combined', 'SideX Combined Registry'), description: 'marketplace.siden.ai', url: SIDEX_GALLERY_URL },
			{ label: localize('sidex.extensionRegistry.custom', 'Custom Registry…'), description: localize('sidex.extensionRegistry.customDescription', 'A server compatible with the VS Code gallery API'), url: '' }
		], { placeHolder: localize('sidex.extensionRegistry.pick', 'Select the source for extension searches and installations') });
		if (!choice) { return; }
		let url: string | undefined = choice.url;
		if (!url) {
			url = await quickInput.input({
				prompt: localize('sidex.extensionRegistry.prompt', 'Enter the HTTPS base URL of your extension gallery'),
				value: configuration.getValue<string>(GALLERY_SETTING),
				validateInput: async value => {
					try { if (!value.trim()) { throw new Error(); } normalizeGalleryUrl(value); return undefined; }
					catch { return localize('sidex.extensionRegistry.invalid', 'Enter a valid HTTPS URL without credentials, a query, or a fragment.'); }
				}
			});
		}
		if (!url) { return; }
		const normalized = normalizeGalleryUrl(url);
		await configuration.updateValue(GALLERY_SETTING, normalized, ConfigurationTarget.USER_LOCAL);
		if (!(globalThis as any).__TAURI_INTERNALS__) { localStorage.setItem(GALLERY_SETTING, normalized); }
		await host.reload();
	}
});
