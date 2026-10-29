/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname, resolvePath } from '../../../../base/common/resources.js';
import { escape } from '../../../../base/common/strings.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { asWebviewUri, webviewGenericCspSource } from '../../webview/common/webview.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ICodeEditor, isCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { TokenizationRegistry } from '../../../../editor/common/languages.js';
import { generateTokensCSSForColorMap } from '../../../../editor/common/languages/supports/tokenization.js';
import { ScrollType } from '../../../../editor/common/editorCommon.js';
import { localize } from '../../../../nls.js';
import { DEFAULT_MARKDOWN_STYLES, renderMarkdownDocument } from './markdownDocumentRenderer.js';
import { markdownPreviewScript, sourceLineMarkers } from './markdownPreviewContent.js';

const MARKDOWN_PREVIEW_VIEW_TYPE = 'sidex.markdown.preview';
const PREVIEW_OPEN_FILES_KEY = 'markdown.preview.openFiles';
const HAS_SCHEME = /^[\w+.-]+:/;

export function isMarkdownResource(resource: URI | undefined): resource is URI {
	return !!resource && /\.(?:md|markdown|mdown|mkdn|mkd|mdwn)$/i.test(resource.path);
}

function resolveMarkdownUri(baseDir: URI, href: string): URI {
	if (HAS_SCHEME.test(href)) {
		return URI.parse(href);
	}
	const relative = URI.parse(href);
	return resolvePath(baseDir, relative.path).with({ query: relative.query, fragment: relative.fragment });
}

function openFiles(storageService: IStorageService): string[] {
	try {
		const parsed: unknown = JSON.parse(storageService.get(PREVIEW_OPEN_FILES_KEY, StorageScope.WORKSPACE, '[]'));
		return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
	} catch {
		return [];
	}
}

