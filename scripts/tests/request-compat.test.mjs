import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: ['src/vs/base/parts/request/common/requestImpl.ts'],
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const { request } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

function cancellation() {
  const listeners = new Set();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
  return { token, listeners, cancel() { token.isCancellationRequested = true; for (const fn of listeners) fn(); } };
}

function pendingFetch(_url, { signal }) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

test('marketplace requests work without AbortSignal.any or timeout', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('manifest', { headers: { 'x-test': 'ok' } }));
  for (const name of ['any', 'timeout']) {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, name);
    Object.defineProperty(AbortSignal, name, { configurable: true, value: undefined });
    t.after(() => Object.defineProperty(AbortSignal, name, original));
  }
  const state = cancellation();
  const result = await request({ url: 'https://registry.test/manifest', timeout: 100 }, state.token);
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.headers['x-test'], 'ok');
  assert.equal(state.listeners.size, 0);
});

test('a timeout aborts an in-flight download and releases cancellation listeners', async t => {
  t.mock.method(globalThis, 'fetch', pendingFetch);
  const state = cancellation();
  await assert.rejects(request({ url: 'https://registry.test/manifest', timeout: 5 }, state.token), /Fetch timeout: 5ms/);
  assert.equal(state.listeners.size, 0);
});

test('user cancellation remains cancellation instead of a timeout or offline error', async t => {
  t.mock.method(globalThis, 'fetch', pendingFetch);
  const state = cancellation();
  const pending = request({ url: 'https://registry.test/manifest', timeout: 100 }, state.token, () => false);
  state.cancel();
  await assert.rejects(pending, error => error.name === 'Canceled');
  assert.equal(state.listeners.size, 0);
});

test('the timeout covers reading the response body', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    status: 200, headers: new Headers(),
    arrayBuffer: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  }));
  await assert.rejects(request({ url: 'https://registry.test/manifest', timeout: 5 }, cancellation().token), /Fetch timeout/);
});
