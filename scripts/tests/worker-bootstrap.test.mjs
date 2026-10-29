import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const filename = 'src/vs/platform/webWorker/browser/webWorkerServiceImpl.ts';
const source = await readFile(filename, 'utf8');
const { outputFiles } = await build({
  stdin: { contents: `${source}\nexport { getWorkerBootstrapUrl };`, resolveDir: dirname(filename), loader: 'ts' },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'worker-boundaries', setup(build) {
    build.onResolve({ filter: /^\.\./ }, args => ({ path: args.path, external: true }));
  } }],
});

async function bootstrap(workerUrl, { isolated = false, origin = 'http://localhost:1420' } = {}) {
  let blob;
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, Blob, URLSearchParams, origin, crossOriginIsolated: isolated,
    URL: class extends URL { static createObjectURL(value) { blob = value; return 'blob:fixture'; } },
    require: () => ({
      Disposable: class {},
      createTrustedTypesPolicy: () => undefined,
      COI: { addSearchParam(params) { if (isolated) params.set('vscode-coi', '3'); } },
      coalesce: values => values.filter(Boolean),
      getNLSMessages: () => ['Перевод'],
      getNLSLanguage: () => 'ru',
    }),
  };
  vm.runInNewContext(outputFiles[0].text, context);
  assert.equal(module.exports.getWorkerBootstrapUrl('editorWorkerService', workerUrl, undefined), 'blob:fixture');
  let imported;
  let ready;
  const worker = {
    __captureImport: async url => { imported = url; },
    postMessage: message => { ready = message; },
  };
  // Execute the actual generated bootstrap, replacing only the network import boundary.
  const code = (await blob.text()).replace('await import(__sidexImportUrl)', 'await __captureImport(__sidexImportUrl)');
  await vm.runInNewContext(`(async () => { ${code} })()`, worker);
  assert.equal(ready.type, 'vscode-worker-ready');
  assert.equal(worker._VSCODE_NLS_LANGUAGE, 'ru');
  assert.equal(worker._VSCODE_NLS_MESSAGES[0], 'Перевод');
  return imported;
}

test('Vite development worker parameters and encoded values survive bootstrap once', async () => {
  const url = new URL(await bootstrap('http://localhost:1420/src/editor.ts?worker_file&type=module&value=a%3Fb#old'));
  assert.equal(url.searchParams.get('type'), 'module');
  assert.deepEqual(url.searchParams.getAll('worker_file'), ['']);
  assert.deepEqual(url.searchParams.getAll('value'), ['a?b']);
  assert.equal(url.searchParams.has('vscode-coi'), false);
  assert.equal(url.hash, '#editorWorkerService');
  assert.equal([...url.searchParams].length, 3);
});

test('cross-origin isolation replaces its own flag without duplicating an existing query', async () => {
  const url = new URL(await bootstrap('http://localhost:1420/workers/editor.js?worker_file&type=module&vscode-coi=1', { isolated: true }));
  assert.equal(url.searchParams.get('type'), 'module');
  assert.deepEqual(url.searchParams.getAll('vscode-coi'), ['3']);
  assert.equal([...url.searchParams].length, 3);
});

test('external worker URLs retain their query and fragment even when their host shares an origin prefix', async () => {
  const url = 'https://example.com.evil.test/worker.js?token=abc#external';
  assert.equal(await bootstrap(url, { origin: 'https://example.com', isolated: true }), url);
});

test('native tauri worker imports retain query parameters and omit fragments', async () => {
  assert.equal(await bootstrap('tauri://localhost/workers/editor.js?token=abc#old', { origin: 'tauri://localhost' }),
    'tauri://localhost/workers/editor.js?token=abc');
});
