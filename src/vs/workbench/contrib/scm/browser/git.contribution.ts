/*---------------------------------------------------------------------------------------------
 *  Tauri Git SCM Provider for SideX
 *  Registers a native Git source control provider using Tauri's invoke() API
 *  instead of the VS Code extension host protocol.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { observableValue } from '../../../../base/common/observable.js';
import type { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ResourceTree } from '../../../../base/common/resourceTree.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { fromNow } from '../../../../base/common/date.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import {
	ISCMService,
	ISCMProvider,
	ISCMResource,
	ISCMResourceGroup,
	ISCMResourceDecorations,
	ISCMActionButtonDescriptor
} from '../common/scm.js';
import type {
	ISCMHistoryProvider,
	ISCMHistoryOptions,
	ISCMHistoryItem,
	ISCMHistoryItemChange,
	ISCMHistoryItemRef,
	ISCMHistoryItemRefsChangeEvent
} from '../common/history.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ISCMArtifactProvider } from '../common/artifact.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import {
	FileSystemProviderCapabilities,
	FileType,
	FilePermission,
	createFileSystemProviderError,
	FileSystemProviderErrorCode
} from '../../../../platform/files/common/files.js';
import type {
	IFileSystemProvider,
	IStat,
	IFileDeleteOptions,
	IFileOverwriteOptions,
	IFileWriteOptions,
	IWatchOptions,
	IFileChange
} from '../../../../platform/files/common/files.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import type { Command } from '../../../../editor/common/languages.js';
import type { Event } from '../../../../base/common/event.js';
import {
	IDecorationsService,
	IDecorationsProvider,
	IDecorationData
} from '../../../services/decorations/common/decorations.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { historyItemRefColor, historyItemRemoteRefColor } from './scmHistory.js';
import { GIT_ORIGINAL_SCHEME, gitOriginalUri, gitOriginalRequest } from './gitOriginalUri.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { isMacintosh } from '../../../../base/common/platform.js';

// ─── Tauri invoke() bridge ──────────────────────────────────────────────────

interface TauriGitChange {
	path: string;
	original_path?: string;
	status: string;
	staged: boolean;
}

interface TauriGitStatus {
	branch: string;
	changes: TauriGitChange[];
}

interface TauriGitLogEntry {
	hash: string;
	message: string;
	author: string;
	email?: string;
	date: string;
	parent_hashes?: string[];
	files_changed?: number;
	insertions?: number;
	deletions?: number;
}

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;

async function getTauriInvoke(): Promise<typeof _invoke> {
	if (_invoke) {
		return _invoke;
	}
	try {
		const mod = await import('@tauri-apps/api/core');
		_invoke = mod.invoke;
		return _invoke;
	} catch {
		return undefined;
	}
}

async function invokeGit<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
	const invoke = await getTauriInvoke();
	if (!invoke) {
		return undefined;
	}
	return invoke(cmd, args) as Promise<T>;
}

// ─── Git Original File System Provider ──────────────────────────────────────

class TauriGitOriginalFileProvider implements IFileSystemProvider {
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.Readonly;

	private readonly _onDidChangeCapabilities = new Emitter<void>();
	readonly onDidChangeCapabilities: Event<void> = this._onDidChangeCapabilities.event;

	private readonly _onDidChangeFile = new Emitter<readonly IFileChange[]>();
	readonly onDidChangeFile: Event<readonly IFileChange[]> = this._onDidChangeFile.event;

	constructor(private readonly _workspaceRoot: string) {}

	watch(_resource: URI, _opts: IWatchOptions): IDisposable {
		return Disposable.None;
	}

	async stat(resource: URI): Promise<IStat> {
		const bytes = await this.readFile(resource);
		return { type: FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength, permissions: FilePermission.Readonly };
	}

	async mkdir(_resource: URI): Promise<void> {
		throw new Error('git-original is read-only');
	}

	async readdir(_resource: URI): Promise<[string, FileType][]> {
		return [];
	}

	async delete(_resource: URI, _opts: IFileDeleteOptions): Promise<void> {
		throw new Error('git-original is read-only');
	}

	async rename(_from: URI, _to: URI, _opts: IFileOverwriteOptions): Promise<void> {
		throw new Error('git-original is read-only');
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const request = gitOriginalRequest(resource, URI.file(this._workspaceRoot));
		if (request.reference === 'EMPTY') return new Uint8Array();
		const invoke = await getTauriInvoke();
		if (!invoke)
			throw createFileSystemProviderError(
				localize('git.backendUnavailable', 'Git backend unavailable'),
				FileSystemProviderErrorCode.Unavailable
			);
		try {
			return new Uint8Array((await invoke('git_show', request)) as number[]);
		} catch (error) {
			throw createFileSystemProviderError(String(error), FileSystemProviderErrorCode.FileNotFound);
		}
	}

	async writeFile(_resource: URI, _content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
		throw new Error('git-original is read-only');
	}
}

// ─── SCM Resource ───────────────────────────────────────────────────────────

class TauriGitResource implements ISCMResource {
	readonly decorations: ISCMResourceDecorations;
	readonly contextValue: string | undefined;
	readonly command: Command | undefined;
	readonly multiDiffEditorOriginalUri: URI | undefined;
	readonly multiDiffEditorModifiedUri: URI | undefined;

	constructor(
		readonly resourceGroup: ISCMResourceGroup,
		readonly sourceUri: URI,
		private readonly _status: string,
		private readonly _staged: boolean,
		private readonly _workspaceRootUri: URI,
		private readonly _originalPath?: string
	) {
		this.decorations = TauriGitResource._decorationForStatus(_status);
		this.contextValue = _staged ? 'staged' : 'unstaged';

		if (_status === 'untracked') {
			this.command = { id: 'git.openFile', title: localize('git.openFile', 'Open File') };
			this.multiDiffEditorOriginalUri = undefined;
			this.multiDiffEditorModifiedUri = sourceUri;
		} else {
			const originalFile = _originalPath ? URI.joinPath(_workspaceRootUri, _originalPath) : sourceUri;
			const reference = _status === 'added' ? 'EMPTY' : _staged ? 'HEAD' : 'INDEX';
			this.command = { id: 'git.openDiff', title: localize('git.openChanges', 'Open Changes') };
			this.multiDiffEditorOriginalUri = gitOriginalUri(originalFile, _workspaceRootUri, reference);
			this.multiDiffEditorModifiedUri =
				_status === 'deleted'
					? gitOriginalUri(sourceUri, _workspaceRootUri, 'EMPTY')
					: _staged
						? gitOriginalUri(sourceUri, _workspaceRootUri, 'INDEX')
						: sourceUri;
		}
	}

	get statusLabel(): string {
		return this._status;
	}

	async open(_preserveFocus: boolean): Promise<void> {
		const commandService = (globalThis as any).__sidex_commandService;
		if (!commandService) {
			return;
		}
		if (this.command?.id === 'git.openDiff') {
			await commandService.executeCommand('git.openDiff', this);
		} else {
			await commandService.executeCommand('git.openFile', this);
		}
	}

	private static _decorationForStatus(status: string): ISCMResourceDecorations {
		switch (status) {
			case 'modified':
				return {
					tooltip: localize('sidex.ui.modified.e8ce5d', 'Modified'),
					icon: ThemeIcon.fromId('diff-modified'),
					faded: false
				};
			case 'added':
			case 'new file':
				return {
					tooltip: localize('sidex.ui.added.6b02e0', 'Added'),
					icon: ThemeIcon.fromId('diff-added'),
					faded: false
				};
			case 'deleted':
				return {
					tooltip: localize('sidex.ui.deleted.b48ff3', 'Deleted'),
					icon: ThemeIcon.fromId('diff-removed'),
					strikeThrough: true,
					faded: false
				};
			case 'renamed':
				return {
					tooltip: localize('sidex.ui.renamed.05487a', 'Renamed'),
					icon: ThemeIcon.fromId('diff-renamed'),
					faded: false
				};
			case 'untracked':
				return {
					tooltip: localize('sidex.ui.untracked.c7ba54', 'Untracked'),
					icon: ThemeIcon.fromId('diff-added'),
					faded: false
				};
			default:
				return { tooltip: status, faded: false };
		}
	}
}

// ─── SCM Resource Group ─────────────────────────────────────────────────────

class TauriGitResourceGroup implements ISCMResourceGroup {
	resources: ISCMResource[] = [];

	private _resourceTree: ResourceTree<ISCMResource, ISCMResourceGroup> | undefined;
	get resourceTree(): ResourceTree<ISCMResource, ISCMResourceGroup> {
		if (!this._resourceTree) {
			const rootUri = this.provider.rootUri ?? URI.file('/');
			this._resourceTree = new ResourceTree<ISCMResource, ISCMResourceGroup>(
				this,
				rootUri,
				this._uriIdentService.extUri
			);
			for (const resource of this.resources) {
				this._resourceTree.add(resource.sourceUri, resource);
			}
		}
		return this._resourceTree;
	}

	readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	readonly _onDidChangeResources = new Emitter<void>();
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

	readonly hideWhenEmpty: boolean;
	contextValue: string | undefined;
	readonly multiDiffEditorEnableViewChanges = false;

	constructor(
		readonly id: string,
		readonly label: string,
		readonly provider: ISCMProvider,
		private readonly _uriIdentService: IUriIdentityService,
		hideWhenEmpty: boolean = false
	) {
		this.contextValue = id;
		this.hideWhenEmpty = hideWhenEmpty;
	}

	setResources(resources: ISCMResource[]): void {
		this.resources = resources;
		this._resourceTree = undefined;
		this._onDidChangeResources.fire();
		this._onDidChange.fire();
	}
}

// ─── SCM History Provider ───────────────────────────────────────────────────

class TauriGitHistoryProvider implements ISCMHistoryProvider {
	private readonly _historyItemRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	readonly historyItemRef: IObservable<ISCMHistoryItemRef | undefined> = this._historyItemRef;

	private readonly _historyItemRemoteRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	readonly historyItemRemoteRef: IObservable<ISCMHistoryItemRef | undefined> = this._historyItemRemoteRef;

	private readonly _historyItemBaseRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	readonly historyItemBaseRef: IObservable<ISCMHistoryItemRef | undefined> = this._historyItemBaseRef;

	private readonly _historyItemRefChanges = observableValue<ISCMHistoryItemRefsChangeEvent>(this, {
		added: [],
		removed: [],
		modified: [],
		silent: true
	});
	readonly historyItemRefChanges: IObservable<ISCMHistoryItemRefsChangeEvent> = this._historyItemRefChanges;

	constructor(
		private readonly _rootPath: string,
		private readonly _rootUri: URI,
		private readonly _logService: ILogService
	) {}

	_githubUrl: string | undefined;

	async _detectGitHubUrl(): Promise<string | undefined> {
		try {
			const invoke = await getTauriInvoke();
			if (!invoke) {
				return undefined;
			}
			const output = (await invoke('git_run', {
				path: this._rootPath,
				args: ['remote', 'get-url', 'origin']
			})) as string;
			const url = output.trim();
			this._githubUrl = url;
			return url;
		} catch {
			return undefined;
		}
	}

	updateRef(branch: string, headHash?: string): void {
		const newRef: ISCMHistoryItemRef = {
			id: `refs/heads/${branch}`,
			name: branch,
			revision: headHash,
			color: historyItemRefColor,
			icon: ThemeIcon.fromId('git-branch')
		};

		const oldRef = this._historyItemRef.get();
		this._historyItemRef.set(newRef, undefined);

		this._resolveRemoteRef(branch, headHash);

		if (oldRef?.revision !== headHash) {
			this._historyItemRefChanges.set(
				{
					added: oldRef ? [] : [newRef],
					removed: [],
					modified: oldRef ? [newRef] : [],
					silent: false
				},
				undefined
			);
		}
	}

	private async _resolveRemoteRef(branch: string, _headHash?: string): Promise<void> {
		try {
			const invoke = await getTauriInvoke();
			if (!invoke) {
				return;
			}

			const trackingBranch = (
				(await invoke('git_run', {
					path: this._rootPath,
					args: ['config', '--get', `branch.${branch}.remote`]
				})) as string
			).trim();

			if (trackingBranch) {
				const remoteBranch = (
					(await invoke('git_run', {
						path: this._rootPath,
						args: ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]
					})) as string
				).trim();

				const remoteHash = (
					(await invoke('git_run', {
						path: this._rootPath,
						args: ['rev-parse', remoteBranch]
					})) as string
				).trim();

				this._historyItemRemoteRef.set(
					{
						id: `refs/remotes/${remoteBranch}`,
						name: remoteBranch,
						revision: remoteHash,
						color: historyItemRemoteRefColor,
						icon: ThemeIcon.fromId('cloud')
					},
					undefined
				);

				this._historyItemBaseRef.set(
					{
						id: `refs/remotes/${remoteBranch}`,
						name: remoteBranch,
						revision: remoteHash,
						icon: ThemeIcon.fromId('git-commit')
					},
					undefined
				);
			}
		} catch {
			this._historyItemRemoteRef.set(undefined, undefined);
			this._historyItemBaseRef.set(undefined, undefined);
		}
	}

	async provideHistoryItemRefs(
		_historyItemRefs?: string[],
		_token?: CancellationToken
	): Promise<ISCMHistoryItemRef[] | undefined> {
		const refs: ISCMHistoryItemRef[] = [];
		const current = this._historyItemRef.get();
		if (current) {
			refs.push(current);
		}
		const remote = this._historyItemRemoteRef.get();
		if (remote) {
			refs.push(remote);
		}
		return refs;
	}

	async provideHistoryItems(
		options: ISCMHistoryOptions,
		_token?: CancellationToken
	): Promise<ISCMHistoryItem[] | undefined> {
		try {
			const limit = typeof options.limit === 'number' ? options.limit : 50;
			const entries = await invokeGit<TauriGitLogEntry[]>('git_log_graph', {
				path: this._rootPath,
				limit: limit + (options.skip ?? 0)
			});

			if (!entries) {
				return [];
			}

			const skip = options.skip ?? 0;
			const sliced = skip > 0 ? entries.slice(skip) : entries;

			const currentRef = this._historyItemRef.get();
			const remoteRef = this._historyItemRemoteRef.get();

			return sliced.map((entry, index) => {
				const references: ISCMHistoryItemRef[] = [];
				if (index === 0 && skip === 0 && currentRef) {
					references.push(currentRef);
				}
				if (index === 0 && skip === 0 && remoteRef) {
					references.push(remoteRef);
				}

				const authorDate = new Date(entry.date);
				const dateString = authorDate.toLocaleString(getNLSLanguage(), {
					year: 'numeric',
					month: 'long',
					day: 'numeric',
					hour: 'numeric',
					minute: 'numeric'
				});
				const relativeDate = fromNow(authorDate, true, true);

				const tooltip: MarkdownString[] = [];

				// Section 1: Author + message
				const authorMd = new MarkdownString('', { supportThemeIcons: true, supportHtml: true });
				authorMd.appendMarkdown('$(account) [**');
				authorMd.appendText(entry.author);
				authorMd.appendMarkdown('**](mailto:');
				authorMd.appendText(entry.email ?? entry.author);
				authorMd.appendMarkdown(')');
				if (!isNaN(authorDate.getTime())) {
					authorMd.appendMarkdown(', $(history)');
					authorMd.appendText(` ${relativeDate} (${dateString})`);
				}
				authorMd.appendMarkdown('\n\n');
				authorMd.appendMarkdown(entry.message.replace(/!\[/g, '&#33;&#91;').replace(/\r\n|\r|\n/g, '\n\n'));
				authorMd.appendMarkdown('\n\n---\n\n');
				tooltip.push(authorMd);

				// Section 2: Stats
				if (entry.files_changed !== undefined) {
					const statsMd = new MarkdownString('', { supportThemeIcons: true, supportHtml: true });
					const fc = entry.files_changed;
					statsMd.appendText(localize('git.filesChanged', 'Files changed: {0}', fc));
					if (entry.insertions) {
						statsMd.appendMarkdown(
							',&nbsp;<span style="color:var(--vscode-scmGraph-historyItemHoverAdditionsForeground);">'
						);
						statsMd.appendText(localize('git.insertions', 'Insertions: {0} (+)', entry.insertions));
						statsMd.appendMarkdown('</span>');
					}
					if (entry.deletions) {
						statsMd.appendMarkdown(
							',&nbsp;<span style="color:var(--vscode-scmGraph-historyItemHoverDeletionsForeground);">'
						);
						statsMd.appendText(localize('git.deletions', 'Deletions: {0} (-)', entry.deletions));
						statsMd.appendMarkdown('</span>');
					}
					statsMd.appendMarkdown('\n\n---\n\n');
					tooltip.push(statsMd);
				}

				return {
					id: entry.hash,
					parentIds: entry.parent_hashes ?? [],
					subject: entry.message,
					message: entry.message,
					displayId: entry.hash.substring(0, 7),
					author: entry.author,
					authorEmail: entry.email,
					authorIcon: ThemeIcon.fromId('account'),
					timestamp: authorDate.getTime(),
					statistics:
						entry.files_changed !== undefined
							? {
									files: entry.files_changed,
									insertions: entry.insertions ?? 0,
									deletions: entry.deletions ?? 0
								}
							: undefined,
					references,
					tooltip
				} satisfies ISCMHistoryItem;
			});
		} catch (err) {
			this._logService.warn('[TauriGit] git_log failed', err);
			return [];
		}
	}

	async provideHistoryItemChanges(
		historyItemId: string,
		_historyItemParentId: string | undefined,
		_token?: CancellationToken
	): Promise<ISCMHistoryItemChange[] | undefined> {
		try {
			const parentRef = _historyItemParentId ?? `${historyItemId}~1`;

			const invoke = await getTauriInvoke();
			if (!invoke) {
				return [];
			}

			let nameOutput: string;
			try {
				nameOutput = (await invoke('git_run', {
					path: this._rootPath,
					args: ['diff-tree', '--no-commit-id', '-r', '--name-status', parentRef, historyItemId]
				})) as string;
			} catch {
				try {
					nameOutput = (await invoke('git_run', {
						path: this._rootPath,
						args: ['diff-tree', '--no-commit-id', '-r', '--name-only', historyItemId]
					})) as string;
				} catch {
					return [];
				}
			}

			if (!nameOutput || !nameOutput.trim()) {
				return [];
			}

			return nameOutput
				.trim()
				.split('\n')
				.filter(line => line.trim())
				.map(line => {
					const parts = line.split('\t');
					const filePath = parts.length > 1 ? parts[parts.length - 1] : parts[0];
					const fileUri = URI.joinPath(this._rootUri, filePath.trim());
					return {
						uri: fileUri,
						originalUri: gitOriginalUri(fileUri, this._rootUri, parentRef),
						modifiedUri: gitOriginalUri(fileUri, this._rootUri, historyItemId)
					} satisfies ISCMHistoryItemChange;
				});
		} catch (err) {
			this._logService.warn('[TauriGit] provideHistoryItemChanges failed', err);
			return [];
		}
	}

	async resolveHistoryItem(historyItemId: string, _token?: CancellationToken): Promise<ISCMHistoryItem | undefined> {
		const items = await this.provideHistoryItems({ limit: 100 });
		return items?.find(item => item.id === historyItemId);
	}

	async resolveHistoryItemChatContext(_historyItemId: string, _token?: CancellationToken): Promise<string | undefined> {
		return undefined;
	}

	async resolveHistoryItemChangeRangeChatContext(
		_historyItemId: string,
		_historyItemParentId: string,
		_path: string,
		_token?: CancellationToken
	): Promise<string | undefined> {
		return undefined;
	}

	async resolveHistoryItemRefsCommonAncestor(
		_historyItemRefs: string[],
		_token?: CancellationToken
	): Promise<string | undefined> {
		if (_historyItemRefs.length < 2) {
			return _historyItemRefs[0];
		}
		try {
			const invoke = await getTauriInvoke();
			if (!invoke) {
				return undefined;
			}
			const result = (
				(await invoke('git_run', {
					path: this._rootPath,
					args: ['merge-base', _historyItemRefs[0], _historyItemRefs[1]]
				})) as string
			).trim();
			return result || undefined;
		} catch {
			return undefined;
		}
	}
}

// ─── SCM Provider ───────────────────────────────────────────────────────────

class TauriGitSCMProvider extends Disposable implements ISCMProvider {
	readonly id: string;
	readonly providerId = 'git';
	readonly label = 'Git';
	readonly name: string;
	readonly rootUri: URI;
	readonly iconPath = ThemeIcon.fromId('repo');
	readonly isHidden = false;
	readonly inputBoxTextModel: ITextModel;

	private readonly _contextValue = observableValue<string | undefined>(this, 'git');
	get contextValue(): IObservable<string | undefined> {
		return this._contextValue;
	}

	private readonly _count = observableValue<number | undefined>(this, undefined);
	get count(): IObservable<number | undefined> {
		return this._count;
	}

	private readonly _commitTemplate = observableValue<string>(this, '');
	get commitTemplate(): IObservable<string> {
		return this._commitTemplate;
	}

	private readonly _actionButton = observableValue<ISCMActionButtonDescriptor | undefined>(this, undefined);
	get actionButton(): IObservable<ISCMActionButtonDescriptor | undefined> {
		return this._actionButton;
	}

	private readonly _statusBarCommands = observableValue<readonly Command[] | undefined>(this, undefined);
	get statusBarCommands(): IObservable<readonly Command[] | undefined> {
		return this._statusBarCommands;
	}

	private readonly _artifactProvider = observableValue<ISCMArtifactProvider | undefined>(this, undefined);
	get artifactProvider(): IObservable<ISCMArtifactProvider | undefined> {
		return this._artifactProvider;
	}

	private readonly _historyProvider = observableValue<ISCMHistoryProvider | undefined>(this, undefined);
	get historyProvider(): IObservable<ISCMHistoryProvider | undefined> {
		return this._historyProvider;
	}

	readonly acceptInputCommand: Command = {
		id: 'git.commit',
		title: localize('sidex.ui.commit.82a9c4', 'Commit')
	};

	private readonly _mergeGroup: TauriGitResourceGroup;
	private readonly _stagedGroup: TauriGitResourceGroup;
	private readonly _changesGroup: TauriGitResourceGroup;
	readonly groups: TauriGitResourceGroup[];
	private _historyProviderInstance: TauriGitHistoryProvider | undefined;

	private readonly _onDidChangeResourceGroups = new Emitter<void>();
	readonly onDidChangeResourceGroups: Event<void> = this._onDidChangeResourceGroups.event;

	private readonly _onDidChangeResources = new Emitter<void>();
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

	private _branch = '';

	constructor(
		rootUri: URI,
		modelService: IModelService,
		languageService: ILanguageService,
		private readonly uriIdentityService: IUriIdentityService,
		private readonly logService: ILogService
	) {
		super();

		this.rootUri = rootUri;
		this.id = `git:${rootUri.toString()}`;
		this.name = basename(rootUri) || 'Git';

		const inputUri = URI.from({ scheme: Schemas.vscodeSourceControl, path: `/${this.id}/input` });
		let model = modelService.getModel(inputUri);
		if (!model) {
			model = modelService.createModel('', languageService.createById('scminput'), inputUri);
		}
		this.inputBoxTextModel = model;

		this._mergeGroup = new TauriGitResourceGroup(
			'merge',
			localize('sidex.ui.mergeChanges.c08f87', 'Merge Changes'),
			this,
			uriIdentityService,
			true
		);
		this._stagedGroup = new TauriGitResourceGroup(
			'staged',
			localize('sidex.ui.stagedChanges.b5ff19', 'Staged Changes'),
			this,
			uriIdentityService,
			true
		);
		this._changesGroup = new TauriGitResourceGroup(
			'changes',
			localize('sidex.ui.changes.bbd4b6', 'Changes'),
			this,
			uriIdentityService,
			false
		);
		this.groups = [this._mergeGroup, this._stagedGroup, this._changesGroup];

		this._register(this._onDidChangeResourceGroups);
		this._register(this._onDidChangeResources);
		this._register(this._mergeGroup._onDidChange);
		this._register(this._mergeGroup._onDidChangeResources);
		this._register(this._stagedGroup._onDidChange);
		this._register(this._stagedGroup._onDidChangeResources);
		this._register(this._changesGroup._onDidChange);
		this._register(this._changesGroup._onDidChangeResources);
	}

	setupHistoryProvider(): void {
		this._historyProviderInstance = new TauriGitHistoryProvider(this.rootUri.fsPath, this.rootUri, this.logService);
		this._historyProvider.set(this._historyProviderInstance, undefined);

		this._historyProviderInstance._detectGitHubUrl().then(url => {
			(this as any)._historyProviderGitHubUrl = url;
		});
	}

	async getOriginalResource(uri: URI): Promise<URI | null> {
		const relPath = relativePath(this.rootUri, uri);
		if (!relPath) {
			return null;
		}
		return gitOriginalUri(uri, this.rootUri, 'INDEX');
	}

	async refresh(): Promise<void> {
		const rootPath = this.rootUri.fsPath;
		let status: TauriGitStatus | undefined;
		try {
			status = await invokeGit<TauriGitStatus>('git_status', { path: rootPath });
		} catch (err) {
			this.logService.warn('[TauriGit] git_status failed', err);
			return;
		}

		if (!status) {
			return;
		}

		this._branch = status.branch;

		if (this._historyProviderInstance) {
			try {
				const logEntries = await invokeGit<TauriGitLogEntry[]>('git_log', { path: rootPath, limit: 1 });
				const headHash = logEntries?.[0]?.hash;
				this._historyProviderInstance.updateRef(this._branch, headHash);
			} catch {
				this._historyProviderInstance.updateRef(this._branch);
			}
		}

		const mergeResources: ISCMResource[] = [];
		const stagedResources: ISCMResource[] = [];
		const changesResources: ISCMResource[] = [];

		const CONFLICT_XY_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
		const isConflictStatus = (status: string): boolean =>
			status === 'conflicted' || status === 'conflict' || CONFLICT_XY_CODES.has(status);

		for (const change of status.changes) {
			const fileUri = URI.joinPath(this.rootUri, change.path);
			if (isConflictStatus(change.status)) {
				mergeResources.push(
					new TauriGitResource(this._mergeGroup, fileUri, change.status, false, this.rootUri, change.original_path)
				);
			} else if (change.staged) {
				stagedResources.push(
					new TauriGitResource(this._stagedGroup, fileUri, change.status, true, this.rootUri, change.original_path)
				);
			} else {
				changesResources.push(
					new TauriGitResource(this._changesGroup, fileUri, change.status, false, this.rootUri, change.original_path)
				);
			}
		}

		this._mergeGroup.setResources(mergeResources);
		this._stagedGroup.setResources(stagedResources);
		this._changesGroup.setResources(changesResources);

		// Fire provider-level change events so the SCM view updates
		this._onDidChangeResources.fire();
		this._onDidChangeResourceGroups.fire();

		const total = mergeResources.length + stagedResources.length + changesResources.length;
		this._count.set(total, undefined);

		let ahead = 0;
		let behind = 0;
		try {
			const invoke = await getTauriInvoke();
			if (invoke) {
				const output = (
					(await invoke('git_run', {
						path: rootPath,
						args: ['rev-list', '--left-right', '--count', `HEAD...@{upstream}`]
					})) as string
				).trim();
				const parts = output.split(/\s+/);
				ahead = parseInt(parts[0], 10) || 0;
				behind = parseInt(parts[1], 10) || 0;
			}
		} catch {
			// No upstream configured or remote unreachable
		}

		this._statusBarCommands.set(
			[
				{
					id: 'git.checkoutTo',
					title: `$(git-branch) ${this._branch}${total > 0 ? '*' : ''}`,
					tooltip:
						total > 0
							? localize('git.branchModified', 'Branch: {0} (modified)', this._branch)
							: localize('git.branch', 'Branch: {0}', this._branch)
				},
				{
					id: 'git.sync',
					title: ahead > 0 || behind > 0 ? `$(sync) ${behind}$(arrow-down) ${ahead}$(arrow-up)` : '$(sync)',
					tooltip: localize('sidex.ui.synchronizeChanges.e8cd38', 'Synchronize Changes')
				}
			],
			undefined
		);

		if (total === 0 && ahead > 0) {
			const syncLabel =
				behind > 0
					? `$(sync) Sync Changes ${behind}$(arrow-down) ${ahead}$(arrow-up)`
					: `$(sync) Sync Changes ${ahead}$(arrow-up)`;
			this._actionButton.set(
				{
					command: { id: 'git.sync', title: syncLabel },
					secondaryCommands: [
						[
							{ id: 'git.sync', title: localize('sidex.ui.sync.8d261a', 'Sync') },
							{ id: 'git.push', title: localize('sidex.ui.push.731ce7', 'Push') },
							{ id: 'git.pull', title: localize('sidex.ui.pull.b66d04', 'Pull') }
						]
					],
					enabled: true
				},
				undefined
			);
		} else {
			this._actionButton.set(
				{
					command: { id: 'git.commit', title: localize('sidex.ui.checkCommit.9b345c', '$(check) Commit') },
					secondaryCommands: [
						[
							{ id: 'git.commit', title: localize('sidex.ui.commit.82a9c4', 'Commit') },
							{ id: 'git.commitAmend', title: localize('sidex.ui.commitAmend.200083', 'Commit (Amend)') }
						],
						[
							{ id: 'git.commitAndPush', title: localize('sidex.ui.commitPush.94e965', 'Commit & Push') },
							{ id: 'git.commitAndSync', title: localize('sidex.ui.commitSync.80ff7f', 'Commit & Sync') }
						]
					],
					enabled: true
				},
				undefined
			);
		}

		this._onDidChangeResources.fire();
	}
}

// ─── Git Decoration Colors ──────────────────────────────────────────────────

const gitDecorationModifiedFg = registerColor(
	'gitDecoration.modifiedResourceForeground',
	{ dark: '#E2C08D', light: '#895503', hcDark: '#E2C08D', hcLight: '#895503' },
	localize('sidex.ui.colorForModifiedGitResources.802f59', 'Color for modified git resources.')
);
const gitDecorationDeletedFg = registerColor(
	'gitDecoration.deletedResourceForeground',
	{ dark: '#c74e39', light: '#ad0707', hcDark: '#c74e39', hcLight: '#ad0707' },
	localize('sidex.ui.colorForDeletedGitResources.f4235b', 'Color for deleted git resources.')
);
const gitDecorationUntrackedFg = registerColor(
	'gitDecoration.untrackedResourceForeground',
	{ dark: '#73C991', light: '#007100', hcDark: '#73C991', hcLight: '#007100' },
	localize('sidex.ui.colorForUntrackedGitResources.e9a437', 'Color for untracked git resources.')
);
const gitDecorationAddedFg = registerColor(
	'gitDecoration.addedResourceForeground',
	{ dark: '#81b88b', light: '#587c0c', hcDark: '#a1e3ad', hcLight: '#374e06' },
	localize('sidex.ui.colorForAddedGitResources.fb0a65', 'Color for added git resources.')
);
const gitDecorationRenamedFg = registerColor(
	'gitDecoration.renamedResourceForeground',
	{ dark: '#73C991', light: '#007100', hcDark: '#73C991', hcLight: '#007100' },
	localize('sidex.ui.colorForRenamedGitResources.56e3dd', 'Color for renamed git resources.')
);
const _gitDecorationIgnoredFg = registerColor(
	'gitDecoration.ignoredResourceForeground',
	{ dark: '#8C8C8C', light: '#8E8E90', hcDark: '#A7A8A9', hcLight: '#8e8e90' },
	localize('sidex.ui.colorForIgnoredGitResources.e2bad5', 'Color for ignored git resources.')
);
const gitDecorationStageModifiedFg = registerColor(
	'gitDecoration.stageModifiedResourceForeground',
	{ dark: '#E2C08D', light: '#895503', hcDark: '#E2C08D', hcLight: '#895503' },
	localize('sidex.ui.colorForStagedModifiedGitResources.0e156d', 'Color for staged modified git resources.')
);
const gitDecorationStageDeletedFg = registerColor(
	'gitDecoration.stageDeletedResourceForeground',
	{ dark: '#c74e39', light: '#ad0707', hcDark: '#c74e39', hcLight: '#ad0707' },
	localize('sidex.ui.colorForStagedDeletedGitResources.870219', 'Color for staged deleted git resources.')
);
const gitDecorationConflictingFg = registerColor(
	'gitDecoration.conflictingResourceForeground',
	{ dark: '#e4676b', light: '#ad0707', hcDark: '#c74e39', hcLight: '#ad0707' },
	localize('sidex.ui.colorForConflictingGitResources.995352', 'Color for conflicting git resources.')
);
const _gitDecorationSubmoduleFg = registerColor(
	'gitDecoration.submoduleResourceForeground',
	{ dark: '#8db9e2', light: '#1258a7', hcDark: '#8db9e2', hcLight: '#1258a7' },
	localize('sidex.ui.colorForSubmoduleGitResources.2d4c89', 'Color for submodule git resources.')
);

// ─── Git File Decoration Provider ───────────────────────────────────────────

class TauriGitDecorationProvider implements IDecorationsProvider {
	readonly label = 'Git';

	private readonly _onDidChange = new Emitter<readonly URI[]>();
	readonly onDidChange: Event<readonly URI[]> = this._onDidChange.event;

	private _decorationMap = new Map<string, { status: string; staged: boolean }>();

	updateResources(resources: { uri: URI; status: string; staged: boolean }[]): void {
		const previousUris = new Set(this._decorationMap.keys());
		this._decorationMap.clear();
		const changedUris: URI[] = [];
		for (const r of resources) {
			const key = r.uri.toString();
			this._decorationMap.set(key, { status: r.status, staged: r.staged });
			previousUris.delete(key);
			changedUris.push(r.uri);
		}
		for (const removedKey of previousUris) {
			changedUris.push(URI.parse(removedKey));
		}
		this._onDidChange.fire(changedUris);
	}

	provideDecorations(uri: URI, _token: CancellationToken): IDecorationData | undefined {
		const entry = this._decorationMap.get(uri.toString());
		if (!entry) {
			return undefined;
		}
		switch (entry.status) {
			case 'modified':
				return {
					letter: 'M',
					color: entry.staged ? gitDecorationStageModifiedFg : gitDecorationModifiedFg,
					tooltip: entry.staged
						? localize('sidex.ui.indexModified.26f13b', 'Index Modified')
						: localize('sidex.ui.modified.e8ce5d', 'Modified'),
					strikethrough: false,
					bubble: true
				};
			case 'added':
			case 'new file':
				return {
					letter: 'A',
					color: gitDecorationAddedFg,
					tooltip: entry.staged
						? localize('sidex.ui.indexAdded.4bc49b', 'Index Added')
						: localize('sidex.ui.added.6b02e0', 'Added'),
					strikethrough: false,
					bubble: true
				};
			case 'deleted':
				return {
					letter: 'D',
					color: entry.staged ? gitDecorationStageDeletedFg : gitDecorationDeletedFg,
					tooltip: entry.staged
						? localize('sidex.ui.indexDeleted.606a5a', 'Index Deleted')
						: localize('sidex.ui.deleted.b48ff3', 'Deleted'),
					strikethrough: false,
					bubble: false
				};
			case 'renamed':
				return {
					letter: 'R',
					color: gitDecorationRenamedFg,
					tooltip: localize('sidex.ui.indexRenamed.0fab3d', 'Index Renamed'),
					strikethrough: false,
					bubble: true
				};
			case 'untracked':
				return {
					letter: 'U',
					color: gitDecorationUntrackedFg,
					tooltip: localize('sidex.ui.untracked.c7ba54', 'Untracked'),
					strikethrough: false,
					bubble: true
				};
			case 'conflict':
			case 'conflicted':
				return {
					letter: '!',
					color: gitDecorationConflictingFg,
					tooltip: localize('sidex.ui.conflict.014659', 'Conflict'),
					strikethrough: false,
					bubble: true
				};
			default:
				return undefined;
		}
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}

// ─── Workbench Contribution ─────────────────────────────────────────────────

class TauriGitContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.tauriGit';

	private _pollHandle: ReturnType<typeof setInterval> | undefined;

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IDecorationsService private readonly decorationsService: IDecorationsService,
		@IQuickInputService quickInputService: IQuickInputService
	) {
		super();
		(globalThis as any).__sidex_quickInputService = quickInputService;
		this._init();
	}

	private async _init(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;

		(window as any).__sidex_workspaceFolders = folders.map(f => f.uri.fsPath);

		if (folders.length === 0) {
			return;
		}

		const folderUri = folders[0].uri;
		if (folderUri.scheme !== Schemas.file) return;
		let rootPath: string;
		try {
			const discovered = await invokeGit<string | null>('git_repository_root', { path: folderUri.fsPath });
			if (!discovered) return;
			rootPath = discovered;
		} catch (error) {
			this.logService.warn('[TauriGit] Could not resolve repository root', error);
			return;
		}
		const rootUri = URI.file(rootPath);
		const originalProvider = new TauriGitOriginalFileProvider(rootPath);
		try {
			this._register(this.fileService.registerProvider(GIT_ORIGINAL_SCHEME, originalProvider));
		} catch {}

		let isRepo: boolean | undefined;
		try {
			isRepo = await invokeGit<boolean>('git_is_repo', { path: rootPath });
		} catch (err) {
			this.logService.info('[TauriGit] git_is_repo unavailable — Tauri backend not present', err);
			return;
		}

		if (!isRepo) {
			return;
		}

		const provider = new TauriGitSCMProvider(
			rootUri,
			this.modelService,
			this.languageService,
			this.uriIdentityService,
			this.logService
		);

		const repository = this.scmService.registerSCMProvider(provider);
		this._register(repository);
		this._register(provider);

		// Set the commit message placeholder
		repository.input.placeholder = localize(
			'git.commitMessage',
			'Message ({0}Enter to commit on "{1}")',
			isMacintosh ? '⌘' : 'Ctrl+',
			provider.name
		);

		this._registerDiffCommands(provider, rootPath);
		this._registerCommitCommand(provider, rootPath);

		provider.setupHistoryProvider();

		// Register git file decoration provider (letter badges: M, D, A, U, R)
		const gitDecoProvider = new TauriGitDecorationProvider();
		this._register(this.decorationsService.registerDecorationsProvider(gitDecoProvider));
		this._register(gitDecoProvider);

		const updateDecorations = () => {
			const allResources: { uri: URI; status: string; staged: boolean }[] = [];
			for (const group of provider.groups) {
				for (const resource of group.resources) {
					const tauriRes = resource as TauriGitResource;
					allResources.push({
						uri: tauriRes.sourceUri,
						status: tauriRes.statusLabel,
						staged: group.id === 'staged'
					});
				}
			}
			gitDecoProvider.updateResources(allResources);
		};

		provider.onDidChangeResources(updateDecorations);

		await provider.refresh();

		this._pollHandle = setInterval(() => provider.refresh(), 10000);
		this._register({
			dispose: () => {
				if (this._pollHandle !== undefined) {
					clearInterval(this._pollHandle);
					this._pollHandle = undefined;
				}
			}
		});
	}

	private _registerDiffCommands(provider: TauriGitSCMProvider, _rootPath: string): void {
		this._register(
			CommandsRegistry.registerCommand('git.openDiff', async (_accessor, ...args: any[]) => {
				try {
					const commandService = (globalThis as any).__sidex_commandService;
					if (!commandService) {
						return;
					}

					const resource = args[0];
					const sourceUri: URI | undefined = resource?.sourceUri ?? resource;
					if (!sourceUri) {
						return;
					}

					const originalUri =
						resource?.multiDiffEditorOriginalUri ?? gitOriginalUri(sourceUri, provider.rootUri, 'INDEX');
					const modifiedUri = resource?.multiDiffEditorModifiedUri ?? sourceUri;
					const fileName = basename(sourceUri);
					const title = localize('git.workingTreeTitle', '{0} (Working Tree)', fileName);

					await commandService.executeCommand('vscode.diff', originalUri, modifiedUri, title);
				} catch (err) {
					console.error('[TauriGit] open diff failed:', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.openChange', async (_accessor, ...args: any[]) => {
				try {
					const commandService = (globalThis as any).__sidex_commandService;
					if (!commandService) {
						return;
					}

					const resource = args[0];
					const sourceUri: URI | undefined = resource?.sourceUri ?? resource;
					if (!sourceUri) {
						return;
					}

					const originalUri =
						resource?.multiDiffEditorOriginalUri ?? gitOriginalUri(sourceUri, provider.rootUri, 'HEAD');
					const modifiedUri =
						resource?.multiDiffEditorModifiedUri ?? gitOriginalUri(sourceUri, provider.rootUri, 'INDEX');
					const fileName = basename(sourceUri);
					const title = localize('git.indexTitle', '{0} (Index)', fileName);

					await commandService.executeCommand('vscode.diff', originalUri, modifiedUri, title);
				} catch (err) {
					console.error('[TauriGit] open change failed:', err);
				}
			})
		);
	}

	private _registerCommitCommand(provider: TauriGitSCMProvider, rootPath: string): void {
		this._register(
			CommandsRegistry.registerCommand('git.commit', async () => {
				const message = provider.inputBoxTextModel.getValue();
				if (!message.trim()) {
					return;
				}
				try {
					const hash = await invokeGit<string>('git_commit', { path: rootPath, message });
					this.logService.info(`[TauriGit] Committed: ${hash}`);
					provider.inputBoxTextModel.setValue('');
					await provider.refresh();
				} catch (err) {
					this.logService.error('[TauriGit] commit failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.stageAll', async () => {
				try {
					await invokeGit('git_add', { path: rootPath, files: ['.'] });
					await provider.refresh();
				} catch (err) {
					this.logService.error('[TauriGit] stage all failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.refresh', async () => {
				await provider.refresh();
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.discardAll', async () => {
				try {
					const invoke = await getTauriInvoke();
					if (invoke) {
						await invoke('git_restore', {
							path: rootPath,
							files: ['.'],
							source: 'HEAD',
							staged: false,
							worktree: true
						});
						await invoke('git_clean', { path: rootPath, files: ['.'], dirs: true });
					}
					await provider.refresh();
				} catch (err) {
					this.logService.error('[TauriGit] discard all failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.openAllChanges', async () => {
				try {
					const commandService = (globalThis as any).__sidex_commandService;
					if (!commandService) {
						return;
					}
					const status = await invokeGit<TauriGitStatus>('git_status', { path: rootPath });
					if (!status) {
						return;
					}
					for (const change of status.changes) {
						const fileUri = URI.joinPath(provider.rootUri, change.path);
						if (change.status === 'untracked' || change.status === 'added') {
							await commandService.executeCommand('vscode.open', fileUri);
						} else {
							const originalUri = gitOriginalUri(fileUri, provider.rootUri, change.staged ? 'HEAD' : 'INDEX');
							const fileName = basename(fileUri);
							await commandService.executeCommand(
								'vscode.diff',
								originalUri,
								fileUri,
								localize('git.workingTreeTitle', '{0} (Working Tree)', fileName)
							);
						}
					}
				} catch (err) {
					console.error('[TauriGit] open all changes failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.stageFile', async (_accessor, ...args: any[]) => {
				try {
					const resource = args[0];
					const uri = resource?.sourceUri ?? resource;
					if (uri?.fsPath) {
						await invokeGit('git_add', { path: rootPath, files: [uri.fsPath] });
						await provider.refresh();
					}
				} catch (err) {
					console.error('[TauriGit] stage file failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.discardFile', async (_accessor, ...args: any[]) => {
				try {
					const resource = args[0];
					const uri: URI | undefined = resource?.sourceUri ?? resource;
					if (!uri?.fsPath) {
						return;
					}

					const status = (resource as any)?._status ?? '';
					const isUntracked = typeof status === 'string' && (status === 'untracked' || status.includes('?'));

					const relPath = uri.fsPath.startsWith(rootPath + '/')
						? uri.fsPath.substring(rootPath.length + 1)
						: uri.fsPath;

					const invoke = await getTauriInvoke();
					if (invoke) {
						if (isUntracked) {
							await invoke('git_clean', { path: rootPath, files: [relPath], dirs: false });
						} else {
							await invoke('git_restore', {
								path: rootPath,
								files: [relPath],
								source: null,
								staged: false,
								worktree: true
							});
						}
					}
					await provider.refresh();
				} catch (err) {
					console.error('[TauriGit] discard file failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.openFile', async (_accessor, ...args: any[]) => {
				try {
					const resource = args[0];
					const uri = resource?.sourceUri ?? resource;
					if (uri) {
						const commandService = (globalThis as any).__sidex_commandService;
						if (commandService) {
							const status = (resource as any)?._status;
							if (status && status !== 'untracked' && status !== 'added' && status !== 'deleted') {
								await commandService.executeCommand('git.openDiff', resource);
							} else {
								await commandService.executeCommand('vscode.open', uri);
							}
						}
					}
				} catch (err) {
					console.error('[TauriGit] open file failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.unstageFile', async (_accessor, ...args: any[]) => {
				try {
					const resource = args[0];
					const uri = resource?.sourceUri ?? resource;
					if (uri?.fsPath) {
						await invokeGit('git_reset', { path: rootPath, files: [uri.fsPath] });
						await provider.refresh();
					}
				} catch (err) {
					console.error('[TauriGit] unstage file failed', err);
				}
			})
		);

		this._register(
			CommandsRegistry.registerCommand('git.unstageAll', async () => {
				try {
					await invokeGit('git_reset', { path: rootPath, files: ['.'] });
					await provider.refresh();
				} catch (err) {
					console.error('[TauriGit] unstage all failed', err);
				}
			})
		);
	}
}

// Register git.init command globally so the "Initialize Repository" button works
CommandsRegistry.registerCommand('git.init', async () => {
	try {
		const invoke = await getTauriInvoke();
		if (!invoke) {
			return;
		}

		const { open } = await import('@tauri-apps/plugin-dialog');
		// Use the current workspace folder if available, otherwise ask
		const folders = (window as any).__sidex_workspaceFolders;
		let targetPath: string | undefined;

		if (folders && folders.length > 0) {
			targetPath = folders[0];
		} else {
			const selected = await open({
				directory: true,
				title: localize('sidex.ui.initializeGitRepository.232fb6', 'Initialize Git Repository')
			});
			if (selected && typeof selected === 'string') {
				targetPath = selected;
			}
		}

		if (!targetPath) {
			return;
		}

		await invoke('git_init', { path: targetPath });
		console.log('[TauriGit] Repository initialized at', targetPath);

		// Reload to pick up the new git repo
		window.location.reload();
	} catch (err) {
		console.error('[TauriGit] git init failed:', err);
	}
});

CommandsRegistry.registerCommand('git.copyToClipboard', async (_accessor, content: string) => {
	if (typeof content !== 'string') {
		return;
	}
	try {
		await navigator.clipboard.writeText(content);
	} catch {
		console.error('[TauriGit] clipboard write failed');
	}
});

CommandsRegistry.registerCommand('git.openOnGitHub', async (_accessor, remoteUrl: string, hash: string) => {
	try {
		const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
		if (!match) {
			return;
		}
		const commitUrl = `https://github.com/${match[1]}/commit/${hash}`;
		const openerService = (globalThis as any).__sidex_openerService;
		if (openerService) {
			await openerService.open(URI.parse(commitUrl), { openExternal: true });
		} else {
			window.open(commitUrl, '_blank');
		}
	} catch (err) {
		console.error('[TauriGit] open on GitHub failed:', err);
	}
});

registerWorkbenchContribution2(TauriGitContribution.ID, TauriGitContribution, WorkbenchPhase.BlockRestore);

// ─── Repository-level commands ──────────────────────────────────────────────

function getWorkspacePath(): string | undefined {
	const folders = (window as any).__sidex_workspaceFolders;
	return folders && folders.length > 0 ? folders[0] : undefined;
}

CommandsRegistry.registerCommand('git.pull', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const result = await invokeGit<string>('git_pull', { path });
		console.log('[TauriGit] pull:', result);
	} catch (err) {
		console.error('[TauriGit] pull failed:', err);
	}
});

CommandsRegistry.registerCommand('git.push', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const result = await invokeGit<string>('git_push', { path });
		console.log('[TauriGit] push:', result);
	} catch (err) {
		console.error('[TauriGit] push failed:', err);
	}
});

CommandsRegistry.registerCommand('git.fetch', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const result = await invokeGit<string>('git_fetch', { path });
		console.log('[TauriGit] fetch:', result);
	} catch (err) {
		console.error('[TauriGit] fetch failed:', err);
	}
});

async function doGitClone(): Promise<void> {
	try {
		const quickInputService = (globalThis as any).__sidex_quickInputService;
		if (!quickInputService) {
			return;
		}

		const url = await quickInputService.input({
			placeHolder: localize(
				'sidex.ui.repositoryUrlToCloneEGHttps.3b7f35',
				'Repository URL to clone (e.g. https://github.com/user/repo.git)'
			)
		});
		if (!url) {
			return;
		}

		const { open } = await import('@tauri-apps/plugin-dialog');
		const dest = await open({
			directory: true,
			title: localize('sidex.ui.chooseDestinationFolderForClone.0d7c33', 'Choose destination folder for clone')
		});
		if (!dest || typeof dest !== 'string') {
			return;
		}

		await invokeGit('git_clone', { url, path: dest });
		console.log('[TauriGit] cloned', url, 'to', dest);

		const newUrl = new URL(window.location.href);
		newUrl.searchParams.set('folder', URI.file(dest).toString());
		window.location.href = newUrl.toString();
	} catch (err) {
		console.error('[TauriGit] clone failed:', err);
	}
}

CommandsRegistry.registerCommand('git.clone', doGitClone);

CommandsRegistry.registerCommand('git.checkoutTo', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (!invoke) {
			return;
		}

		const quickInputService = (globalThis as any).__sidex_quickInputService;
		if (!quickInputService) {
			return;
		}

		// Get local branches
		let branchOutput = '';
		try {
			branchOutput = (
				(await invoke('git_run', {
					path,
					args: [
						'branch',
						'--format=%(refname:short)|%(objectname:short)|%(committerdate:relative)|%(authorname)|%(subject)'
					]
				})) as string
			).trim();
		} catch {
			/* no branches */
		}

		// Get remote branches
		let remoteOutput = '';
		try {
			remoteOutput = (
				(await invoke('git_run', {
					path,
					args: [
						'branch',
						'-r',
						'--format=%(refname:short)|%(objectname:short)|%(committerdate:relative)|%(authorname)|%(subject)'
					]
				})) as string
			).trim();
		} catch {
			/* no remotes */
		}

		const items: any[] = [];

		items.push({
			label: localize('sidex.ui.addCreateNewBranch.dfb0ab', '$(add) Create new branch...'),
			branch: '__create__',
			alwaysShow: true
		});
		items.push({
			label: localize('sidex.ui.addCreateNewBranchFrom.0e0645', '$(add) Create new branch from...'),
			branch: '__create_from__',
			alwaysShow: true
		});
		items.push({
			label: localize('sidex.ui.gitCompareCheckoutDetached.2389ec', '$(git-compare) Checkout detached...'),
			branch: '__detached__',
			alwaysShow: true
		});

		if (branchOutput) {
			items.push({ type: 'separator', label: localize('sidex.ui.branches.dce190', 'branches') });
			for (const line of branchOutput.split('\n')) {
				const parts = line.split('|');
				const name = parts[0] || '';
				if (!name) {
					continue;
				}
				items.push({
					label: `$(git-branch) ${name}`,
					description: parts[2] || '',
					detail: `${parts[3] || ''} • ${parts[1] || ''} • ${parts[4] || ''}`,
					branch: name
				});
			}
		}

		if (remoteOutput) {
			items.push({ type: 'separator', label: localize('sidex.ui.remoteBranches.4236af', 'remote branches') });
			for (const line of remoteOutput.split('\n')) {
				const parts = line.split('|');
				const name = parts[0] || '';
				if (!name || name.includes('HEAD')) {
					continue;
				}
				items.push({
					label: `$(cloud) ${name}`,
					description: parts[2] || '',
					detail: `${parts[3] || ''} • ${parts[1] || ''} • ${parts[4] || ''}`,
					branch: name
				});
			}
		}

		// Get tags
		let tagsOutput = '';
		try {
			tagsOutput = (
				(await invoke('git_run', {
					path,
					args: [
						'tag',
						'--sort=-creatordate',
						'--format=%(refname:short)|%(objectname:short)|%(creatordate:relative)|%(creatorname)|%(subject)'
					]
				})) as string
			).trim();
		} catch {
			/* no tags */
		}

		if (tagsOutput) {
			items.push({ type: 'separator', label: localize('sidex.ui.tags.978c2f', 'tags') });
			for (const line of tagsOutput.split('\n')) {
				const parts = line.split('|');
				const name = parts[0] || '';
				if (!name) {
					continue;
				}
				items.push({
					label: `$(tag) ${name}`,
					description: parts[2] || '',
					detail: `${parts[3] || ''} • ${parts[1] || ''} • ${parts[4] || ''}`,
					branch: name
				});
			}
		}

		const picked = await quickInputService.pick(items, {
			placeHolder: localize('sidex.ui.selectABranchOrTagToCheckout.037c1c', 'Select a branch or tag to checkout'),
			matchOnDescription: true,
			matchOnDetail: true
		});

		if (!picked || !picked.branch) {
			return;
		}

		if (picked.branch === '__create__') {
			const name = await quickInputService.input({
				placeHolder: localize('sidex.ui.branchName.06f6bb', 'Branch name')
			});
			if (!name) {
				return;
			}
			await invoke('git_run', { path, args: ['checkout', '-b', name] });
		} else if (picked.branch === '__create_from__') {
			const base = await quickInputService.input({
				placeHolder: localize('sidex.ui.baseBranchOrCommit.7bdcbe', 'Base branch or commit')
			});
			if (!base) {
				return;
			}
			const name = await quickInputService.input({
				placeHolder: localize('sidex.ui.newBranchName.514cee', 'New branch name')
			});
			if (!name) {
				return;
			}
			await invoke('git_run', { path, args: ['checkout', '-b', name, base] });
		} else if (picked.branch === '__detached__') {
			const ref = await quickInputService.input({
				placeHolder: localize('sidex.ui.commitHashTagOrRefToCheckout.673ccc', 'Commit hash, tag, or ref to checkout')
			});
			if (!ref) {
				return;
			}
			await invoke('git_run', { path, args: ['checkout', '--detach', ref] });
		} else {
			const branchName = picked.branch.replace(/^origin\//, '');
			await invoke('git_run', { path, args: ['checkout', branchName] });
		}

		window.location.reload();
	} catch (err) {
		console.error('[TauriGit] checkout failed:', err);
	}
});

