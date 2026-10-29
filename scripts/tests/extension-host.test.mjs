import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sidex-extension-host-'));
const originalStorage = process.env.SIDEX_GLOBAL_STORAGE_DIR;
process.env.SIDEX_GLOBAL_STORAGE_DIR = path.join(temporary, 'globalStorage');
const host = createRequire(import.meta.url)('../../src-tauri/extension-host/host.cjs');
after(() => {
  if (originalStorage === undefined) delete process.env.SIDEX_GLOBAL_STORAGE_DIR;
  else process.env.SIDEX_GLOBAL_STORAGE_DIR = originalStorage;
  fs.rmSync(temporary, { recursive: true, force: true });
});

let fixtureId = 0;
function fixture(t, extra, code, filename = 'extension.cjs') {
  const id = `test.fixture${++fixtureId}`;
  const location = path.join(temporary, id);
  fs.mkdirSync(location);
  const manifest = { publisher: 'test', name: `fixture${fixtureId}`, version: '1.0.0', main: filename, ...extra };
  fs.writeFileSync(path.join(location, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(location, filename), code);
  const loaded = host.handleMessage({ id: 1, type: 'loadExtension', params: { extensionPath: location } });
  assert.equal(loaded.result.extensionId, id);
  t.after(async () => {
    await host.handleMessage({ id: 2, type: 'deactivateExtension', params: { extensionId: id } });
    host._extensions.delete(id);
  });
  return { id, location };
}

test('contributed commands await slow activation and appear before activation', async t => {
  fixture(t, { contributes: { commands: [{ command: 'test.delayed', title: 'Delayed' }] } }, `
    const vscode = require('vscode');
    exports.activate = async context => {
      await new Promise(resolve => setTimeout(resolve, 160));
      context.subscriptions.push(vscode.commands.registerCommand('test.delayed', () => 42));
    };
  `);
  const state = host.handleMessage({ id: 2, type: 'getExtensionState' });
  assert.ok(state.result.commands.includes('test.delayed'));
  const result = await host.handleMessage({ id: 3, type: 'executeCommand', params: { command: 'test.delayed' } });
  assert.equal(result.result, 42);
});

test('deactivation invokes module lifecycle and disposes extension subscriptions', async t => {
  const f = fixture(t, {}, `
    const vscode = require('vscode');
    exports.activate = context => {
      context.subscriptions.push(vscode.commands.registerCommand('test.dispose', () => true));
      return { publicAPI: true };
    };
    exports.deactivate = async () => { await new Promise(resolve => setTimeout(resolve, 5)); exports.deactivated = true; };
  `);
  await host._activateExtension(f.id);
  const ext = host._extensions.get(f.id);
  assert.ok(host._commands.has('test.dispose'));
  await host.handleMessage({ id: 4, type: 'deactivateExtension', params: { extensionId: f.id } });
  assert.equal(ext.module.deactivated, true);
  assert.equal(host._commands.has('test.dispose'), false);
  assert.equal(ext.activated, false);
});

test('CommonJS language bundles are isolated by extension and honor comments and arguments', async t => {
  host._setLanguage('ru');
  const code = `const vscode = require('vscode'); exports.activate = () => ({ api: vscode });`;
  const a = fixture(t, { l10n: 'l10n' }, code);
  const b = fixture(t, { l10n: 'l10n' }, code);
  for (const [f, translated] of [[a, 'Привет, {name}!'], [b, 'Здравствуйте, {name}!']]) {
    fs.mkdirSync(path.join(f.location, 'l10n'));
    fs.writeFileSync(path.join(f.location, 'l10n/bundle.l10n.ru.json'), JSON.stringify({
      'Hello {name}': translated, 'Open {0}/verb': 'Открыть {0}',
    }));
  }
  const aa = await host._activateExtension(a.id);
  const bb = await host._activateExtension(b.id);
  assert.equal(aa.api.env.language, 'ru');
  assert.equal(aa.api.l10n.t('Hello {name}', { name: 'Иван' }), 'Привет, Иван!');
  assert.equal(bb.api.l10n.t('Hello {name}', { name: 'Иван' }), 'Здравствуйте, Иван!');
  assert.equal(aa.api.l10n.t({ message: 'Open {0}', comment: ['verb'], args: ['file'] }), 'Открыть file');
  assert.equal(aa.api.l10n.t('Missing {0}', 'fallback'), 'Missing fallback');
  assert.equal(aa.api.l10n.uri.scheme, 'file');
});

test('ES module extensions receive their own localized API without writing application resources', async t => {
  host._setLanguage('ru');
  const f = fixture(t, { l10n: 'l10n' }, `
    import { l10n, env } from 'vscode';
    export function activate() { return { value: l10n.t('Hello'), language: env.language }; }
  `, 'extension.mjs');
  fs.mkdirSync(path.join(f.location, 'l10n'));
  fs.writeFileSync(path.join(f.location, 'l10n/bundle.l10n.ru.json'), JSON.stringify({ Hello: 'Привет' }));
  const result = await host._activateExtension(f.id);
  assert.deepEqual(result, { value: 'Привет', language: 'ru' });
});

test('extension mementos persist, delete undefined keys, preserve null and isolate workspaces', async t => {
  const f = fixture(t, {}, 'exports.activate = () => {};');
  const ext = host._extensions.get(f.id);
  host._workspaceFolders = ['/workspace/first'];
  const first = host._createExtensionContext(f.id, ext);
  await first.globalState.update('keep', 12);
  await first.globalState.update('null', null);
  await first.globalState.update('delete', 'value');
  await first.globalState.update('delete', undefined);
  await first.workspaceState.update('local', 'first');
  const restored = host._createExtensionContext(f.id, ext);
  assert.equal(restored.globalState.get('keep'), 12);
  assert.equal(restored.globalState.get('null', 100), null);
  assert.equal(restored.globalState.get('delete', 100), 100);
  assert.equal(restored.workspaceState.get('local'), 'first');
  host._workspaceFolders = ['/workspace/second'];
  const other = host._createExtensionContext(f.id, ext);
  assert.equal(other.globalState.get('keep'), 12);
  assert.equal(other.workspaceState.get('local'), undefined);
  assert.ok(!first.globalStoragePath.startsWith(f.location));
});

test('module package .js entrypoints use the extension-specific ESM API', async t => {
  host._setLanguage('ru');
  const f = fixture(t, { type: 'module' }, `
    import { env } from 'vscode';
    export const activate = () => env.language;
  `, 'extension.js');
  assert.equal(await host._activateExtension(f.id), 'ru');
});

test('corrupt extension state is preserved before a new state is written', async t => {
  const f = fixture(t, {}, 'exports.activate = () => {};');
  const ext = host._extensions.get(f.id);
  const context = host._createExtensionContext(f.id, ext);
  const stateFile = path.join(context.globalStoragePath, 'state.json');
  fs.writeFileSync(stateFile, '{broken user data');
  const recovered = host._createExtensionContext(f.id, ext);
  await recovered.globalState.update('new', 42);
  const backup = fs.readdirSync(context.globalStoragePath).find(name => name.startsWith('state.json.corrupt.'));
  assert.equal(fs.readFileSync(path.join(context.globalStoragePath, backup), 'utf8'), '{broken user data');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { new: 42 });
});