export class MarkdownPreviewManager extends Disposable {
	static readonly ID = 'workbench.contrib.markdownPreview';
	private _webviewInput: WebviewInput | undefined;
	private readonly _previewDisposables = this._register(new DisposableStore());
	private readonly _sourceDisposables = this._register(new DisposableStore());
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _currentResource: URI | undefined;
	private _renderVersion = 0;
	private _lastPreviewLine = 1;
	private _ignoreEditorScrollUntil = 0;
	private _locked = false;

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IWebviewWorkbenchService private readonly _webviewWorkbenchService: IWebviewWorkbenchService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@ILogService private readonly _logService: ILogService,
		@IStorageService private readonly _storageService: IStorageService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IOpenerService private readonly _openerService: IOpenerService
	) {
		super();
		this._register(this._editorService.onDidVisibleEditorsChange(() => this._listenToSource()));
		this._register(
			this._editorService.onDidActiveEditorChange(() => {
				const resource = this._editorService.activeEditor?.resource;
				if (
					this._webviewInput &&
					!this._locked &&
					isMarkdownResource(resource) &&
					resource.toString() !== this._currentResource?.toString()
				) {
					this.showPreview(true, resource);
				}
			})
		);
		this._register(
			TokenizationRegistry.onDidChange(event => {
				if (event.changedColorMap) {
					void this.refresh();
				}
			})
		);
		this._register({ dispose: () => this._clearDebounceTimer() });
	}

	showPreview(side?: boolean, resource = this._editorService.activeEditor?.resource): void {
		if (!isMarkdownResource(resource)) {
			return;
		}
		if (this._currentResource?.toString() !== resource.toString()) {
			this._rememberOpen(false);
			this._lastPreviewLine = 1;
		}
		this._currentResource = resource;
		const title = this._title();
		const contentOptions = { allowScripts: true, localResourceRoots: [dirname(resource)] };
		if (!this._webviewInput) {
			this._webviewInput = this._webviewWorkbenchService.openWebview(
				{
					title,
					options: { enableFindWidget: true, retainContextWhenHidden: true },
					contentOptions,
					extension: undefined
				},
				MARKDOWN_PREVIEW_VIEW_TYPE,
				title,
				undefined,
				{ preserveFocus: true, group: side ? SIDE_GROUP : undefined }
			);
			this._previewDisposables.add(
				this._webviewInput.onWillDispose(() => {
					this._rememberOpen(false);
					this._clearDebounceTimer();
					this._renderVersion++;
					this._webviewInput = undefined;
					this._currentResource = undefined;
					this._sourceDisposables.clear();
					this._previewDisposables.clear();
				})
			);
			this._previewDisposables.add(
				this._webviewInput.webview.onMessage(event => {
					const message = event.message;
					if (message?.type === 'sidex.markdown.ready') {
						this._postEditorLine();
						return;
					}
					if (
						!Number.isFinite(message?.line) ||
						!['sidex.markdown.scroll', 'sidex.markdown.reveal'].includes(message?.type)
					) {
						return;
					}
					const model =
						this._currentResource && this._textFileService.files.get(this._currentResource)?.textEditorModel;
					this._lastPreviewLine = Math.max(1, Math.min(model?.getLineCount() ?? 1, Math.round(message.line)));
					this._ignoreEditorScrollUntil = Date.now() + 200;
					this._sourceEditor()?.revealLineNearTop(this._lastPreviewLine, ScrollType.Immediate);
					if (message.type === 'sidex.markdown.reveal') {
						void this.showSource();
					}
				})
			);
			this._previewDisposables.add(
				this._webviewInput.webview.onDidClickLink(href => {
					if (!this._currentResource || href.startsWith('#')) {
						return;
					}
					try {
						void this._openerService.open(resolveMarkdownUri(dirname(this._currentResource), href), {
							fromUserGesture: true,
							allowCommands: false
						});
					} catch (error) {
						this._logService.warn('[Markdown Preview] Invalid link', error);
					}
				})
			);
		} else {
			this._webviewInput.setWebviewTitle(title);
			this._webviewInput.webview.contentOptions = contentOptions;
		}
		this._rememberOpen(true);
		this._listenToSource();
		void this.refresh();
	}

	toggle(): void {
		this._webviewInput ? this._webviewInput.dispose() : this.showPreview();
	}
	hasActivePreview(): boolean {
		return !!this._webviewInput && !this._webviewInput.isDisposed();
	}
	static wasPreviewOpen(storageService: IStorageService, resource: URI): boolean {
		return openFiles(storageService).includes(resource.toString());
	}

	async showSource(): Promise<void> {
		if (this._currentResource) {
			await this._editorService.openEditor({
				resource: this._currentResource,
				options: { selection: { startLineNumber: this._lastPreviewLine, startColumn: 1 } }
			});
		}
	}

	toggleLock(): void {
		this._locked = !this._locked;
		this._webviewInput?.setWebviewTitle(this._title());
	}

	private _title(): string {
		const name = this._currentResource?.path.split('/').pop() || '';
		return this._locked
			? localize('markdown.previewLockedTitle', 'Preview (Locked): {0}', name)
			: localize('markdown.previewTitle', 'Preview: {0}', name);
	}

	private _sourceEditor(): ICodeEditor | undefined {
		for (const control of this._editorService.visibleTextEditorControls) {
			const editor = isCodeEditor(control) ? control : isDiffEditor(control) ? control.getModifiedEditor() : undefined;
			if (editor?.getModel()?.uri.toString() === this._currentResource?.toString()) {
				return editor;
			}
		}
		return undefined;
	}

	private _listenToSource(): void {
		this._sourceDisposables.clear();
		if (!this._currentResource) {
			return;
		}
		const resource = this._currentResource;
		const fileModel = this._textFileService.files.get(resource);
		if (fileModel?.isResolved()) {
			this._sourceDisposables.add(
				fileModel.textEditorModel.onDidChangeContent(() => {
					this._clearDebounceTimer();
					this._debounceTimer = setTimeout(() => {
						this._debounceTimer = undefined;
						void this.refresh();
					}, 200);
				})
			);
		} else {
			this._sourceDisposables.add(
				this._textFileService.files.onDidResolve(event => {
					if (event.model.resource.toString() === resource.toString()) {
						this._listenToSource();
					}
				})
			);
		}
		const editor = this._sourceEditor();
		if (editor) {
			this._sourceDisposables.add(
				editor.onDidScrollChange(event => {
					if (event.scrollTopChanged && Date.now() >= this._ignoreEditorScrollUntil) {
						this._postEditorLine();
					}
				})
			);
		}
	}

	private _postEditorLine(): void {
		const line = this._sourceEditor()?.getVisibleRanges()[0]?.startLineNumber ?? this._lastPreviewLine;
		void this._webviewInput?.webview.postMessage({ type: 'sidex.markdown.line', line });
	}

	async refresh(): Promise<void> {
		const resource = this._currentResource;
		const input = this._webviewInput;
		if (!resource || !input) {
			return;
		}
		const version = ++this._renderVersion;
		try {
			const model = await this._textFileService.files.resolve(resource);
			if (!model.isResolved()) {
				return;
			}
			const text = model.textEditorModel.getValue();
			const body = await renderMarkdownDocument(text, this._extensionService, this._languageService, {
				markedExtensions: [sourceLineMarkers(text)],
				sanitizerConfig: {
					allowRelativeLinkPaths: true,
					allowRelativeMediaPaths: true,
					allowedLinkProtocols: { override: ['http', 'https', 'mailto', 'file', resource.scheme] },
					allowedMediaProtocols: { override: ['http', 'https', 'data', 'file', resource.scheme] },
					allowedAttributes: { augment: ['data-source-line'] }
				}
			});
			if (version !== this._renderVersion || input.isDisposed()) {
				return;
			}
			const parsed = new DOMParser().parseFromString(body as unknown as string, 'text/html');
			for (const image of parsed.querySelectorAll('img[src]')) {
				const src = image.getAttribute('src')!;
				if (!/^(?:https?:|data:)/i.test(src)) {
					image.setAttribute('src', asWebviewUri(resolveMarkdownUri(dirname(resource), src)).toString());
				}
			}
			const nonce = generateUuid().replace(/-/g, '');
			const csp = `default-src 'none'; img-src ${webviewGenericCspSource} https: http: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';`;
			input.webview
				.setHtml(`<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${DEFAULT_MARKDOWN_STYLES}
${generateTokensCSSForColorMap(TokenizationRegistry.getColorMap() || [])}
body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
pre { background: var(--vscode-textCodeBlock-background); }
a { color: var(--vscode-textLink-foreground); }
blockquote { border-color: var(--vscode-textBlockQuote-border); background: var(--vscode-textBlockQuote-background); }
.sidex-source-line { display: block; height: 0; }
</style></head><body>${parsed.body.innerHTML}<script nonce="${nonce}">${markdownPreviewScript}</script></body></html>`);
			this._listenToSource();
		} catch (error) {
			this._logService.error('[Markdown Preview] Failed to render', error);
		}
	}

	private _rememberOpen(open: boolean): void {
		if (!this._currentResource) {
			return;
		}
		const uri = this._currentResource.toString();
		const files = openFiles(this._storageService).filter(entry => entry !== uri);
		if (open) {
			files.push(uri);
		}
		this._storageService.store(PREVIEW_OPEN_FILES_KEY, files, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private _clearDebounceTimer(): void {
		if (this._debounceTimer !== undefined) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = undefined;
		}
	}
}