CommandsRegistry.registerCommand('git.createBranch', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	const name = window.prompt(localize('sidex.ui.newBranchName.caee60', 'New branch name:'));
	if (!name) {
		return;
	}
	try {
		await invokeGit('git_create_branch', { path, name });
		console.log('[TauriGit] created branch', name);
	} catch (err) {
		console.error('[TauriGit] create branch failed:', err);
	}
});

CommandsRegistry.registerCommand('git.sync', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		await invokeGit<string>('git_pull', { path });
		await invokeGit<string>('git_push', { path });
		console.log('[TauriGit] sync complete');
	} catch (err) {
		console.error('[TauriGit] sync failed:', err);
	}
});

CommandsRegistry.registerCommand('git.stash', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['stash'] });
			console.log('[TauriGit] stash complete');
		}
	} catch (err) {
		console.error('[TauriGit] stash failed:', err);
	}
});

CommandsRegistry.registerCommand('git.stashPop', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['stash', 'pop'] });
			console.log('[TauriGit] stash pop complete');
		}
	} catch (err) {
		console.error('[TauriGit] stash pop failed:', err);
	}
});

CommandsRegistry.registerCommand('git.stashPopLatest', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['stash', 'pop', 'stash@{0}'] });
			console.log('[TauriGit] stash pop latest complete');
		}
	} catch (err) {
		console.error('[TauriGit] stash pop latest failed:', err);
	}
});

