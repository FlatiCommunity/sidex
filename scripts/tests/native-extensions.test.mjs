import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import vm from 'node:vm';

const fakeUri = path => ({ scheme: 'file', path, fsPath: path, toString() { return `file://${path}`; } });
const noop = () => {};
const generic = new Proxy(function () {}, { get: () => generic });
async function scannerModule(invoke) {
  const result = await build({
    entryPoints: ['src/vs/workbench/services/extensionManagement/browser/webExtensionsScannerService.ts'],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    plugins: [{ name: 'native-boundary', setup(build) {
      build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'tauri', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const invoke = globalThis.__invoke;' }));
      build.onResolve({ filter: /^\.\./ }, args => ({ path: args.path, external: true }));
    } }]
  });
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, console, __SIDEX_TAURI__: true, __invoke: invoke,
    require: () => new Proxy({
      Disposable: class {}, registerSingleton: noop,
      URI: { file: fakeUri },
      areSameExtensions: (a, b) => a.id.toLowerCase() === b.id.toLowerCase()
    }, { get: (target, key) => key in target ? target[key] : generic })
  };
  vm.runInNewContext(result.outputFiles[0].text, context);
  return Object.create(module.exports.WebExtensionsScannerService.prototype);
}

test('batch profile update preserves unrelated extensions and replaces matching IDs once', async () => {
  const scanner = await scannerModule(() => {});
  const make = id => ({ identifier: { id } });
  let entries = [make('pub.keep'), make('pub.old'), make('pub.other')];
  scanner.writeInstalledExtensions = async (_profile, update) => { entries = update(entries); };
  await scanner.addToInstalledExtensions([make('PUB.OLD'), make('pub.new')], fakeUri('/profile'));
  assert.deepEqual(Array.from(entries, entry => entry.identifier.id), ['pub.keep', 'pub.other', 'PUB.OLD', 'pub.new']);
  await scanner.addToInstalledExtensions([], fakeUri('/profile'));
  assert.equal(entries.length, 4);
});

test('failed native download cannot announce or record a successful gallery install', async () => {
  const scanner = await scannerModule(async () => { throw new Error('download failed'); });
  let recorded = false;
  scanner.addWebExtension = async () => { recorded = true; };
  await assert.rejects(scanner.addExtensionFromGallery({ assets: { download: { uri: 'https://registry.test/ext.vsix' } }, identifier: { id: 'pub.ext' } }, {}, fakeUri('/profile')), /download failed/);
  assert.equal(recorded, false);
});

test('native gallery installs register the installed file location after bytes reach disk', async () => {
  const calls = [];
  const scanner = await scannerModule(async (command, args) => {
    calls.push([command, args.expectedId]);
    return { path: '/extensions/pub.ext' };
  });
  scanner.toWebExtensionFromLocalResource = async (location, identifier, metadata) => {
    calls.push(['scan', location.fsPath]); return { location, identifier, metadata };
  };
  scanner.addWebExtension = async extension => { calls.push(['register', extension.location.scheme]); return extension; };
  const result = await scanner.addExtensionFromGallery({ assets: { download: { uri: 'https://registry.test/ext.vsix' } }, identifier: { id: 'pub.ext' } }, {}, fakeUri('/profile'));
  assert.equal(result.location.fsPath, '/extensions/pub.ext');
  assert.deepEqual(calls, [['install_extension_from_url', 'pub.ext'], ['scan', '/extensions/pub.ext'], ['register', 'file']]);
});

