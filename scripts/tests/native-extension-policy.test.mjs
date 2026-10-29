import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const noop = () => {};
const { outputFiles } = await build({
  entryPoints: ['src/vs/platform/extensionManagement/common/abstractExtensionManagementService.ts'],
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'extension-policy-boundaries', setup(build) {
    build.onResolve({ filter: /^\.{1,2}\// }, args => args.kind === 'entry-point' ? undefined : ({ path: args.path, external: true }));
  } }],
});

function createService({ native = true, allowed = true, compatible = true, replacement = null, target = 'darwin-arm64' } = {}) {
  const module = { exports: {} };
  const enumValues = new Proxy({}, { get: (_target, name) => name });
  const dependencies = {
    Disposable: class {},
    IProductService: noop, IAllowedExtensionsService: noop, IExtensionGalleryService: noop,
    ITelemetryService: noop, IUriIdentityService: noop, ILogService: noop, IUserDataProfilesService: noop,
    MarkdownString: class { constructor(value) { this.value = value; } },
    ExtensionManagementError: class extends Error { constructor(message, code) { super(message); this.code = code; this.name = code; } },
    ExtensionManagementErrorCode: enumValues,
    InstallOperation: { Install: 1 },
    CancellationToken: { None: {} },
    localize: (_key, text, ...args) => text.replace(/\{(\d+)\}/g, (_match, index) => String(args[index])),
    isMalicious: () => false,
    areApiProposalsCompatible: () => true,
    isTargetPlatformCompatible: (platform, _all, expected) => platform === expected || platform === 'universal',
    TargetPlatformToString: value => value,
    isWeb: !native,
  };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, __SIDEX_TAURI__: native,
    require: () => dependencies,
  });
  const service = Object.create(module.exports.AbstractExtensionManagementService.prototype);
  const calls = [];
  service.allowedExtensionsService = { isAllowed: () => allowed === true ? true : { value: allowed } };
  service.productService = { nameLong: 'SideX', version: '1.110.0', date: '2026-03-05' };
  service.logService = { info: noop };
  service.getTargetPlatform = async () => target;
  service.getExtensionsControlManifest = async () => ({ malicious: [], deprecated: {} });
  service.getCurrentExtensionsManifestLocation = () => '/profile/extensions.json';
  service.galleryService = {
    isEnabled: () => true,
    isExtensionCompatible: async (extension, preRelease, platform, product) => {
      calls.push(['compatible', extension.version, preRelease, platform, product.version]);
      return compatible;
    },
    getCompatibleExtension: async (_extension, preRelease, platform, product) => {
      calls.push(['select-version', preRelease, platform, product.version]);
      return replacement;
    },
    getExtensions: async (queries, options) => {
      calls.push(['query', queries, options]);
      return replacement ? [replacement] : [];
    },
    getManifest: async extension => {
      calls.push(['manifest', extension.version]);
      return { publisher: 'pub', name: 'ext', version: extension.version, main: './extension.js' };
    },
  };
  service.installExtensions = async extensions => {
    calls.push(['install', extensions.map(item => item.extension.version)]);
    return extensions.map(item => ({ identifier: item.extension.identifier, local: { manifest: item.manifest } }));
  };
  return { service, calls };
}

function extension(version = '2.0.0', targetPlatform = 'darwin-arm64') {
  return {
    identifier: { id: 'pub.ext' }, publisherDisplayName: 'Publisher', displayName: 'Extension',
    version, hasPreReleaseVersion: false, allTargetPlatforms: [targetPlatform],
    properties: { targetPlatform, isPreReleaseVersion: false, engine: '^1.110.0' },
  };
}

test('native installation respects the real canInstall policy refusal before querying or downloading a manifest', async () => {
  const { service, calls } = createService({ allowed: 'blocked by the administrator' });
  const [result] = await service.installGalleryExtensions([{ extension: extension(), options: {} }]);
  assert.equal(result.error.code, 'NotAllowed');
  assert.match(result.error.message, /blocked by the administrator/);
  assert.equal(result.local, undefined);
  assert.deepEqual(calls, []);
});

test('native installation fails when the gallery has no compatible version instead of installing the requested release', async () => {
  const { service, calls } = createService({ compatible: false });
  const [result] = await service.installGalleryExtensions([{ extension: extension(), options: {} }]);
  assert.equal(result.error.code, 'Incompatible');
  assert.equal(result.local, undefined);
  assert.deepEqual(calls.map(call => call[0]), ['compatible', 'select-version']);
  assert.equal(calls[0][3], 'darwin-arm64');
  assert.equal(calls[1][2], 'darwin-arm64');
});

test('explicit incompatible versions remain rejected when the platform-specific exact-version query is empty', async () => {
  const { service, calls } = createService({ compatible: false });
  const [result] = await service.installGalleryExtensions([{ extension: extension('3.0.0'), options: { installGivenVersion: true } }]);
  assert.equal(result.error.code, 'Incompatible');
  assert.deepEqual(calls.map(call => call[0]), ['compatible', 'query']);
  assert.equal(calls[1][1][0].version, '3.0.0');
  assert.equal(calls[1][2].targetPlatform, 'darwin-arm64');
  assert.equal(calls[1][2].compatible, true);
});

test('valid universal native extensions still install through the checked gallery path', async () => {
  const { service, calls } = createService();
  const [result] = await service.installGalleryExtensions([{ extension: extension('2.0.0', 'universal'), options: {} }]);
  assert.equal(result.error, undefined);
  assert.equal(result.local.manifest.version, '2.0.0');
  assert.deepEqual(calls.map(call => call[0]), ['compatible', 'manifest', 'install']);
  assert.equal(calls[0][3], 'darwin-arm64');
});

test('a genuinely compatible alternate native release is selected and installed', async () => {
  const { service, calls } = createService({ compatible: false, replacement: extension('1.5.0') });
  const [result] = await service.installGalleryExtensions([{ extension: extension('2.0.0', 'linux-x64'), options: {} }]);
  assert.equal(result.error, undefined);
  assert.equal(result.local.manifest.version, '1.5.0');
  assert.deepEqual(calls.map(call => call[0]), ['compatible', 'select-version', 'manifest', 'install']);
  assert.equal(calls[1][2], 'darwin-arm64');
  assert.equal(calls[2][1], '1.5.0');
});

test('browser platform refusals retain their platform error and never reach installation', async () => {
  const { service, calls } = createService({ native: false, target: 'web' });
  const [result] = await service.installGalleryExtensions([{ extension: extension(), options: {} }]);
  assert.equal(result.error.code, 'IncompatibleTargetPlatform');
  assert.match(result.error.message, /web/);
  assert.deepEqual(calls, []);
});