CommandsRegistry.registerCommand('git.commitAmend', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['commit', '--amend', '--no-edit'] });
			console.log('[TauriGit] commit amend complete');
		}
	} catch (err) {
		console.error('[TauriGit] commit amend failed:', err);
	}
});

CommandsRegistry.registerCommand('git.commitAndPush', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			const message = (window as any).__sidex_scmInputValue?.() || '';
			if (!message.trim()) {
				return;
			}
			await invoke('git_run', { path, args: ['commit', '-m', message] });
			await invokeGit<string>('git_push', { path });
			console.log('[TauriGit] commit & push complete');
		}
	} catch (err) {
		console.error('[TauriGit] commit & push failed:', err);
	}
});

CommandsRegistry.registerCommand('git.commitAndSync', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			const message = (window as any).__sidex_scmInputValue?.() || '';
			if (!message.trim()) {
				return;
			}
			await invoke('git_run', { path, args: ['commit', '-m', message] });
			await invokeGit<string>('git_pull', { path });
			await invokeGit<string>('git_push', { path });
			console.log('[TauriGit] commit & sync complete');
		}
	} catch (err) {
		console.error('[TauriGit] commit & sync failed:', err);
	}
});

CommandsRegistry.registerCommand('git.commitAll', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['add', '.'] });
			const message = (window as any).__sidex_scmInputValue?.() || '';
			if (!message.trim()) {
				return;
			}
			await invoke('git_run', { path, args: ['commit', '-m', message] });
			console.log('[TauriGit] commit all complete');
		}
	} catch (err) {
		console.error('[TauriGit] commit all failed:', err);
	}
});