async function uninstallTask(invoke) {
  const filename = 'src/vs/workbench/services/extensionManagement/common/webExtensionManagementService.ts';
  const source = await readFile(filename, 'utf8');
  const result = await build({
    stdin: { contents: `${source}\nexport { UninstallExtensionTask };`, resolveDir: dirname(filename), loader: 'ts' },
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    bundle: true, format: 'cjs', platform: 'node', write: false,
    plugins: [{ name: 'native-uninstall-boundary', setup(build) {
      build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'tauri', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const invoke = globalThis.__invoke;' }));
      build.onResolve({ filter: /^\.{1,2}\// }, args => ({ path: args.path, external: true }));
    } }],
  });
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, console, __SIDEX_TAURI__: true, __invoke: invoke,
    require: () => new Proxy({
      AbstractExtensionManagementService: class {}, AbstractExtensionTask: class {}, registerSingleton: noop,
      IExtensionGalleryService: noop, ITelemetryService: noop, ILogService: noop, IWebExtensionsScannerService: noop,
      IExtensionManifestPropertiesService: noop, IUserDataProfileService: noop, IProductService: noop,
      IAllowedExtensionsService: noop, IUserDataProfilesService: noop, IUriIdentityService: noop,
      areSameExtensions: (a, b) => a.id.toLowerCase() === b.id.toLowerCase(),
    }, { get: (target, key) => key in target ? target[key] : generic }),
  };
  vm.runInNewContext(result.outputFiles[0].text, context);
  return Object.create(module.exports.UninstallExtensionTask.prototype);
}

test('uninstall removes application-scoped bytes instead of counting inherited profile entries as installations', async () => {
  const calls = [];
  const task = await uninstallTask(async (command, args) => { calls.push([command, args.extensionId]); });
  const defaultProfile = { extensionsResource: fakeUri('/default') };
  const otherProfile = { extensionsResource: fakeUri('/other') };
  task.extension = { identifier: { id: 'pub.language' }, isApplicationScoped: true };
  task.options = { profileLocation: defaultProfile.extensionsResource };
  task.userDataProfilesService = { defaultProfile, profiles: [defaultProfile, otherProfile] };
  task.webExtensionsScannerService = {
    scanUserExtensions: async profile => {
      assert.equal(profile.fsPath, '/other');
      return [{ identifier: { id: 'pub.language' }, metadata: { isApplicationScoped: true } }];
    },
    removeExtension: async (_extension, profile) => { calls.push(['remove-profile', profile.fsPath]); },
  };
  await task.doRun({});
  assert.deepEqual(calls, [['uninstall_extension', 'pub.language'], ['remove-profile', '/default']]);
});

test('uninstall preserves a real installation owned by another profile', async () => {
  const calls = [];
  const task = await uninstallTask(async command => { calls.push(command); });
  const defaultProfile = { extensionsResource: fakeUri('/default') };
  const otherProfile = { extensionsResource: fakeUri('/other') };
  task.extension = { identifier: { id: 'pub.shared' } };
  task.options = { profileLocation: defaultProfile.extensionsResource };
  task.userDataProfilesService = { defaultProfile, profiles: [defaultProfile, otherProfile] };
  task.webExtensionsScannerService = {
    scanUserExtensions: async () => [{ identifier: { id: 'PUB.SHARED' }, metadata: {} }],
    removeExtension: async () => { calls.push('remove-profile'); },
  };
  await task.doRun({});
  assert.deepEqual(calls, ['remove-profile']);
});

test('a default-profile application-scoped installation still owns its shared files', async () => {
  const calls = [];
  const task = await uninstallTask(async command => { calls.push(command); });
  const defaultProfile = { extensionsResource: fakeUri('/default') };
  const otherProfile = { extensionsResource: fakeUri('/other') };
  task.extension = { identifier: { id: 'pub.shared' } };
  task.options = { profileLocation: otherProfile.extensionsResource };
  task.userDataProfilesService = { defaultProfile, profiles: [defaultProfile, otherProfile] };
  task.webExtensionsScannerService = {
    scanUserExtensions: async () => [{ identifier: { id: 'pub.shared' }, metadata: { isApplicationScoped: true } }],
    removeExtension: async () => { calls.push('remove-profile'); },
  };
  await task.doRun({});
  assert.deepEqual(calls, ['remove-profile']);
});
