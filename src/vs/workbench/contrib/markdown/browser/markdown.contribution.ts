/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../common/markdownColors.js';
import './media/markdown.css';

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	IWorkbenchContribution,
	WorkbenchPhase,
	registerWorkbenchContribution2
} from '../../../common/contributions.js';
import { MarkdownPreviewManager, isMarkdownResource } from './markdownPreview.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod, KeyChord } from '../../../../base/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';

let _previewManager: MarkdownPreviewManager | undefined;

function getOrCreateManager(accessor: ServicesAccessor): MarkdownPreviewManager {
	if (!_previewManager) {
		_previewManager = accessor.get(IInstantiationService).createInstance(MarkdownPreviewManager);
	}
	return _previewManager;
}

class MarkdownPreviewAutoReopen extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.markdownPreviewAutoReopen';

	private _didAutoReopen = false;

	constructor(
		@IEditorService editorService: IEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IStorageService private readonly _storageService: IStorageService
	) {
		super();

		const startupTimer = setTimeout(() => {
			this._didAutoReopen = true;
		}, 3000);
		this._register({ dispose: () => clearTimeout(startupTimer) });

		this._register(
			editorService.onDidVisibleEditorsChange(() => {
				if (this._didAutoReopen) {
					return;
				}
				this._onVisibleEditorsChanged(editorService);
			})
		);
	}

	private _onVisibleEditorsChanged(editorService: IEditorService): void {
		const activeEditor = editorService.activeEditor;
		if (!(activeEditor instanceof EditorInput)) {
			return;
		}

		const resource = activeEditor.resource;
		if (!isMarkdownResource(resource)) {
			return;
		}

		if (_previewManager && _previewManager.hasActivePreview()) {
			return;
		}

		if (!MarkdownPreviewManager.wasPreviewOpen(this._storageService, resource)) {
			return;
		}

		this._didAutoReopen = true;
		const manager = this._instantiationService.createInstance(MarkdownPreviewManager);
		_previewManager = manager;
		manager.showPreview(true);
	}
}

registerWorkbenchContribution2(MarkdownPreviewAutoReopen.ID, MarkdownPreviewAutoReopen, WorkbenchPhase.BlockStartup);

CommandsRegistry.registerCommand('markdown.showPreview', (accessor, resource?: URI) => {
	getOrCreateManager(accessor).showPreview(false, resource);
});

CommandsRegistry.registerCommand('markdown.showPreviewToSide', (accessor, resource?: URI) => {
	getOrCreateManager(accessor).showPreview(true, resource);
});

CommandsRegistry.registerCommand('markdown.showSource', accessor => getOrCreateManager(accessor).showSource());
CommandsRegistry.registerCommand('markdown.togglePreview', accessor => getOrCreateManager(accessor).toggle());
CommandsRegistry.registerCommand('markdown.preview.refresh', accessor => getOrCreateManager(accessor).refresh());
CommandsRegistry.registerCommand('markdown.preview.toggleLock', accessor => getOrCreateManager(accessor).toggleLock());

CommandsRegistry.registerCommand('markdown.showPreviewSecuritySelector', accessor => {
	return accessor
		.get(IDialogService)
		.info(
			localize('markdown.previewSecurityTitle', 'Markdown Preview Security'),
			localize(
				'markdown.previewSecurityDescription',
				'Document scripts, forms, and command links are blocked. Local images are restricted to the document folder. Images from HTTP and HTTPS addresses are allowed.'
			)
		);
});

CommandsRegistry.registerCommand('markdown.findAllFileReferences', accessor => {
	const resource = accessor.get(IEditorService).activeEditor?.resource;
	if (!resource) {
		return;
	}
	return accessor.get(ICommandService).executeCommand('workbench.action.findInFiles', {
		query: resource.path.split('/').pop(),
		filesToInclude: '**/*.{md,markdown,mdown,mkdn,mkd,mdwn}',
		isRegex: false
	});
});

CommandsRegistry.registerCommand('markdown.reopenAsPreview', (accessor, resource?: URI) =>
	getOrCreateManager(accessor).showPreview(false, resource)
);
CommandsRegistry.registerCommand('markdown.reopenAsSource', accessor => getOrCreateManager(accessor).showSource());

const markdownEditor = ContextKeyExpr.equals('editorLangId', 'markdown');
for (const command of [
	{
		id: 'markdown.showPreview',
		title: localize('markdown.showPreviewTitle', 'Markdown: Open Preview'),
		precondition: markdownEditor
	},
	{
		id: 'markdown.showPreviewToSide',
		title: localize('markdown.showPreviewToSideTitle', 'Markdown: Open Preview to the Side'),
		precondition: markdownEditor
	},
	{ id: 'markdown.showSource', title: localize('markdown.showSourceTitle', 'Markdown: Show Source') },
	{ id: 'markdown.preview.refresh', title: localize('markdown.refreshPreviewTitle', 'Markdown: Refresh Preview') },
	{ id: 'markdown.preview.toggleLock', title: localize('markdown.toggleLockTitle', 'Markdown: Toggle Preview Lock') },
	{
		id: 'markdown.showPreviewSecuritySelector',
		title: localize('markdown.securityTitle', 'Markdown: Show Preview Security')
	}
]) {
	MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command });
}
KeybindingsRegistry.registerKeybindingRule({
	id: 'markdown.showPreview',
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV,
	weight: KeybindingWeight.WorkbenchContrib,
	when: markdownEditor
});
KeybindingsRegistry.registerKeybindingRule({
	id: 'markdown.showPreviewToSide',
	primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyV),
	weight: KeybindingWeight.WorkbenchContrib,
	when: markdownEditor
});