CommandsRegistry.registerCommand('git.addRemote', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	const name = window.prompt(localize('sidex.ui.remoteName.821942', 'Remote name:'));
	if (!name) {
		return;
	}
	const url = window.prompt(localize('sidex.ui.remoteUrl.b37b6f', 'Remote URL:'));
	if (!url) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['remote', 'add', name, url] });
			console.log('[TauriGit] added remote', name);
		}
	} catch (err) {
		console.error('[TauriGit] add remote failed:', err);
	}
});

CommandsRegistry.registerCommand('git.removeRemote', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	const name = window.prompt(localize('sidex.ui.remoteNameToRemove.296a92', 'Remote name to remove:'));
	if (!name) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['remote', 'remove', name] });
			console.log('[TauriGit] removed remote', name);
		}
	} catch (err) {
		console.error('[TauriGit] remove remote failed:', err);
	}
});

CommandsRegistry.registerCommand('git.createTag', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	const name = window.prompt(localize('sidex.ui.tagName.1d7a72', 'Tag name:'));
	if (!name) {
		return;
	}
	const message = window.prompt(
		localize('sidex.ui.tagMessageLeaveEmptyForLightweightTag.1a2bf5', 'Tag message (leave empty for lightweight tag):')
	);
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			const args = message ? ['tag', '-a', name, '-m', message] : ['tag', name];
			await invoke('git_run', { path, args });
			console.log('[TauriGit] created tag', name);
		}
	} catch (err) {
		console.error('[TauriGit] create tag failed:', err);
	}
});

