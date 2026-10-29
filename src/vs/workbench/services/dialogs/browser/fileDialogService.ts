/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IPickAndOpenOptions,
	ISaveDialogOptions,
	IOpenDialogOptions,
	IFileDialogService
} from '../../../../platform/dialogs/common/dialogs.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AbstractFileDialogService } from './abstractFileDialogService.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';

/**
 * SideX file dialog service — always routes through the Tauri native dialog
 * plugin. The HTML File System Access / IndexedDB fallbacks from upstream
 * VS Code have been removed; all file I/O flows through the Rust backend.
 */
export class FileDialogService extends AbstractFileDialogService implements IFileDialogService {
	protected override addFileSchemaIfNeeded(schema: string, isFolder: boolean): string[] {
		return schema === Schemas.untitled
			? [Schemas.file]
			: schema !== Schemas.file && (!isFolder || schema !== Schemas.vscodeRemote)
				? [schema, Schemas.file]
				: [schema];
	}

	async pickFileFolderAndOpen(options: IPickAndOpenOptions): Promise<void> {
		return this._tauriPickFolderAndOpen(options);
	}

	async pickFileAndOpen(options: IPickAndOpenOptions): Promise<void> {
		return this._tauriPickFileAndOpen(options);
	}

	async pickFolderAndOpen(options: IPickAndOpenOptions): Promise<void> {
		return this._tauriPickFolderAndOpen(options);
	}

	async pickWorkspaceAndOpen(options: IPickAndOpenOptions): Promise<void> {
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const title = localize('openWorkspace', 'Open Workspace');
			const selected = await open({
				directory: false,
				multiple: false,
				title,
				defaultPath: options.defaultUri?.scheme === Schemas.file ? options.defaultUri.fsPath : undefined,
				filters: [{ name: title, extensions: ['code-workspace'] }]
			});
			if (selected && typeof selected === 'string') {
				await this.hostService.openWindow([{ workspaceUri: URI.file(selected) }], {
					forceNewWindow: options.forceNewWindow,
					remoteAuthority: options.remoteAuthority
				});
			}
		} catch (e) {
			console.error('[SideX] Failed to open workspace dialog:', e);
		}
	}

	async pickFileToSave(defaultUri: URI, availableFileSystems?: string[]): Promise<URI | undefined> {
		return this._tauriPickFileToSave(defaultUri, availableFileSystems);
	}

	async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		return this._tauriShowSaveDialog(options);
	}

	async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
		return this._tauriShowOpenDialog(options);
	}

	private async _tauriPickFolderAndOpen(options: IPickAndOpenOptions): Promise<void> {
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const selected = await open({
				directory: true,
				multiple: false,
				title: localize('openFolder', 'Open Folder'),
				defaultPath: options.defaultUri?.scheme === Schemas.file ? options.defaultUri.fsPath : undefined
			});
			if (selected && typeof selected === 'string') {
				const folderUri = URI.file(selected);
				await this.hostService.openWindow([{ folderUri }], {
					forceNewWindow: options.forceNewWindow,
					remoteAuthority: options.remoteAuthority
				});
			}
		} catch (e) {
			console.error('[SideX] Failed to open folder dialog:', e);
		}
	}

	private async _tauriPickFileAndOpen(options: IPickAndOpenOptions): Promise<void> {
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const selected = await open({
				directory: false,
				multiple: false,
				title: localize('openFile', 'Open File'),
				defaultPath: options.defaultUri?.scheme === Schemas.file ? options.defaultUri.fsPath : undefined
			});
			if (selected && typeof selected === 'string') {
				const fileUri = URI.file(selected);
				await this.editorService.openEditor({ resource: fileUri, options: { pinned: true } });
			}
		} catch (e) {
			console.error('[SideX] Failed to open file dialog:', e);
		}
	}

	private async _tauriPickFileToSave(defaultUri: URI, availableFileSystems?: string[]): Promise<URI | undefined> {
		try {
			const { save } = await import('@tauri-apps/plugin-dialog');
			const options = this.getPickFileToSaveDialogOptions(defaultUri, availableFileSystems);
			const tauriFilters = (options.filters || [])
				.map(f => ({
					name: f.name,
					extensions: f.extensions.filter(e => e !== '*' && e !== '')
				}))
				.filter(f => f.extensions.length > 0);

			const result = await save({
				title: options.title,
				defaultPath: defaultUri.fsPath || undefined,
				filters: tauriFilters.length ? tauriFilters : undefined
			});
			if (result) {
				return URI.file(result);
			}
		} catch (e) {
			console.error('[SideX] Save dialog failed:', e);
		}
		return undefined;
	}

	private async _tauriShowSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		try {
			const { save } = await import('@tauri-apps/plugin-dialog');
			const tauriFilters = (options.filters || [])
				.map(f => ({
					name: f.name,
					extensions: f.extensions.filter(e => e !== '*' && e !== '')
				}))
				.filter(f => f.extensions.length > 0);

			const result = await save({
				title: options.title,
				defaultPath: options.defaultUri?.fsPath || undefined,
				filters: tauriFilters.length ? tauriFilters : undefined
			});
			if (result) {
				return URI.file(result);
			}
		} catch (e) {
			console.error('[SideX] Save dialog failed:', e);
		}
		return undefined;
	}

	private async _tauriShowOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const isDir = options.canSelectFolders && !options.canSelectFiles;
			const tauriFilters = (options.filters || [])
				.map(f => ({
					name: f.name,
					extensions: f.extensions.filter(e => e !== '*' && e !== '')
				}))
				.filter(f => f.extensions.length > 0);

			const result = await open({
				directory: isDir,
				multiple: options.canSelectMany ?? false,
				title: options.title,
				defaultPath: options.defaultUri?.fsPath || undefined,
				filters: tauriFilters.length ? tauriFilters : undefined
			});

			if (!result) {
				return undefined;
			}
			const paths = Array.isArray(result) ? result : [result];
			return paths.map(p => URI.file(p));
		} catch (e) {
			console.error('[SideX] Open dialog failed:', e);
		}
		return undefined;
	}
}

registerSingleton(IFileDialogService, FileDialogService, InstantiationType.Delayed);
