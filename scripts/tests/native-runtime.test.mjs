import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadTypeScript(relativePath, key = '') {
	const source = await readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
	const compiled = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
	}).outputText;
	return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${key}`);
}

const { TerminalEventBuffer } = await loadTypeScript(
	'src/vs/workbench/contrib/terminal/browser/terminalEventBuffer.ts'
);

test('a shell may print and exit before spawn resolves without losing output', () => {
	const trace = [];
	const events = new TerminalEventBuffer(
		'one',
		data => trace.push(data),
		code => trace.push({ exit: code })
	);
	events.data({ client_id: 'two', terminal_id: 7, data: 'other terminal' });
	events.data({ client_id: 'one', terminal_id: 9, data: 'Привет 🦀\r\n' });
	events.data({ client_id: 'one', terminal_id: 9, data: '$ ' });
	events.exit({ client_id: 'one', terminal_id: 9, exit_code: 42 });
	assert.deepEqual(trace, []);
	trace.push('ready');
	events.attach(9);
	assert.deepEqual(trace, ['ready', 'Привет 🦀\r\n', '$ ', { exit: 42 }]);
});

test('terminal ownership remains distinct after attachment and teardown drops pending output', () => {
	const trace = [];
	const events = new TerminalEventBuffer(
		'one',
		data => trace.push(data),
		() => {}
	);
	events.attach(9);
	events.data({ client_id: 'two', terminal_id: 9, data: 'wrong owner' });
	events.data({ terminal_id: 9, data: 'legacy matching event' });
	events.data({ terminal_id: 10, data: 'wrong id' });
	assert.deepEqual(trace, ['legacy matching event']);
	events.dispose();
	events.data({ client_id: 'one', terminal_id: 9, data: 'late data' });
	assert.deepEqual(trace, ['legacy matching event']);

	const cancelled = new TerminalEventBuffer(
		'cancelled',
		data => trace.push(data),
		() => {}
	);
	cancelled.data({ client_id: 'cancelled', terminal_id: 11, data: 'buffered' });
	cancelled.dispose();
	cancelled.attach(11);
	assert.deepEqual(trace, ['legacy matching event']);
});

test('native bridge detects Tauri 2 internals without withGlobalTauri', async () => {
	const previous = globalThis.window;
	const calls = [];
	globalThis.window = {
		__TAURI_INTERNALS__: {
			invoke(command, args) {
				calls.push([command, args]);
				return Promise.resolve({ ok: true });
			}
		}
	};
	try {
		const bridge = await loadTypeScript('src/vs/sidex-bridge.ts', 'tauri2');
		assert.equal(bridge.isTauri(), true);
		assert.deepEqual(await bridge.invoke('theme_get', { name: 'Quiet Light' }), { ok: true });
		assert.deepEqual(calls, [['theme_get', { name: 'Quiet Light' }]]);
	} finally {
		globalThis.window = previous;
	}
});

test('native bridge reports unavailable runtime instead of a successful null response', async () => {
	const previous = globalThis.window;
	globalThis.window = {};
	try {
		const bridge = await loadTypeScript('src/vs/sidex-bridge.ts', 'browser');
		assert.equal(bridge.isTauri(), false);
		await assert.rejects(bridge.invoke('read_file'), /native Tauri runtime is unavailable/);
	} finally {
		globalThis.window = previous;
	}
});

test('WSL terminals keep distro and Linux cwd as literal arguments', async () => {
	const { wslTerminalLaunch } = await loadTypeScript('src/vs/platform/remote/common/nativeWorkspace.ts');
	const workspace = { scheme: 'sidex-wsl', authority: 'Ubuntu Test', path: '/home/me/a b;$(touch nope)' };
	assert.deepEqual(wslTerminalLaunch(workspace, 'C:\\Users\\me'), {
		executable: 'wsl.exe',
		args: ['--distribution', 'Ubuntu Test', '--cd', workspace.path],
		cwd: workspace.path
	});
	assert.deepEqual(wslTerminalLaunch(workspace, '/tmp/中文').args, [
		'--distribution', 'Ubuntu Test', '--cd', '/tmp/中文'
	]);
});

test('virtual workspace identity prevents local agent tools from using remote paths', async () => {
	const previous = globalThis.__SIDEX_WORKSPACE__;
	const previousFolders = globalThis.__SIDEX_WORKSPACE_FOLDERS__;
	const { hasNonLocalWorkspace } = await loadTypeScript('src/vs/platform/remote/common/nativeWorkspace.ts');
	try {
		delete globalThis.__SIDEX_WORKSPACE_FOLDERS__;
		delete globalThis.__SIDEX_WORKSPACE__;
		assert.equal(hasNonLocalWorkspace(), false);
		globalThis.__SIDEX_WORKSPACE__ = { scheme: 'file', authority: '', path: '/local' };
		assert.equal(hasNonLocalWorkspace(), false);
		globalThis.__SIDEX_WORKSPACE__ = { scheme: 'sidex-wsl', authority: 'Ubuntu', path: '/local' };
		assert.equal(hasNonLocalWorkspace(), true);
		globalThis.__SIDEX_WORKSPACE__ = { scheme: 'sidex-ssh', authority: 'host', path: '/local' };
		assert.equal(hasNonLocalWorkspace(), true);
	} finally {
		globalThis.__SIDEX_WORKSPACE__ = previous;
		globalThis.__SIDEX_WORKSPACE_FOLDERS__ = previousFolders;
	}
});

test('actual workspace folders override the local workspace file and update after folder changes', async () => {
	const previous = globalThis.__SIDEX_WORKSPACE__;
	const previousFolders = globalThis.__SIDEX_WORKSPACE_FOLDERS__;
	const { getNativeWorkspace, hasNonLocalWorkspace, setNativeWorkspaceFolders } = await loadTypeScript('src/vs/platform/remote/common/nativeWorkspace.ts');
	const local = { scheme: 'file', authority: '', path: '/same/path' };
	const remote = { scheme: 'sidex-ssh', authority: 'me@server:22', path: '/same/path' };
	try {
		globalThis.__SIDEX_WORKSPACE__ = { ...local, path: '/config/project.code-workspace' };
		setNativeWorkspaceFolders([remote]);
		assert.equal(hasNonLocalWorkspace(), true);
		assert.deepEqual(getNativeWorkspace(), remote);
		setNativeWorkspaceFolders([local, remote]);
		assert.equal(hasNonLocalWorkspace(), true, 'a remote secondary root must disable local workspace tools');
		setNativeWorkspaceFolders([local]);
		assert.equal(hasNonLocalWorkspace(), false);
		setNativeWorkspaceFolders([]);
		assert.equal(hasNonLocalWorkspace(), false);
		assert.equal(getNativeWorkspace(), undefined, 'removed folders must not fall back to a stale launch URI');
	} finally {
		globalThis.__SIDEX_WORKSPACE__ = previous;
		globalThis.__SIDEX_WORKSPACE_FOLDERS__ = previousFolders;
	}
});

async function loadClassMethods(path, className, names, dependencies) {
	const text = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
	assert.ok(declaration, `${className} exists`);
	const methods = declaration.members.filter(member => names.includes(member.name?.getText(source)));
	assert.equal(methods.length, names.length, 'exercise the real implementation methods');
	const compiled = ts.transpileModule(`class ${className} { ${methods.map(method => method.getText(source)).join('\n')} }\nreturn ${className};`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022 }
	}).outputText;
	return new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
}

test('terminal selection controls the host or distro in mixed and multi-host workspaces', async () => {
	const previous = globalThis.__SIDEX_WORKSPACE_FOLDERS__;
	const { getNativeWorkspace, setNativeWorkspaceFolders, wslTerminalLaunch } = await loadTypeScript('src/vs/platform/remote/common/nativeWorkspace.ts');
	const Backend = await loadClassMethods('src/vs/workbench/contrib/terminal/browser/tauriTerminalBackend.ts', 'TauriTerminalBackend', ['createProcess'], {
		getNativeWorkspace,
		wslTerminalLaunch,
		TauriPty: class {
			constructor(launch, cwd, cols, rows, env, authority) {
				Object.assign(this, { launch, cwd, cols, rows, env, authority });
			}
		}
	});
	const local = { scheme: 'file', authority: '', path: '/local/project' };
	const firstHost = { scheme: 'sidex-ssh', authority: 'me@first:22', path: '/first/project' };
	const secondHost = { scheme: 'sidex-ssh', authority: 'me@second:2222', path: '/second/project' };
	const wsl = { scheme: 'sidex-wsl', authority: 'Debian', path: '/home/me/project' };
	const environment = { LOCAL_ONLY: 'yes' };
	const backend = new Backend();
	const launch = (selected, cwd) => backend.createProcess(
		{ executable: 'bash' }, cwd, 80, 24, '11', environment,
		{ workspaceFolder: selected ? { uri: selected } : undefined }, false
	);
	try {
		setNativeWorkspaceFolders([firstHost, local, secondHost, wsl]);
		const second = await launch(secondHost, '/second/project');
		assert.equal(second.authority, 'me@second:2222');
		assert.equal(second.cwd, '/second/project');
		assert.equal(second.env, undefined, 'local environment must not leak into SSH');
		const native = await launch(local, '/local/project');
		assert.equal(native.authority, undefined);
		assert.equal(native.cwd, '/local/project');
		assert.equal(native.env, environment);
		const linux = await launch(wsl, '/home/me/project');
		assert.equal(linux.authority, undefined);
		assert.equal(linux.launch.executable, 'wsl.exe');
		assert.deepEqual(linux.launch.args, ['--distribution', 'Debian', '--cd', '/home/me/project']);
		setNativeWorkspaceFolders([local, secondHost]);
		assert.equal((await launch(secondHost, '/second/project')).authority, 'me@second:2222');
		setNativeWorkspaceFolders([firstHost, secondHost]);
		assert.equal((await launch(undefined, '/first/project')).authority, 'me@first:22', 'the first root is only a fallback when there is no selection');
	} finally {
		globalThis.__SIDEX_WORKSPACE_FOLDERS__ = previous;
	}
});

test('automatic indexing never converts virtual roots to local paths, including a pending settings read', async () => {
	const previous = globalThis.__SIDEX_WORKSPACE_FOLDERS__;
	const { hasNonLocalWorkspace, setNativeWorkspaceFolders } = await loadTypeScript('src/vs/platform/remote/common/nativeWorkspace.ts');
	const Service = await loadClassMethods('src/vs/workbench/contrib/sidexChat/browser/sidexChatService.ts', 'SidexChatService', ['workspacePath', '_triggerAutoIndex', '_runReindex'], {
		hasNonLocalWorkspace,
		window: { dispatchEvent() {} },
		CustomEvent
	});
	const calls = [];
	let finishSettings;
	Service._getTauriInvoke = () => (command, args) => {
		calls.push([command, args]);
		return command === 'settings_get' ? new Promise(resolve => { finishSettings = resolve; }) : Promise.resolve();
	};
	const service = new Service();
	const local = { scheme: 'file', authority: '', path: '/same/path', fsPath: '/same/path' };
	const remote = { scheme: 'sidex-ssh', authority: 'server', path: '/same/path', fsPath: '/same/path' };
	let folders = [{ uri: remote }];
	service.contextService = { getWorkspace: () => ({ folders }) };
	service._startReindexInterval = () => {};
	try {
		setNativeWorkspaceFolders([remote]);
		assert.equal(service.workspacePath, null);
		service._triggerAutoIndex();
		service._runReindex();
		assert.deepEqual(calls, []);
		folders = [{ uri: local }];
		setNativeWorkspaceFolders([local]);
		service._triggerAutoIndex();
		assert.equal(calls[0][0], 'settings_get');
		folders.push({ uri: remote });
		setNativeWorkspaceFolders([local, remote]);
		finishSettings(false);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(calls.length, 1, 'a changed workspace must cancel the pending local indexing');
		folders = [{ uri: local }];
		setNativeWorkspaceFolders([local]);
		service._runReindex();
		assert.deepEqual(calls.at(-1), ['index_build', { root: '/same/path' }]);
	} finally {
		globalThis.__SIDEX_WORKSPACE_FOLDERS__ = previous;
	}
});

test('project rules and chat diff reverts cannot invoke local writes from a virtual workspace', async () => {
	const previous = globalThis.__SIDEX_WORKSPACE_FOLDERS__;
	const previousInvoke = globalThis.__TAURI_INVOKE__;
	const { hasNonLocalWorkspace, setNativeWorkspaceFolders } = await loadTypeScript('src/vs/platform/remote/common/nativeWorkspace.ts');
	const dependencies = { hasNonLocalWorkspace, localize: (_key, message) => message };
	const RuleSection = await loadClassMethods('src/vs/workbench/contrib/sidexChat/browser/settings/sections/rulesSection.ts', 'RulesSection', ['_createNewRule', '_createNewSkill'], dependencies);
	const ToolItem = await loadClassMethods('src/vs/workbench/contrib/sidexChat/browser/components/tools/toolCallItem.ts', 'ToolCallItem', ['_invokeTool'], dependencies);
	const calls = [];
	const invoke = (command, args) => { calls.push([command, args]); return Promise.resolve(); };
	try {
		setNativeWorkspaceFolders([{ scheme: 'sidex-wsl', authority: 'Ubuntu', path: '/same/path' }]);
		globalThis.__TAURI_INVOKE__ = invoke;
		const rules = new RuleSection();
		rules._workspacePath = '/same/path';
		rules._activeTab = 'project';
		rules._invoke = invoke;
		rules._createNewRule();
		rules._createNewSkill();
		const item = new ToolItem();
		let error;
		item._showRevertError = message => { error = message; };
		item._invokeTool('edit_file', { path: '/same/path/file.ts' }, '/same/path/file.ts');
		assert.match(error, /remote workspace/);
		assert.deepEqual(calls, []);
	} finally {
		globalThis.__SIDEX_WORKSPACE_FOLDERS__ = previous;
		globalThis.__TAURI_INVOKE__ = previousInvoke;
	}
});

test('rules and skills use native directory arrays, absolute edit paths, and the write_file content argument', async () => {
	const previous = globalThis.__SIDEX_WORKSPACE_FOLDERS__;
	const { hasNonLocalWorkspace, setNativeWorkspaceFolders } = await loadTypeScript('src/vs/platform/remote/common/nativeWorkspace.ts');
	const Rules = await loadClassMethods('src/vs/workbench/contrib/sidexChat/browser/settings/sections/rulesSection.ts', 'RulesSection', ['_loadData', '_createNewRule', '_createNewSkill'], {
		hasNonLocalWorkspace,
		localize: (_key, message) => message,
		window: { dispatchEvent() {} },
		CustomEvent
	});
	const calls = [];
	const rules = new Rules();
	rules._workspacePath = '/local project';
	rules._userRulesPath = '/home/me/.sidex/rules';
	rules._activeTab = 'project';
	rules._renderDynamicContent = () => {};
	rules._invoke = async (command, args) => {
		calls.push([command, args]);
		if (command === 'read_dir') return [{ name: 'example.md', path: `${args.path}/example.md`, is_dir: false }];
		if (command === 'hooks_list') return [];
	};
	try {
		setNativeWorkspaceFolders([{ scheme: 'file', authority: '', path: '/local project' }]);
		await rules._loadData();
		assert.deepEqual(rules._rules.map(rule => [rule.id, rule.scope]), [
			['/local project/.sidex/rules/example.md', 'project'],
			['/home/me/.sidex/rules/example.md', 'user']
		]);
		assert.equal(rules._skills[0].id, '/local project/.sidex/skills/example.md');
		rules._createNewRule();
		rules._createNewSkill();
		rules._activeTab = 'user';
		rules._createNewRule();
		await new Promise(resolve => setImmediate(resolve));
		const writes = calls.filter(([command]) => command === 'write_file').map(([, args]) => args);
		assert.equal(writes.length, 3);
		assert.ok(writes.some(args => args.path.startsWith('/home/me/.sidex/rules/')));
		for (const args of writes) {
			assert.equal(typeof args.content, 'string');
			assert.ok(args.content.length > 0);
			assert.equal('contents' in args, false);
			assert.equal(args.path.includes('~'), false);
		}
	} finally {
		globalThis.__SIDEX_WORKSPACE_FOLDERS__ = previous;
	}
});
