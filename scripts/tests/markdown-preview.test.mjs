import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({
  stdin: { contents: `export { sourceLineMarkers } from './src/vs/workbench/contrib/markdown/browser/markdownPreviewContent.ts'; export { Marked } from './src/vs/base/common/marked/marked.js';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
const { sourceLineMarkers, Marked } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

function lines(source) {
  const html = new Marked(sourceLineMarkers(source)).parse(source);
  return [...html.matchAll(/data-source-line="(\d+)"/g)].map(match => Number(match[1]));
}

test('nested lists and blockquotes do not double-count source lines', () => {
  const source = '# Heading\n\n- First\n  - Nested\n- Last\n\n> Quote\n> Next\n\nParagraph\n';
  assert.deepEqual(lines(source), [1, 3, 7, 10, 11]);
});

test('reference definitions, CRLF and repeated text retain real source positions', () => {
  const source = '[ref]: https://example.com\r\n\r\nRepeated\r\n\r\nRepeated\r\n\r\n[link][ref]\r\n';
  assert.deepEqual(lines(source), [3, 5, 7, 8]);
});

test('code fences escape markup instead of injecting document scripts', () => {
  const source = '```html\n<script>alert(1)</script>\n```\n';
  const html = new Marked(sourceLineMarkers(source)).parse(source);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
});
