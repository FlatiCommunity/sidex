/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow } from '../../../base/browser/dom.js';
import { setZoomFactor, setZoomLevel } from '../../../base/browser/browser.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { localize, localize2 } from '../../../nls.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { zoomLevelToZoomFactor } from '../../../platform/window/common/window.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../common/contributions.js';
import { IHostService } from '../../services/host/browser/host.js';

// The browser workbench omits Electron's window actions. Use the same command
// IDs and shortcuts with Tauri's webview zoom and the workbench host lifecycle.
registerAction2(class CloseWindowAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.closeWindow',
			title: { ...localize2('closeWindow', 'Close Window'), mnemonicTitle: localize('miCloseWindow', 'Clos&&e Window') },
			f1: true,
			keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW },
			menu: { id: MenuId.MenubarFileMenu, group: '6_close', order: 4 }
		});
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHostService).close();
	}
});

export function normalizeWindowZoom(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(-8, Math.min(8, Math.round(value))) : 0;
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'window',
	type: 'object',
	properties: {
		'window.zoomLevel': {
			type: 'number',
			default: 0,
			minimum: -8,
			maximum: 8,
			scope: ConfigurationScope.WINDOW,
			description: localize('zoomLevel', 'Adjust the zoom level of the window. Each step changes the scale by 20%.')
		}
	}
});

for (const action of [
	{ id: 'workbench.action.zoomIn', title: localize2('zoomIn', 'Zoom In'), mnemonicTitle: localize('miZoomIn', '&&Zoom In'), delta: 1, key: KeyCode.Equal, secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Equal, KeyMod.CtrlCmd | KeyCode.NumpadAdd] },
	{ id: 'workbench.action.zoomOut', title: localize2('zoomOut', 'Zoom Out'), mnemonicTitle: localize('miZoomOut', 'Zoom &&Out'), delta: -1, key: KeyCode.Minus, secondary: [KeyMod.CtrlCmd | KeyCode.NumpadSubtract] },
	{ id: 'workbench.action.zoomReset', title: localize2('zoomReset', 'Reset Zoom'), mnemonicTitle: localize('miZoomReset', '&&Reset Zoom'), delta: 0, key: KeyCode.Numpad0, secondary: [KeyMod.CtrlCmd | KeyCode.Digit0] }
]) {
	registerAction2(class WindowZoomAction extends Action2 {
		constructor() {
			super({
				id: action.id,
				title: { ...action.title, mnemonicTitle: action.mnemonicTitle },
				category: Categories.View,
				f1: true,
				keybinding: { weight: KeybindingWeight.WorkbenchContrib, primary: KeyMod.CtrlCmd | action.key, secondary: action.secondary },
				menu: { id: MenuId.MenubarAppearanceMenu, group: '5_zoom', order: action.delta === 1 ? 1 : action.delta === -1 ? 2 : 3 }
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			const current = normalizeWindowZoom(configuration.getValue('window.zoomLevel'));
			const next = action.delta === 0 ? 0 : normalizeWindowZoom(current + action.delta);
			await configuration.updateValue('window.zoomLevel', next, ConfigurationTarget.USER);
		}
	});
}

class NativeWindowZoom extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.nativeWindowZoom';
	private pending = Promise.resolve();

	constructor(@IConfigurationService configuration: IConfigurationService) {
		super();
		const apply = () => {
			const level = normalizeWindowZoom(configuration.getValue('window.zoomLevel'));
			this.pending = this.pending.then(async () => {
				const factor = zoomLevelToZoomFactor(level);
				const target = getActiveWindow();
				if ((globalThis as any).__TAURI_INTERNALS__) {
					const { getCurrentWebview } = await import('@tauri-apps/api/webview');
					await getCurrentWebview().setZoom(factor);
				} else {
					target.document.body.style.zoom = String(factor);
					target.document.body.style.width = `${100 / factor}vw`;
					target.document.body.style.height = `${100 / factor}vh`;
				}
				setZoomFactor(factor, target);
				setZoomLevel(level, target);
				target.dispatchEvent(new Event('resize'));
			}).catch(error => console.error('[SideX] Could not apply window zoom:', error));
		};
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('window.zoomLevel')) apply();
		}));
		apply();
	}
}
registerWorkbenchContribution2(NativeWindowZoom.ID, NativeWindowZoom, WorkbenchPhase.AfterRestored);

for (const action of [
	{ id: 'workbench.action.showWelcome', title: localize2('welcome', 'Welcome'), path: '#readme', group: '1_welcome', order: 1 },
	{ id: 'workbench.action.showReleaseNotes', title: localize2('releaseNotes', 'Release Notes'), path: '/releases', group: '1_welcome', order: 4 },
	{ id: 'workbench.action.openIssueReporter', title: localize2('reportIssue', 'Report Issue'), path: '/issues/new', group: '3_feedback', order: 3 }
]) {
	registerAction2(class SideXHelpAction extends Action2 {
		constructor() {
			super({ id: action.id, title: action.title, category: Categories.Help, f1: true, menu: { id: MenuId.MenubarHelpMenu, group: action.group, order: action.order } });
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			const product = accessor.get(IProductService);
			const url = action.id === 'workbench.action.openIssueReporter' && product.reportIssueUrl
				? product.reportIssueUrl
				: `https://github.com/naulbi-dump-projects/sidex${action.path}`;
			await accessor.get(IOpenerService).open(URI.parse(url), { openExternal: true });
		}
	});
}
