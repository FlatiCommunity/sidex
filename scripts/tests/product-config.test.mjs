import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const { outputFiles } = await build({ entryPoints: ['src/product-config.ts'], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
const { createProductConfiguration, normalizeGalleryUrl, DEFAULT_GALLERY_URL, SIDEX_GALLERY_URL } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

test('default gallery resources belong to the same registry', () => {
  const gallery = createProductConfiguration().extensionsGallery;
  assert.equal(gallery.serviceUrl, DEFAULT_GALLERY_URL);
  assert.ok(gallery.resourceUrlTemplate.startsWith('https://open-vsx.org/'));
});

test('combined and custom registries use returned asset metadata', () => {
  for (const url of [SIDEX_GALLERY_URL, 'https://registry.example/gallery/']) {
    const gallery = createProductConfiguration(url).extensionsGallery;
    assert.equal(gallery.resourceUrlTemplate, '');
    assert.equal(gallery.extensionUrlTemplate, '');
    assert.equal(gallery.nlsBaseUrl, '');
  }
});

test('gallery input normalizes extensionquery and rejects unsafe or ambiguous URLs', () => {
  assert.equal(normalizeGalleryUrl('https://registry.example/gallery/extensionquery/'), 'https://registry.example/gallery');
  for (const url of ['http://registry.example', 'https://user:password@registry.example', 'file:///tmp/registry', 'https://registry.example?token=1', 'https://registry.example/#fragment']) {
    assert.throws(() => normalizeGalleryUrl(url));
  }
});
