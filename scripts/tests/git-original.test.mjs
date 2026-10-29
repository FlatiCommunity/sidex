import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(resolve(tmpdir(), 'sidex-git-uri-'));
after(() => rm(directory, { recursive: true, force: true }));
const outfile = resolve(directory, 'git-uri.mjs');
await build({
  stdin: {
    contents: `export * from './src/vs/workbench/contrib/scm/browser/gitOriginalUri.ts'; export { URI } from './src/vs/base/common/uri.ts';`,
    resolveDir: resolve(import.meta.dirname, '../..'),
    loader: 'ts',
  },
  outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
});
const { URI, gitOriginalUri, gitOriginalRequest } = await import(pathToFileURL(outfile));

test('worktree identity and unusual filenames survive editor URI round trips', () => {
  const root = URI.file('/worktrees/feature branch');
  const file = URI.joinPath(root, 'src/файл #1?.txt');
  const uri = URI.parse(gitOriginalUri(file, root, 'INDEX').toString());
  assert.deepEqual(gitOriginalRequest(uri, URI.file('/wrong/repo')), {
    path: root.fsPath, file: 'src/файл #1?.txt', reference: 'INDEX',
  });
});

test('same relative name in two worktrees produces different cached documents', () => {
  const first = URI.file('/worktrees/first');
  const second = URI.file('/worktrees/second');
  assert.notEqual(gitOriginalUri(URI.joinPath(first, 'test.ts'), first).toString(), gitOriginalUri(URI.joinPath(second, 'test.ts'), second).toString());
});

test('history revisions and outside-repository resources do not silently fall back to HEAD', () => {
  const root = URI.file('/repo');
  const historical = gitOriginalUri(URI.joinPath(root, 'a.txt'), root, 'HEAD~1');
  assert.equal(gitOriginalRequest(historical, root).reference, 'HEAD~1');
  assert.throws(() => gitOriginalRequest(gitOriginalUri(URI.file('/outside/a.txt'), root), root));
});
