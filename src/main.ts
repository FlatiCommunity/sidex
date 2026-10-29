/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-based VSCode port
 *  Entry point. Globals set by inline script in index.html.
 *--------------------------------------------------------------------------------------------*/

import { loadNlsMessages } from './nls-loader.js';
import { initializeProductConfiguration } from './product-config.js';

async function sidexOpenFolder() {
	try {
		const { open } = await import('@tauri-apps/plugin-dialog');
		const { URI } = await import('./vs/base/common/uri.js');
		const selected = await open({ directory: true, multiple: false });
		if (selected && typeof selected === 'string') {
			navigateToFolder(URI.file(selected).toString());
		}
	} catch (e) {
		console.error('[SideX] Failed to open folder picker:', e);
	}
}
(window as any).__sidex_openFolder = sidexOpenFolder;

function navigateToFolder(folderUri: string) {
	const url = new URL(window.location.href);
	url.searchParams.set('folder', folderUri);
	url.searchParams.delete('workspace');
	url.searchParams.delete('payload');
	window.location.href = url.toString();
}

async function boot() {
	await initializeProductConfiguration();
	// Load locale translations before any VS Code module imports
	await loadNlsMessages();

	await Promise.all([
		import('./vs/workbench/workbench.common.main.js').catch(e => {
			console.error('[SideX] Barrel "common" failed:', e);
			throw e;
		}),
		import('./vs/workbench/browser/web.main.js').catch(e => {
			console.error('[SideX] Barrel "web.main" failed:', e);
			throw e;
		}),
		import('./vs/workbench/browser/parts/dialogs/dialog.web.contribution.js').catch(e => {
			console.error('[SideX] Barrel "web-dialog" failed:', e);
			throw e;
		}),
		import('./vs/workbench/workbench.web.main.js').catch(e => {
			console.error('[SideX] Barrel "web-services" failed:', e);
			throw e;
		})
	]);

	// SideX Rust bridge initialization — make services available before workbench creation
	if ((globalThis as any).__SIDEX_TAURI__) {
		const {
			SideXEditorBridge,
			SideXSyntaxService,
			SideXGitService,
			SideXSearchService,
			SideXSettingsService,
			SideXThemeService,
			SideXExtensionService,
			SideXKeymapService,
			SideXFileSystemProvider
		} = await import('./vs/platform/sidex/common/sidexServices.js');

		(globalThis as any).__SIDEX_SERVICES__ = {
			editor: SideXEditorBridge.getInstance(),
			syntax: new SideXSyntaxService(),
			git: new SideXGitService(),
			search: new SideXSearchService(),
			settings: new SideXSettingsService(),
			theme: new SideXThemeService(),
			extensions: new SideXExtensionService(),
			keymap: new SideXKeymapService(),
			fileSystem: new SideXFileSystemProvider()
		};

		console.log('[SideX] Rust bridge services initialized');
	}

	const { create, commands, env } = await import('./vs/workbench/browser/web.factory.js');
	const { URI } = await import('./vs/base/common/uri.js');

	if (document.readyState === 'loading') {
		await new Promise<void>(r => window.addEventListener('DOMContentLoaded', () => r()));
	}

	const urlParams = new URLSearchParams(window.location.search);
	const startupTargets: Array<{ path: string; kind: string; line?: number; column?: number }> = [];
	if ((globalThis as any).__TAURI_INTERNALS__) {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			startupTargets.push(...(await invoke<typeof startupTargets>('take_startup_targets')));
		} catch (error) {
			console.warn('[SideX] Could not read launch arguments:', error);
		}
	}
	const launchWorkspace = startupTargets.find(target => target.kind !== 'file');
	if (!urlParams.has('folder') && !urlParams.has('workspace') && launchWorkspace) {
		urlParams.set(launchWorkspace.kind, URI.file(launchWorkspace.path).toString());
		const startupUrl = new URL(window.location.href);
		startupUrl.search = urlParams.toString();
		window.history.replaceState(null, '', startupUrl);
	}
	const folderParam = urlParams.get('folder');
	const workspaceParam = urlParams.get('workspace');
	let workspacePayload: object | undefined;
	try {
		const payload = JSON.parse(urlParams.get('payload') ?? 'null');
		if (
			Array.isArray(payload) &&
			payload.every(
				entry => Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === 'string')
			)
		) {
			workspacePayload = payload;
		}
	} catch {
		/* Ignore malformed launch payloads. */
	}

	let workspace: any = undefined;
	if (folderParam) {
		const parsed = URI.parse(folderParam);
		if (['file', 'vscode-remote', 'vscode-vfs', 'sidex-wsl', 'sidex-ssh'].includes(parsed.scheme)) {
			workspace = { folderUri: parsed };
		}
	}

	if (workspaceParam) {
		const parsed = URI.parse(workspaceParam);
		if (['file', 'vscode-remote', 'vscode-vfs', 'sidex-wsl', 'sidex-ssh'].includes(parsed.scheme)) {
			workspace = { workspaceUri: parsed };
		}
	}

	const workspaceResource = workspace?.folderUri ?? workspace?.workspaceUri;
	(globalThis as any).__SIDEX_WORKSPACE__ = workspaceResource
		? { scheme: workspaceResource.scheme, authority: workspaceResource.authority, path: workspaceResource.path }
		: undefined;

	const options: any = {
		initialColorTheme: {
			themeType: 'dark',
			// Match the bundled Atom One Dark theme while the full theme service loads.
			colors: {
				'editor.background': '#282C34',
				'editor.foreground': '#ABB2BF',
				'sideBar.background': '#21252B',
				'activityBar.background': '#333842',
				'statusBar.background': '#21252B',
				'titleBar.activeBackground': '#21252B',
				'editorGroupHeader.tabsBackground': '#21252B',
				'tab.activeBackground': '#282C34',
				'tab.inactiveBackground': '#21252B'
			}
		},

		additionalTrustedDomains: ['https://github.com', 'https://*.github.com', 'https://*.githubusercontent.com'],

		// The workspace provider tells VSCode what folder/workspace to open
		workspaceProvider: {
			workspace,
			payload: workspacePayload,
			trusted: true,
			open: async (_workspace: any, _options: any) => {
				const reuseWindow = _options?.reuse === true;
				const targetUrl = new URL(window.location.href);
				targetUrl.searchParams.delete('folder');
				targetUrl.searchParams.delete('workspace');
				targetUrl.searchParams.delete('payload');
				if (_options?.payload) {
					targetUrl.searchParams.set('payload', JSON.stringify(_options.payload));
				}

				if (_workspace && 'folderUri' in _workspace) {
					targetUrl.searchParams.set('folder', _workspace.folderUri.toString());
				} else if (_workspace && 'workspaceUri' in _workspace) {
					targetUrl.searchParams.set('workspace', _workspace.workspaceUri.toString());
				} else {
					targetUrl.searchParams.delete('folder');
				}

				if (reuseWindow) {
					window.location.href = targetUrl.toString();
					return true;
				}

				try {
					const { invoke } = await import('@tauri-apps/api/core');
					const label = `sidex-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

					await invoke('create_window', {
						label,
						title: 'SideX',
						url: targetUrl.toString()
					});
					return true;
				} catch (error) {
					console.error('[SideX] Failed to open new window:', error);
					return false;
				}
			}
		},
		windowIndicator: {
			label: folderParam ? decodeURIComponent(folderParam.split('/').pop() || 'SideX') : 'SideX',
			tooltip: 'SideX — Tauri Code Editor',
			command: undefined
		},
		productConfiguration: {
			nameShort: 'SideX',
			nameLong: 'SideX',
			applicationName: 'sidex',
			dataFolderName: '.sidex',
			version: '1.110.0',
			linkProtectionTrustedDomains: ['https://github.com', 'https://*.github.com', 'https://*.githubusercontent.com']
		},
		settingsSyncOptions: {
			enabled: false
		},
		additionalBuiltinExtensions: [],
		configurationDefaults: {
			'workbench.startupEditor': 'welcomePage',
			'workbench.enableExperiments': false,
			'workbench.iconTheme': 'vs-seti',
			'workbench.colorTheme': 'Atom One Dark',
			'editor.experimentalGpuAcceleration': 'auto',
			'workbench.productIconTheme': 'Default',
			'workbench.editor.showTabs': 'multiple',
			'workbench.editor.enablePreview': false,
			'workbench.editor.tabCloseButton': 'right',
			'window.menuBarVisibility': navigator.userAgent.includes('Mac') ? 'hidden' : 'classic',
			'window.titleBarStyle': 'custom',
			'window.commandCenter': true,
			'scm.defaultViewMode': 'list',
			'telemetry.telemetryLevel': 'off',
			'update.mode': 'none',
			'update.showReleaseNotes': false,
			'extensions.autoUpdate': false,
			'extensions.autoCheckUpdates': false,
			'extensions.autoRestart': true,
			'workbench.settings.enableNaturalLanguageSearch': false,
			'chat.editor.enabled': false,
			'chat.commandCenter.enabled': false,
			'editor.bracketPairColorization.enabled': true,
			'editor.guides.bracketPairs': true,
			'editor.linkedEditing': true,
			'editor.suggest.showStatusBar': true,
			'editor.inlineSuggest.enabled': true,
			'editor.stickyScroll.enabled': true,
			'editor.minimap.enabled': false,
			'terminal.integrated.defaultProfile.osx': 'zsh',
			'terminal.integrated.defaultProfile.linux': 'bash',
			'terminal.integrated.profiles.osx': {
				zsh: { path: 'zsh', args: ['-l'] },
				bash: { path: 'bash', args: ['-l'], icon: 'terminal-bash' },
				fish: { path: 'fish', args: ['-l'] },
				tmux: { path: 'tmux', icon: 'terminal-tmux' },
				pwsh: { path: 'pwsh', icon: 'terminal-powershell' }
			},
			'terminal.integrated.profiles.linux': {
				bash: { path: 'bash', args: ['-l'], icon: 'terminal-bash' },
				zsh: { path: 'zsh', args: ['-l'] },
				fish: { path: 'fish', args: ['-l'] },
				tmux: { path: 'tmux', icon: 'terminal-tmux' },
				pwsh: { path: 'pwsh', icon: 'terminal-powershell' }
			},
			'terminal.integrated.enablePersistentSessions': false,
			'editor.formatOnPaste': false,
			'editor.renderWhitespace': 'selection',
			'editor.smoothScrolling': false,
			'editor.cursorBlinking': 'smooth',
			'editor.cursorSmoothCaretAnimation': 'off',
			'editor.mouseWheelZoom': true,
			'editor.wordWrap': 'off',
			'editor.suggest.preview': true,
			'editor.parameterHints.enabled': true,
			'editor.hover.enabled': true,
			'editor.folding': true,
			'editor.foldingImportsByDefault': true,
			'editor.showFoldingControls': 'mouseover',
			'editor.glyphMargin': true,
			'editor.lightbulb.enabled': 'on',
			'editor.colorDecorators': true,
			'editor.renderLineHighlight': 'all',
			'editor.matchBrackets': 'always',
			'editor.occurrencesHighlight': 'singleFile',
			'workbench.editor.highlightModifiedTabs': true,
			'workbench.tree.renderIndentGuides': 'always',
			'security.workspace.trust.startupPrompt': 'never',
			'security.workspace.trust.banner': 'never',
			'security.workspace.trust.enabled': false
		}
	};

	const workbenchContainer = document.getElementById('workbench');
	if (workbenchContainer) {
		create(workbenchContainer, options);
	} else {
		create(document.body, options);
	}

	setupTauriExternalOpener();
	setupMenuActions();
	setupWindowStateSave();
	setupNativePathEvents();
	for (const target of startupTargets) {
		if (target.kind === 'file') {
			void commands
				.executeCommand('vscode.open', URI.file(target.path), {
					preview: false,
					selection: target.line ? { startLineNumber: target.line, startColumn: target.column || 1 } : undefined
				})
				.catch(error => console.error('[SideX] Failed to open launch file:', error));
		} else if (target !== launchWorkspace) {
			const destination =
				target.kind === 'workspace' ? { workspaceUri: URI.file(target.path) } : { folderUri: URI.file(target.path) };
			void options.workspaceProvider.open(destination, { reuse: false });
		}
	}

	async function setupNativePathEvents() {
		if (!(globalThis as any).__TAURI_INTERNALS__) {
			return;
		}
		try {
			const { getCurrentWebview } = await import('@tauri-apps/api/webview');
			const unlisten = await getCurrentWebview().onDragDropEvent(async event => {
				if (event.payload.type === 'drop') {
					await env.getUriScheme(); // Resolves after the workbench installs its handlers.
					window.dispatchEvent(new CustomEvent('sidex-open-paths', { detail: { paths: event.payload.paths } }));
				}
			});
			window.addEventListener('beforeunload', unlisten, { once: true });
		} catch (error) {
			console.warn('[SideX] Could not initialize native file drop:', error);
		}
	}
	setupWindowsEditorNewlineKeybindings();
	updateNativeMenuLabels();

	console.log(
		'[SideX] Workbench created' + (folderParam ? ` (folder: ${folderParam})` : ' (no folder)'),
		'workspace:',
		workspace
	);
}

function setupTauriExternalOpener() {
	import('@tauri-apps/plugin-shell')
		.then(shell => {
			(window as any).__sidex_shellOpen = (url: string) => {
				shell.open(url).catch(() => {});
			};
		})
		.catch(() => {});
}

function setupWindowStateSave() {
	Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/window')])
		.then(([{ invoke }, { getCurrentWindow }]) => {
			const label = getCurrentWindow().label;
			let saveTimer: ReturnType<typeof setTimeout> | null = null;
			const debouncedSave = () => {
				if (saveTimer) {
					clearTimeout(saveTimer);
				}
				saveTimer = setTimeout(() => {
					invoke('save_window_state', { label }).catch(() => {});
				}, 500);
			};

			window.addEventListener('resize', debouncedSave);
			window.addEventListener('beforeunload', () => {
				invoke('save_window_state', { label }).catch(() => {});
			});
		})
		.catch(() => {});
}

function setupWindowsEditorNewlineKeybindings() {
	if (!navigator.userAgent.includes('Windows')) {
		return;
	}

	window.addEventListener('keydown', event => {
		if (event.defaultPrevented || event.key !== 'Enter' || !event.ctrlKey || event.altKey || event.metaKey) {
			return;
		}

		const target = event.target instanceof HTMLElement ? event.target : document.activeElement;
		if (!(target instanceof HTMLElement) || !target.closest('.monaco-editor')) {
			return;
		}

		const commandService = (
			window as { __sidex_commandService?: { executeCommand(commandId: string): Promise<unknown> } }
		).__sidex_commandService;
		if (!commandService) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();

		const commandId = event.shiftKey ? 'editor.action.insertLineBefore' : 'editor.action.insertLineAfter';
		commandService.executeCommand(commandId).catch(error => {
			console.error(`[SideX] Failed to execute ${commandId}:`, error);
		});
	});
}

function setupMenuActions() {
	const menuToCommand: Record<string, string> = {
		// File
		new_file: 'workbench.action.files.newUntitledFile',
		new_window: 'workbench.action.newWindow',
		open_file: 'workbench.action.files.openFile',
		open_folder: 'workbench.action.files.openFolder',
		save: 'workbench.action.files.save',
		save_as: 'workbench.action.files.saveAs',
		save_all: 'workbench.action.files.saveAll',
		close_editor: 'workbench.action.closeActiveEditor',
		close_window: 'workbench.action.closeWindow',
		// Edit
		find: 'actions.find',
		replace: 'editor.action.startFindReplaceAction',
		find_in_files: 'workbench.action.findInFiles',
		replace_in_files: 'workbench.action.replaceInFiles',
		// Selection
		expand_selection: 'editor.action.smartSelect.expand',
		shrink_selection: 'editor.action.smartSelect.shrink',
		copy_line_up: 'editor.action.copyLinesUpAction',
		copy_line_down: 'editor.action.copyLinesDownAction',
		move_line_up: 'editor.action.moveLinesUpAction',
		move_line_down: 'editor.action.moveLinesDownAction',
		add_cursor_above: 'editor.action.insertCursorAbove',
		add_cursor_below: 'editor.action.insertCursorBelow',
		select_all_occurrences: 'editor.action.selectHighlights',
		// View
		command_palette: 'workbench.action.showCommands',
		explorer: 'workbench.view.explorer',
		search: 'workbench.view.search',
		source_control: 'workbench.view.scm',
		debug: 'workbench.view.debug',
		extensions: 'workbench.view.extensions',
		problems: 'workbench.actions.view.problems',
		output: 'workbench.action.output.toggleOutput',
		terminal: 'workbench.action.terminal.toggleTerminal',
		debug_console: 'workbench.debug.action.toggleRepl',
		toggle_fullscreen: 'workbench.action.toggleFullScreen',
		zoom_in: 'workbench.action.zoomIn',
		zoom_out: 'workbench.action.zoomOut',
		reset_zoom: 'workbench.action.zoomReset',
		// Go
		back: 'workbench.action.navigateBack',
		forward: 'workbench.action.navigateForward',
		go_to_file: 'workbench.action.quickOpen',
		go_to_symbol: 'workbench.action.showAllSymbols',
		go_to_line: 'workbench.action.gotoLine',
		go_to_definition: 'editor.action.revealDefinition',
		go_to_references: 'editor.action.goToReferences',
		// Run
		start_debugging: 'workbench.action.debug.start',
		run_without_debugging: 'workbench.action.debug.run',
		stop_debugging: 'workbench.action.debug.stop',
		restart_debugging: 'workbench.action.debug.restart',
		toggle_breakpoint: 'editor.debug.action.toggleBreakpoint',
		// Terminal
		new_terminal: 'workbench.action.terminal.new',
		split_terminal: 'workbench.action.terminal.split',
		run_task: 'workbench.action.tasks.runTask',
		run_build_task: 'workbench.action.tasks.build',
		// Help
		keyboard_shortcuts: 'workbench.action.keybindingsEditor'
	};

	(window as any).__sidex_menu_action = async (menuId: string) => {
		if (menuId === 'open_folder') {
			sidexOpenFolder();
			return;
		}

		if (menuId === 'find') {
			const editorService = (window as any).__sidex_editorService;
			if (editorService?.activeEditor?.typeId === 'workbench.editors.webviewInput') {
				try {
					await (window as any).__sidex_commandService?.executeCommand('editor.action.webvieweditor.showFind');
				} catch {}
				return;
			}
		}

		const commandId = menuToCommand[menuId];
		if (!commandId) {
			console.warn(`[SideX] Unknown menu action: ${menuId}`);
			return;
		}
		try {
			const event = new CustomEvent('sidex-command', { detail: { commandId } });
			window.dispatchEvent(event);
		} catch (e) {
			console.error(`[SideX] Failed to execute menu command ${commandId}:`, e);
		}
	};

	// Native menu events arrive as CustomEvents from the Rust backend
	window.addEventListener('sidex-native-menu', ((e: CustomEvent) => {
		const menuId = e.detail;
		if (typeof menuId === 'string' && (window as any).__sidex_menu_action) {
			(window as any).__sidex_menu_action(menuId);
		}
	}) as EventListener);

	// Listen for command execution via keyboard shortcuts forwarded from native menu
	window.addEventListener('sidex-command', async (e: any) => {
		const commandId = e.detail?.commandId;
		if (!commandId) {
			return;
		}
		if (
			commandId === 'workbench.action.files.openFolder' ||
			commandId === 'workbench.action.files.openFolderViaWorkspace'
		) {
			sidexOpenFolder();
			return;
		}
		try {
			const commandService = (window as any).__sidex_commandService;
			if (commandService) {
				await commandService.executeCommand(commandId);
			} else {
				console.warn(`[SideX] Command service not ready, queuing: ${commandId}`);
			}
		} catch (err) {
			console.error(`[SideX] Command ${commandId} failed:`, err);
		}
	});
}

/**
 * After NLS translations are loaded into `_VSCODE_NLS_MESSAGES`, send
 * translated labels to the Rust side so the native macOS menu bar updates.
 */
async function updateNativeMenuLabels() {
	if (!(globalThis as any).__SIDEX_TAURI__) return;
	try {
		const [{ getNativeMenuLabels }, { invoke }] = await Promise.all([
			import('./vs/platform/sidex/common/nativeMenuLocalization.js'),
			import('@tauri-apps/api/core')
		]);
		await invoke('update_menu_labels', { labels: getNativeMenuLabels() });
	} catch (error) {
		console.warn('[SideX] Could not update native menu labels:', error);
	}
}

boot().catch(err => {
	console.error('[SideX] Fatal:', err);
	const container = document.createElement('div');
	container.style.cssText = 'padding:40px;color:#ccc;font-family:system-ui';
	const h2 = document.createElement('h2');
	h2.textContent = 'SideX failed to start';
	const pre = document.createElement('pre');
	pre.style.cssText = 'color:#f88;white-space:pre-wrap';
	pre.textContent = (err as Error)?.stack || String(err);
	container.append(h2, pre);
	document.body.replaceChildren(container);
});
