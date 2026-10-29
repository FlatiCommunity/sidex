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
	const { hasNonLocalWorkspace } = await loadTypeScript('src/vs/platform/remote/common/nativeWorkspace.ts');
	try {
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
	}
});
