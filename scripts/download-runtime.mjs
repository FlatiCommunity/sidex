/** Stage a pinned Node.js runtime, including cross-target distributions. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageRuntime, targetPlatform } from './stage-runtime.mjs';

const execute = promisify(execFile);
const versions = JSON.parse(await fs.readFile(new URL('./runtime-versions.json', import.meta.url), 'utf8'));
export function distribution(version, platform, arch) {
  if (!/^v\d+\.\d+\.\d+$/.test(version) || !['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error('Unsupported Node.js version or distribution target');
  }
  const folder = `node-${version}-${platform === 'win32' ? 'win' : platform}-${arch}`;
  return { folder, archive: `${folder}.${platform === 'win32' ? 'zip' : 'tar.xz'}` };
}
export function verifyChecksum(bytes, filename, sums) {
  const expected = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1] === filename)?.[0];
  if (!expected || !/^[a-f\d]{64}$/i.test(expected) || createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) {
    throw new Error(`SHA-256 verification failed for ${filename}`);
  }
}
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
export async function downloadRuntime(target, options = {}) {
  if (!target) throw new Error('Pass a Rust target triple, for example x86_64-unknown-linux-gnu.');
  const expected = targetPlatform(target);
  // Node 22 supports the application's macOS 12 minimum; Node 24 requires 13.5.
  const version = options.version || versions.node;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sidex-node-runtime-'));
  try {
    const sums = (await download(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).toString('utf8');
    const nodes = {};
    for (const arch of expected.architectures) {
      const { folder, archive } = distribution(version, expected.platform, arch);
      const bytes = await download(`https://nodejs.org/dist/${version}/${archive}`);
      verifyChecksum(bytes, archive, sums);
      const archivePath = path.join(temporary, archive);
      await fs.writeFile(archivePath, bytes);
      await execute('tar', ['-xf', archivePath, '-C', temporary]);
      nodes[arch] = path.join(temporary, folder, expected.platform === 'win32' ? 'node.exe' : 'bin/node');
    }
    const first = expected.architectures[0];
    const folder = distribution(version, expected.platform, first).folder;
    return await stageRuntime({
      ...options, target, nodeLicense: path.join(temporary, folder, 'LICENSE'),
      ...(expected.architectures.length === 1 ? { node: nodes[first] } : { nodeX64: nodes.x64, nodeArm64: nodes.arm64 }),
    });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const target = args.find(arg => !arg.startsWith('--')) || process.env.TAURI_ENV_TARGET_TRIPLE;
  await downloadRuntime(target, { buildServer: args.includes('--build-server') });
  console.log(`Staged verified Node.js runtime for ${target || 'the host platform'}`);
}
