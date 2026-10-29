// Explicit maintenance operation. Normal setup/build uses the checked-in assets offline.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { assetLock, assetsRoot, validateBuiltinAssets } from './builtin-assets.mjs';

const files = Object.entries(assetLock.files);
let cursor = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < files.length) {
    const [path, hash] = files[cursor++];
    const target = resolve(assetsRoot, path);
    try {
      if (createHash('sha256').update(await readFile(target)).digest('hex') === hash) continue;
    } catch { /* Download a missing file below. */ }
    const url = `https://raw.githubusercontent.com/${assetLock.repository}/${assetLock.ref}/extensions/${path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${response.status}: ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Checksum mismatch: ${path}`);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.download`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  }
}));
console.log('Built-in assets synchronized:', validateBuiltinAssets());