CommandsRegistry.registerCommand('git.deleteTag', async () => {
	const path = getWorkspacePath();
	if (!path) {
		return;
	}
	const name = window.prompt(localize('sidex.ui.tagNameToDelete.77e3a7', 'Tag name to delete:'));
	if (!name) {
		return;
	}
	try {
		const invoke = await getTauriInvoke();
		if (invoke) {
			await invoke('git_run', { path, args: ['tag', '-d', name] });
			console.log('[TauriGit] deleted tag', name);
		}
	} catch (err) {
		console.error('[TauriGit] delete tag failed:', err);
	}
});

CommandsRegistry.registerCommand('git.showOutput', async () => {
	try {
		const commandService = (globalThis as any).__sidex_commandService;
		if (commandService) {
			await commandService.executeCommand('workbench.action.output.toggleOutput');
		}
	} catch (err) {
		console.error('[TauriGit] show output failed:', err);
	}
});

// ─── SCM Source Control ("...") menu items ──────────────────────────────────
// All menu registrations below are provided solely by the Rust-native
// TauriGit implementation — the Node.js extensions/git is disabled.

const SCMGitCommitMenu = new MenuId('SCMGitCommit');
const SCMGitChangesMenu = new MenuId('SCMGitChanges');
const SCMGitPullPushMenu = new MenuId('SCMGitPullPush');
const SCMGitBranchMenu = new MenuId('SCMGitBranch');
const SCMGitRemoteMenu = new MenuId('SCMGitRemote');
const SCMGitStashMenu = new MenuId('SCMGitStash');
const SCMGitTagsMenu = new MenuId('SCMGitTags');
const SCMRepoViewSortMenu = new MenuId('SCMRepoViewSort');

