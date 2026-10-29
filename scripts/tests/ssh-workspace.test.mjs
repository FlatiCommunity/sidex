import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(entry) {
  const output = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false,
    plugins: [{ name: 'ssh-native-boundary', setup(build) {
      build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'tauri', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const invoke = (...args) => globalThis.__sshInvoke(...args);' }));
    } }]
  });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}
const { parseSshTarget } = await load('src/vs/platform/remote/common/sshTarget.ts');
const { TauriSshFileSystemProvider } = await load('src/vs/platform/files/browser/tauriSshFileSystemProvider.ts');
const { connectSshWorkspace } = await load('src/vs/workbench/contrib/remote/browser/sshWorkspace.ts');
const resource = (path, authority = 'alice@example.test:22') => ({ scheme: 'sidex-ssh', authority, path });

test('SSH destinations validate port range and support IPv6 without shell parsing', () => {
  assert.deepEqual(parseSshTarget('alice@example.test:2222'), { user: 'alice', host: 'example.test', port: 2222 });
  assert.deepEqual(parseSshTarget('alice@[2001:db8::1]:22'), { user: 'alice', host: '2001:db8::1', port: 22 });
  assert.deepEqual(parseSshTarget('example.test'), { user: undefined, host: 'example.test', port: 22 });
  for (const value of ['host:0', 'host:65536', 'user:password@host', 'host/path', 'host?query', 'bad host', 'user@host\nrm']) {
    assert.throws(() => parseSshTarget(value), undefined, value);
  }
});

test('SSH filesystem preserves binary bytes, write flags and remote path identity', async t => {
  const calls = [];
  globalThis.__sshInvoke = async (command, args) => { calls.push({ command, args }); return [0, 255, 195, 40]; };
  t.after(() => { delete globalThis.__sshInvoke; });
  const provider = new TauriSshFileSystemProvider();
  t.after(() => provider.dispose());
  assert.deepEqual(Array.from(await provider.readFile(resource('/srv/a b/$(literal)'))), [0, 255, 195, 40]);
  await provider.writeFile(resource('/srv/a b/$(literal)'), new Uint8Array([0, 255]), { create: false, overwrite: false });
  assert.equal(calls[0].command, 'remote_ssh_file_request');
  assert.equal(calls[0].args.authority, 'alice@example.test:22');
  assert.equal(calls[0].args.request.path, '/srv/a b/$(literal)');
  assert.deepEqual(calls[1].args.request, { data: [0, 255], create: false, overwrite: false, op: 'write', path: '/srv/a b/$(literal)' });
  await assert.rejects(provider.rename(resource('/one'), resource('/two', 'other@host:22'), { overwrite: true }));
  assert.equal(calls.length, 2);
});

test('SSH workspace uses configured HostName and opens an authenticated remote URI', async t => {
  const commands = [];
  globalThis.__sshInvoke = async (command, args) => {
    commands.push({ command, args });
    if (command === 'remote_ssh_probe_host') return { status: 'trusted', fingerprint: 'SHA256:test' };
    if (args.request.op === 'home') return '/home/alice';
    if (args.request.op === 'stat') return { type: 2 };
    throw new Error('unexpected request');
  };
  t.after(() => { delete globalThis.__sshInvoke; });
  let connected, opened;
  const remote = { connectSsh: async (...args) => { connected = args; return { id: 3, label: 'alice@actual.example:2222' }; }, disconnect: async () => {} };
  const input = { pick: async items => items.find(item => item.kind === 'agent'), input: async () => '/srv/project' };
  await connectSshWorkspace({ host: 'my-alias', hostname: 'actual.example', user: 'alice', port: 2222, identityFile: null }, input, remote, { openWindow: async (...args) => { opened = args; } });
  assert.deepEqual(connected.slice(0, 4), ['actual.example', 'alice', 2222, { kind: 'agent' }]);
  assert.equal(commands[0].args.host, 'actual.example');
  assert.equal(opened[0][0].folderUri.scheme, 'sidex-ssh');
  assert.equal(opened[0][0].folderUri.authority, 'alice@actual.example:2222');
  assert.equal(opened[0][0].folderUri.path, '/srv/project');
  assert.equal(opened[1].forceNewWindow, true);
});

test('unrecognized or changed host keys never send authentication without explicit trust', async t => {
  let authenticated = false;
  const remote = { connectSsh: async () => { authenticated = true; } };
  const target = { host: 'host', hostname: null, user: 'alice', port: 22, identityFile: null };
  globalThis.__sshInvoke = async () => ({ status: 'unknown', fingerprint: 'SHA256:new' });
  t.after(() => { delete globalThis.__sshInvoke; });
  await connectSshWorkspace(target, { pick: async items => items[0] }, remote, {});
  assert.equal(authenticated, false);
  globalThis.__sshInvoke = async () => ({ status: 'changed', fingerprint: 'SHA256:changed' });
  await assert.rejects(connectSshWorkspace(target, {}, remote, {}), /host key.*changed/);
  assert.equal(authenticated, false);
});
