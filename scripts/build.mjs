import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const heap = Number(process.env.SIDEX_BUILD_HEAP_MB || 6144);
if (!Number.isSafeInteger(heap) || heap < 512) {
  throw new Error('SIDEX_BUILD_HEAP_MB must be an integer of at least 512 MiB.');
}
for (const args of [
  ['scripts/generate-extension-meta.js'],
  [`--max-old-space-size=${heap}`, path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
