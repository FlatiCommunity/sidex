import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const readSource = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;

async function loadModule(path, dependencies) {
	const module = { exports: {} };
	new Function('require', 'exports', 'module', compile(await readSource(path)))(name => {
		assert.ok(Object.hasOwn(dependencies, name), `mocked boundary: ${name}`);
		return dependencies[name];
	}, module.exports, module);
	return module.exports;
}

async function loadDeclarations(path, names, dependencies) {
	const source = ts.createSourceFile(path, await readSource(path), ts.ScriptTarget.Latest, true);
	const declarations = source.statements.filter(node => names.includes(node.name?.getText(source)) ||
		(ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.getText(source)))));
	assert.equal(declarations.length, names.length, 'execute original declarations, not a test copy');
	return new Function('exports', ...Object.keys(dependencies), compile(declarations.map(node => node.getText(source)).join('\n')) + `\nreturn { ${names.join(',')} };`)({}, ...Object.values(dependencies));
}

const localize = (_key, message) => message;
const localize2 = (_key, value) => ({ value, original: value });
const keyCodes = { KeyCode: { KeyW: 1, Equal: 2, Minus: 3, Numpad0: 4, Digit0: 5, NumpadAdd: 6, NumpadSubtract: 7, KeyZ: 8 }, KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 } };
const IConfigurationService = () => {};
const IHostService = Symbol('host');
const IOpenerService = Symbol('opener');
const IProductService = Symbol('product');

async function windowActions() {
	const actions = new Map();
	const contributions = new Map();
	const nativeZoom = [];
	const window = new EventTarget();
	window.document = { body: { style: {} } };
	const browserState = {};
	const exports = await loadModule('src/vs/workbench/browser/actions/sidexWindowActions.ts', {
		'../../../base/browser/dom.js': { getActiveWindow: () => window },
		'../../../base/browser/browser.js': { setZoomFactor: factor => { browserState.factor = factor; }, setZoomLevel: level => { browserState.level = level; } },
		'../../../base/common/keyCodes.js': keyCodes,
		'../../../base/common/lifecycle.js': { Disposable: class { _register(value) { return value; } } },
		'../../../base/common/uri.js': { URI: { parse: value => new URL(value) } },
		'../../../nls.js': { localize, localize2 },
		'../../../platform/action/common/actionCommonCategories.js': { Categories: { View: 'View', Help: 'Help' } },
		'../../../platform/actions/common/actions.js': { Action2: class { constructor(desc) { this.desc = desc; } }, MenuId: {}, registerAction2: Ctor => { const action = new Ctor(); actions.set(action.desc.id, action); } },
		'../../../platform/configuration/common/configuration.js': { ConfigurationTarget: { USER: 2 }, IConfigurationService },
		'../../../platform/configuration/common/configurationRegistry.js': { ConfigurationScope: {}, Extensions: {} },
		'../../../platform/keybinding/common/keybindingsRegistry.js': { KeybindingWeight: {} },
		'../../../platform/opener/common/opener.js': { IOpenerService },
		'../../../platform/product/common/productService.js': { IProductService },
		'../../../platform/registry/common/platform.js': { Registry: { as: () => ({ registerConfiguration() {} }) } },
		'../../../platform/window/common/window.js': { zoomLevelToZoomFactor: level => 1.2 ** level },
		'../../common/contributions.js': { WorkbenchPhase: {}, registerWorkbenchContribution2: (id, Ctor) => contributions.set(id, Ctor) },
		'../../services/host/browser/host.js': { IHostService },
		'@tauri-apps/api/webview': { getCurrentWebview: () => ({ setZoom: async factor => { nativeZoom.push(factor); } }) }
	});
	return { ...exports, actions, contributions, nativeZoom, browserState, window };
}