// View & Sort submenu
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: localize('sidex.ui.viewSort.ffe497', 'View & Sort'),
	submenu: SCMRepoViewSortMenu,
	group: '0_view&sort',
	order: 1
});
MenuRegistry.appendMenuItem(SCMRepoViewSortMenu, {
	command: {
		id: 'workbench.scm.action.setListViewMode',
		title: localize('sidex.ui.viewAsList.0e8f1a', 'View as List')
	},
	group: '1_viewmode',
	order: 1
});
MenuRegistry.appendMenuItem(SCMRepoViewSortMenu, {
	command: {
		id: 'workbench.scm.action.setTreeViewMode',
		title: localize('sidex.ui.viewAsTree.e97a9a', 'View as Tree')
	},
	group: '1_viewmode',
	order: 2
});

// Quick actions
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.pull', title: localize('sidex.ui.pull.b66d04', 'Pull') },
	group: '1_header',
	order: 1
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.push', title: localize('sidex.ui.push.731ce7', 'Push') },
	group: '1_header',
	order: 2
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.clone', title: localize('sidex.ui.clone.58cc99', 'Clone...') },
	group: '1_header',
	order: 3
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.checkoutTo', title: localize('sidex.ui.checkoutTo.eeee2f', 'Checkout to...') },
	group: '1_header',
	order: 4
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.fetch', title: localize('sidex.ui.fetch.cd7d61', 'Fetch') },
	group: '1_header',
	order: 5
});