test('extension dependencies activate before the dependent consumes their API', async t => {
  const dependency = fixture(t, {}, 'exports.activate = async () => { await new Promise(r => setTimeout(r, 20)); return { ready: true }; };');
  const dependent = fixture(t, { extensionDependencies: [dependency.id] }, `
    const vscode = require('vscode');
    exports.activate = () => vscode.extensions.getExtension(${JSON.stringify(dependency.id)}).exports.ready;
  `);
  assert.equal(await host._activateExtension(dependent.id), true);
  assert.equal(host._extensions.get(dependency.id).activated, true);
});

test('dependency cycles and missing dependencies fail without hanging or partial activation', async t => {
  const a = fixture(t, {}, 'exports.activate = () => true;');
  const b = fixture(t, { extensionDependencies: [a.id] }, 'exports.activate = () => true;');
  host._extensions.get(a.id).manifest.extensionDependencies = [b.id];
  await assert.rejects(host._activateExtension(a.id), /cyclic extension dependency/);
  host._extensions.get(a.id).manifest.extensionDependencies = ['missing.dependency'];
  await assert.rejects(host._activateExtension(a.id), /missing extension dependency/);
  assert.equal(host._extensions.get(a.id).activated, false);
  assert.equal(host._extensions.get(b.id).activated, false);
});

test('unloading removes commands and contribution state so uninstalled code cannot reactivate', async t => {
  const f = fixture(t, { contributes: { commands: [{ command: 'test.unload', title: 'Unload' }] } }, `
    const vscode = require('vscode');
    exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('test.unload', () => 1));
  `);
  await host._activateExtension(f.id);
  await host.handleMessage({ id: 1, type: 'unloadExtension', params: { extensionId: f.id } });
  assert.equal(host._extensions.has(f.id), false);
  assert.equal(host._commands.has('test.unload'), false);
  const state = host.handleMessage({ id: 2, type: 'getExtensionState' });
  assert.equal(state.result.commands.includes('test.unload'), false);
});