test('window zoom commands persist bounded settings and update the native webview through its capability', async () => {
	const previous = globalThis.__TAURI_INTERNALS__;
	globalThis.__TAURI_INTERNALS__ = {};
	try {
		const { normalizeWindowZoom, actions, contributions, nativeZoom, browserState } = await windowActions();
		assert.deepEqual([NaN, Infinity, '2', -40, 2.6, 40].map(normalizeWindowZoom), [0, 0, 0, -8, 3, 8]);
		let level = 0;
		let listener;
		const writes = [];
		const configuration = {
			getValue: () => level,
			onDidChangeConfiguration: handler => { listener = handler; return { dispose() {} }; },
			updateValue: async (key, value, target) => { writes.push([key, value, target]); level = value; listener({ affectsConfiguration: name => name === key }); }
		};
		const Zoom = contributions.get('workbench.contrib.nativeWindowZoom');
		const zoom = new Zoom(configuration);
		await zoom.pending;
		for (const name of ['zoomIn', 'zoomOut', 'zoomOut', 'zoomReset']) {
			await actions.get(`workbench.action.${name}`).run({ get: token => { assert.equal(token, IConfigurationService); return configuration; } });
			await zoom.pending;
		}
		assert.deepEqual(nativeZoom, [1, 1.2, 1, 1 / 1.2, 1]);
		assert.deepEqual(writes.map(([, value]) => value), [1, 0, -1, 0]);
		assert.ok(writes.every(([key, , target]) => key === 'window.zoomLevel' && target === 2));
		assert.deepEqual(browserState, { level: 0, factor: 1 });
		const capabilities = JSON.parse(await readSource('src-tauri/capabilities/default.json'));
		assert.ok(capabilities.permissions.includes('core:webview:allow-set-webview-zoom'));
	} finally {
		globalThis.__TAURI_INTERNALS__ = previous;
	}
});

test('close and Help commands reach the host lifecycle and fork links', async () => {
	const { actions } = await windowActions();
	let closed = 0;
	const links = [];
	const services = new Map([
		[IHostService, { close: async () => { closed++; } }],
		[IOpenerService, { open: async (uri, options) => { assert.equal(options.openExternal, true); links.push(uri.toString()); } }],
		[IProductService, { reportIssueUrl: 'https://github.com/naulbi-dump-projects/sidex/issues/new' }]
	]);
	for (const name of ['closeWindow', 'showWelcome', 'showReleaseNotes', 'openIssueReporter']) {
		await actions.get(`workbench.action.${name}`).run({ get: token => services.get(token) });
	}
	assert.equal(closed, 1);
	assert.deepEqual(links, ['https://github.com/naulbi-dump-projects/sidex#readme', 'https://github.com/naulbi-dump-projects/sidex/releases', 'https://github.com/naulbi-dump-projects/sidex/issues/new']);
});

test('native menu events dispatch previously missing commands, including before workbench startup', async () => {
	const window = new EventTarget();
	const calls = [];
	const { setupMenuActions } = await loadDeclarations('src/main.ts', ['setupMenuActions'], {
		window, CustomEvent,
		sidexOpenFolder: () => calls.push('open-folder-dialog'),
		require: path => { assert.equal(path, './vs/workbench/browser/web.factory.js'); return { commands: { executeCommand: async id => calls.push(id) } }; }
	});
	setupMenuActions();
	const expected = {
		open_file: 'workbench.action.files.openFile',
		open_folder: 'open-folder-dialog',
		open_recent: 'workbench.action.openRecent',
		close_folder: 'workbench.action.closeFolder',
		open_view: 'workbench.action.openView',
		reset_zoom: 'workbench.action.zoomReset',
		documentation: 'workbench.action.openDocumentationUrl',
		welcome: 'workbench.action.showWelcome',
		release_notes: 'workbench.action.showReleaseNotes',
		report_issue: 'workbench.action.openIssueReporter'
	};
	for (const [menu, command] of Object.entries(expected)) {
		window.dispatchEvent(new CustomEvent('sidex-native-menu', { detail: menu }));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(calls.at(-1), command, menu);
	}
	window.__sidex_commandService = { executeCommand: async id => calls.push(`ready:${id}`) };
	window.dispatchEvent(new CustomEvent('sidex-native-menu', { detail: 'close_window' }));
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(calls.at(-1), 'ready:workbench.action.closeWindow');
});