// Submenus
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: localize('sidex.ui.commit.82a9c4', 'Commit'),
	submenu: SCMGitCommitMenu,
	group: '2_main',
	order: 1
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: localize('sidex.ui.changes.bbd4b6', 'Changes'),
	submenu: SCMGitChangesMenu,
	group: '2_main',
	order: 2
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: localize('sidex.ui.pullPush.33b9c2', 'Pull, Push'),
	submenu: SCMGitPullPushMenu,
	group: '2_main',
	order: 3
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: localize('sidex.ui.branch.52656e', 'Branch'),
	submenu: SCMGitBranchMenu,
	group: '2_main',
	order: 4
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: localize('sidex.ui.remote.ffa98e', 'Remote'),
	submenu: SCMGitRemoteMenu,
	group: '2_main',
	order: 5
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: localize('sidex.ui.stash.38bdfe', 'Stash'),
	submenu: SCMGitStashMenu,
	group: '2_main',
	order: 6
});
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	title: localize('sidex.ui.tags.133127', 'Tags'),
	submenu: SCMGitTagsMenu,
	group: '2_main',
	order: 7
});

// Footer
MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'git.showOutput', title: localize('sidex.ui.showGitOutput.c0316c', 'Show Git Output') },
	group: '3_footer',
	order: 1
});

