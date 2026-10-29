import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { distribution, verifyChecksum } from '../download-runtime.mjs';

test('cross-target Node distributions are selected explicitly', () => {
  assert.equal(distribution('v24.22.1', 'win32', 'arm64').archive, 'node-v24.22.1-win-arm64.zip');
  assert.equal(distribution('v24.22.1', 'darwin', 'x64').archive, 'node-v24.22.1-darwin-x64.tar.xz');
  assert.throws(() => distribution('../latest', 'linux', 'x64'));
  assert.throws(() => distribution('v24.22.1', 'darwin', 'universal'));
});
test('runtime staging rejects missing, mismatched and wrong-file checksums', () => {
  const bytes = Buffer.from('fixture');
  const digest = createHash('sha256').update(bytes).digest('hex');
  verifyChecksum(bytes, 'node.tar.xz', `${digest}  node.tar.xz\n`);
  assert.throws(() => verifyChecksum(Buffer.from('changed'), 'node.tar.xz', `${digest}  node.tar.xz`));
  assert.throws(() => verifyChecksum(bytes, 'node.tar.xz', `${digest}  other.tar.xz`));
  assert.throws(() => verifyChecksum(bytes, 'node.tar.xz', ''));
});
