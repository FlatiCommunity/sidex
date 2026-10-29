import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'neutral', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { handleGalleryQuery } = await load('infrastructure/marketplace-proxy/src/gallery.ts');
const { default: worker } = await load('infrastructure/marketplace-proxy/src/worker.ts');
const gallery = (extensions, total = extensions.length) => ({ results: [{ extensions, resultMetadata: [{ metadataType: 'ResultCount', metadataItems: [{ name: 'TotalCount', count: total }] }] }] });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const versions = ['linux-x64', 'darwin-arm64'].map(targetPlatform => ({
  version: '2.0.0', targetPlatform, assetUri: `https://example.gallerycdn.vsassets.io/extensions/pub/ext/2.0.0/${targetPlatform}`,
  properties: [{ key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.110.0' }],
  files: [{ assetType: 'Microsoft.VisualStudio.Code.Manifest', source: 'https://example.gallerycdn.vsassets.io/package.json' }]
}));
const extension = { extensionId: 'real-marketplace-uuid', extensionName: 'ext', displayName: 'Test', publisher: { publisherName: 'pub' }, versions };

test('gallery preserves native variants, engine constraints, UUID and manifests without an icon', async t => {
  t.mock.method(globalThis, 'fetch', async url => json(gallery(String(url).includes('marketplace.visualstudio.com') ? [extension] : [])));
  const response = await handleGalleryQuery(new Request('https://registry.test/api/gallery/extensionquery?targetPlatform=darwin-arm64', {
    method: 'POST', body: JSON.stringify({ filters: [{ criteria: [], pageSize: 20 }], flags: 0x1 | 0x2 })
  }), 'https://registry.test');
  const actual = JSON.parse(response.body).results[0].extensions[0];
  assert.equal(actual.extensionId, extension.extensionId);
  assert.deepEqual(actual.versions.map(version => version.targetPlatform), ['linux-x64', 'darwin-arm64']);
  assert.deepEqual(actual.versions[1].properties, versions[1].properties);
  assert.equal(Buffer.from(actual.versions[1].assetUri.split('/').at(-1), 'base64url').toString(), versions[1].assetUri);
  assert.ok(!actual.versions[1].files.some(file => file.assetType.includes('Icons')));
});

test('Open VSX-only batch lookup forwards IDs, filters and pagination and retains upstream totals', async t => {
  const body = { filters: [{ criteria: [{ filterType: 4, value: 'real-marketplace-uuid' }], pageNumber: 3, pageSize: 20 }], flags: 0x91 };
  let openVsxSeen = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.deepEqual(JSON.parse(options.body), body);
    if (String(url).startsWith('https://open-vsx.org/')) {
      openVsxSeen = true;
      assert.equal(new URL(url).searchParams.get('targetPlatform'), 'linux-x64');
      return json(gallery([extension], 73));
    }
    return json(gallery([]));
  });
  const result = await handleGalleryQuery(new Request('https://registry.test/api/gallery/extensionquery?targetPlatform=linux-x64', { method: 'POST', body: JSON.stringify(body) }), 'https://registry.test');
  assert.ok(openVsxSeen);
  assert.equal(result.total, 73);
  assert.equal(JSON.parse(result.body).results[0].extensions[0].extensionId, 'real-marketplace-uuid');
});

test('asset proxy preserves Open VSX gallery asset types instead of treating them as filenames', async t => {
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  t.after(() => { globalThis.caches = originalCaches; });
  let requested;
  t.mock.method(globalThis, 'fetch', async url => { requested = String(url); return json({ name: 'test' }); });
  const base = Buffer.from('https://open-vsx.org/vscode/asset/pub/ext/2.0.0').toString('base64url');
  const result = await worker.fetch(new Request(`https://registry.test/api/asset/openvsx/${base}/Microsoft.VisualStudio.Code.Manifest?targetPlatform=linux-x64`), {}, { waitUntil() {} });
  assert.equal(result.status, 200);
  assert.equal(requested, 'https://open-vsx.org/vscode/asset/pub/ext/2.0.0/Microsoft.VisualStudio.Code.Manifest?targetPlatform=linux-x64');
});