// Navigation toolbar buttons (SCM title bar)
MenuRegistry.appendMenuItem(MenuId.SCMTitle, {
	command: { id: 'git.commit', title: localize('sidex.ui.commit.82a9c4', 'Commit'), icon: ThemeIcon.fromId('check') },
	group: 'navigation',
	order: 1
});
MenuRegistry.appendMenuItem(MenuId.SCMTitle, {
	command: {
		id: 'git.refresh',
		title: localize('sidex.ui.refresh.0e9161', 'Refresh'),
		icon: ThemeIcon.fromId('refresh')
	},
	group: 'navigation',
	order: 2
});

// Graph view toolbar buttons
MenuRegistry.appendMenuItem(MenuId.SCMHistoryTitle, {
	command: { id: 'git.fetch', title: localize('sidex.ui.fetch.cd7d61', 'Fetch'), icon: ThemeIcon.fromId('git-fetch') },
	group: 'navigation',
	order: 3
});
MenuRegistry.appendMenuItem(MenuId.SCMHistoryTitle, {
	command: { id: 'git.pull', title: localize('sidex.ui.pull.b66d04', 'Pull'), icon: ThemeIcon.fromId('repo-pull') },
	group: 'navigation',
	order: 4
});
MenuRegistry.appendMenuItem(MenuId.SCMHistoryTitle, {
	command: { id: 'git.push', title: localize('sidex.ui.push.731ce7', 'Push'), icon: ThemeIcon.fromId('repo-push') },
	group: 'navigation',
	order: 5
});

// ─── Commit submenu items ───────────────────────────────────────────────────
MenuRegistry.appendMenuItem(SCMGitCommitMenu, {
	command: { id: 'git.commit', title: localize('sidex.ui.commit.82a9c4', 'Commit') },
	group: '1_commit',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitCommitMenu, {
	command: { id: 'git.commitAll', title: localize('sidex.ui.commitAll.2ebfff', 'Commit All') },
	group: '1_commit',
	order: 2
});
MenuRegistry.appendMenuItem(SCMGitCommitMenu, {
	command: { id: 'git.commitAmend', title: localize('sidex.ui.commitAmend.200083', 'Commit (Amend)') },
	group: '2_amend',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitCommitMenu, {
	command: { id: 'git.commitAndPush', title: localize('sidex.ui.commitPush.94e965', 'Commit & Push') },
	group: '3_commitpush',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitCommitMenu, {
	command: { id: 'git.commitAndSync', title: localize('sidex.ui.commitSync.80ff7f', 'Commit & Sync') },
	group: '3_commitpush',
	order: 2
});

// ─── Changes submenu items ──────────────────────────────────────────────────
MenuRegistry.appendMenuItem(SCMGitChangesMenu, {
	command: { id: 'git.stageAll', title: localize('sidex.ui.stageAllChanges.13bd40', 'Stage All Changes') },
	group: 'changes',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitChangesMenu, {
	command: { id: 'git.unstageAll', title: localize('sidex.ui.unstageAllChanges.b412f0', 'Unstage All Changes') },
	group: 'changes',
	order: 2
});
MenuRegistry.appendMenuItem(SCMGitChangesMenu, {
	command: { id: 'git.discardAll', title: localize('sidex.ui.discardAllChanges.8a613e', 'Discard All Changes') },
	group: 'changes',
	order: 3
});

// ─── Pull, Push submenu items ───────────────────────────────────────────────
MenuRegistry.appendMenuItem(SCMGitPullPushMenu, {
	command: { id: 'git.sync', title: localize('sidex.ui.sync.8d261a', 'Sync') },
	group: '1_sync',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitPullPushMenu, {
	command: { id: 'git.pull', title: localize('sidex.ui.pull.b66d04', 'Pull') },
	group: '2_pull',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitPullPushMenu, {
	command: { id: 'git.push', title: localize('sidex.ui.push.731ce7', 'Push') },
	group: '3_push',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitPullPushMenu, {
	command: { id: 'git.fetch', title: localize('sidex.ui.fetch.cd7d61', 'Fetch') },
	group: '4_fetch',
	order: 1
});

// ─── Branch submenu items ───────────────────────────────────────────────────
MenuRegistry.appendMenuItem(SCMGitBranchMenu, {
	command: { id: 'git.createBranch', title: localize('sidex.ui.createBranch.c49edd', 'Create Branch...') },
	group: '1_branch',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitBranchMenu, {
	command: { id: 'git.checkoutTo', title: localize('sidex.ui.checkoutTo.eeee2f', 'Checkout to...') },
	group: '1_branch',
	order: 2
});

// ─── Stash submenu items ────────────────────────────────────────────────────
MenuRegistry.appendMenuItem(SCMGitStashMenu, {
	command: { id: 'git.stash', title: localize('sidex.ui.stash.38bdfe', 'Stash') },
	group: '1_stash',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitStashMenu, {
	command: { id: 'git.stashPopLatest', title: localize('sidex.ui.popLatestStash.b35192', 'Pop Latest Stash') },
	group: '2_pop',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitStashMenu, {
	command: { id: 'git.stashPop', title: localize('sidex.ui.popStash.230e17', 'Pop Stash...') },
	group: '2_pop',
	order: 2
});

// ─── Remote submenu items ───────────────────────────────────────────────────
MenuRegistry.appendMenuItem(SCMGitRemoteMenu, {
	command: { id: 'git.addRemote', title: localize('sidex.ui.addRemote.25e69a', 'Add Remote...') },
	group: 'remote',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitRemoteMenu, {
	command: { id: 'git.removeRemote', title: localize('sidex.ui.removeRemote.b0ab9a', 'Remove Remote...') },
	group: 'remote',
	order: 2
});

// ─── Tags submenu items ─────────────────────────────────────────────────────
MenuRegistry.appendMenuItem(SCMGitTagsMenu, {
	command: { id: 'git.createTag', title: localize('sidex.ui.createTag.6a4e54', 'Create Tag...') },
	group: 'tags',
	order: 1
});
MenuRegistry.appendMenuItem(SCMGitTagsMenu, {
	command: { id: 'git.deleteTag', title: localize('sidex.ui.deleteTag.b5afd2', 'Delete Tag...') },
	group: 'tags',
	order: 2
});

// Buttons on the "Changes" group header
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: {
		id: 'git.stageAll',
		title: localize('sidex.ui.stageAllChanges.13bd40', 'Stage All Changes'),
		icon: ThemeIcon.fromId('add')
	},
	group: 'inline',
	order: 3,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: {
		id: 'git.discardAll',
		title: localize('sidex.ui.discardAllChanges.8a613e', 'Discard All Changes'),
		icon: ThemeIcon.fromId('discard')
	},
	group: 'inline',
	order: 2,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: {
		id: 'git.openAllChanges',
		title: localize('sidex.ui.openChanges.530178', 'Open Changes'),
		icon: ThemeIcon.fromId('diff-multiple')
	},
	group: 'inline',
	order: 1,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes')
});

// Buttons on the "Staged Changes" group header
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: {
		id: 'git.unstageAll',
		title: localize('sidex.ui.unstageAllChanges.b412f0', 'Unstage All Changes'),
		icon: ThemeIcon.fromId('remove')
	},
	group: 'inline',
	order: 2,
	when: ContextKeyExpr.equals('scmResourceGroup', 'staged')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: {
		id: 'git.openAllChanges',
		title: localize('sidex.ui.openStagedChanges.69e049', 'Open Staged Changes'),
		icon: ThemeIcon.fromId('diff-multiple')
	},
	group: 'inline',
	order: 1,
	when: ContextKeyExpr.equals('scmResourceGroup', 'staged')
});

// Register buttons on individual changed files (stage, discard, open)
// Buttons on unstaged files: Open File, Discard, Stage
MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: {
		id: 'git.stageFile',
		title: localize('sidex.ui.stageChanges.9061f7', 'Stage Changes'),
		icon: ThemeIcon.fromId('add')
	},
	group: 'inline',
	order: 3,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: {
		id: 'git.discardFile',
		title: localize('sidex.ui.discardChanges.e07e05', 'Discard Changes'),
		icon: ThemeIcon.fromId('discard')
	},
	group: 'inline',
	order: 2,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: {
		id: 'git.openFile',
		title: localize('sidex.ui.openFile.1e8d18', 'Open File'),
		icon: ThemeIcon.fromId('go-to-file')
	},
	group: 'inline',
	order: 1
});

// Buttons on staged files: Open File, Open Change, Unstage
MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: {
		id: 'git.unstageFile',
		title: localize('sidex.ui.unstageChanges.eb7f3c', 'Unstage Changes'),
		icon: ThemeIcon.fromId('remove')
	},
	group: 'inline',
	order: 3,
	when: ContextKeyExpr.equals('scmResourceGroup', 'staged')
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: {
		id: 'git.openChange',
		title: localize('sidex.ui.openChange.14ea1d', 'Open Change'),
		icon: ThemeIcon.fromId('git-compare')
	},
	group: 'inline',
	order: 1,
	when: ContextKeyExpr.equals('scmResourceGroup', 'staged')
});