test('Alt+Z uses transient model state, synchronizes diffs, and leaves inline originals untouched', async () => {
	const ICodeEditorService = Symbol('editor');
	const IInstantiationService = Symbol('instantiation');
	const { ToggleWordWrapAction } = await loadDeclarations('src/vs/workbench/contrib/codeEditor/browser/toggleWordWrap.ts', ['transientWordWrapState', 'TOGGLE_WORD_WRAP_ID', 'writeTransientState', 'readTransientState', 'canToggleWordWrap', 'ToggleWordWrapAction'], {
		EditorAction: class { constructor(options) { this.options = options; } },
		ICodeEditorService, IInstantiationService,
		EditorOption: { wrappingInfo: 'wrappingInfo', inDiffEditor: 'inDiffEditor' },
		nls: { localize2 }, ...keyCodes,
		KeybindingWeight: {}, findDiffEditorContainingCodeEditor() {}
	});
	const state = new Map();
	const makeEditor = () => {
		const model = {};
		return { model, wrappingColumn: -1, getModel: () => model, getOption(key) { return key === 'wrappingInfo' ? { wrappingColumn: this.wrappingColumn } : Boolean(this.inDiff); } };
	};
	const original = makeEditor();
	const modified = makeEditor();
	let diff;
	let diffUpdates = 0;
	const editors = { getTransientModelProperty: model => state.get(model), setTransientModelProperty: (model, key, value) => { assert.equal(key, 'transientWordWrapState'); state.set(model, value); }, listDiffEditors: () => diff ? [diff] : [] };
	const accessor = { get: token => token === ICodeEditorService ? editors : { invokeFunction: () => diff } };
	const action = new ToggleWordWrapAction();
	assert.equal(action.options.id, 'editor.action.toggleWordWrap');
	assert.equal(action.options.kbOpts.primary, keyCodes.KeyMod.Alt | keyCodes.KeyCode.KeyZ);
	modified.wrappingColumn = 120;
	action.run(accessor, modified);
	assert.deepEqual(state.get(modified.model), { wordWrapOverride: 'off' });
	action.run(accessor, modified);
	assert.equal(state.get(modified.model), null, 'the second toggle restores configured or minified-file wrapping');
	diff = { getOriginalEditor: () => original, getModifiedEditor: () => modified, updateOptions: () => { diffUpdates++; }, renderSideBySide: true };
	original.inDiff = modified.inDiff = true;
	modified.wrappingColumn = -1;
	action.run(accessor, modified);
	assert.deepEqual(state.get(original.model), { wordWrapOverride: 'on' });
	assert.deepEqual(state.get(modified.model), state.get(original.model));
	assert.equal(diffUpdates, 1);
	diff.renderSideBySide = false;
	action.run(accessor, original);
	assert.deepEqual(state.get(original.model), { wordWrapOverride: 'on' });
	const bootstrap = await readSource('src/vs/workbench/workbench.common.main.ts');
	assert.match(bootstrap, /import ['"]\.\/contrib\/codeEditor\/browser\/toggleWordWrap\.js['"]/);
});

test('Open Workspace selects a code-workspace file and preserves native open-window options', async () => {
	const dialogs = [];
	const windows = [];
	let selection = '/home/me/project.code-workspace';
	const { FileDialogService } = await loadModule('src/vs/workbench/services/dialogs/browser/fileDialogService.ts', {
		'../../../../platform/dialogs/common/dialogs.js': {},
		'../../../../base/common/uri.js': { URI: { file: path => ({ scheme: 'file', path }) } },
		'../../../../platform/instantiation/common/extensions.js': { InstantiationType: {}, registerSingleton() {} },
		'./abstractFileDialogService.js': { AbstractFileDialogService: class {} },
		'../../../../base/common/network.js': { Schemas: { file: 'file' } },
		'../../../../nls.js': { localize },
		'@tauri-apps/plugin-dialog': { open: async options => { dialogs.push(options); return selection; } }
	});
	const service = new FileDialogService();
	service.hostService = { openWindow: async (...args) => { windows.push(args); } };
	await service.pickWorkspaceAndOpen({ forceNewWindow: true, defaultUri: { scheme: 'sidex-ssh', fsPath: '/remote/path' } });
	assert.deepEqual(dialogs[0], { directory: false, multiple: false, title: 'Open Workspace', defaultPath: undefined, filters: [{ name: 'Open Workspace', extensions: ['code-workspace'] }] });
	assert.deepEqual(windows[0], [[{ workspaceUri: { scheme: 'file', path: selection } }], { forceNewWindow: true, remoteAuthority: undefined }]);
	selection = null;
	await service.pickWorkspaceAndOpen({});
	assert.equal(windows.length, 1, 'cancel does not navigate or replace the current workspace');
});
