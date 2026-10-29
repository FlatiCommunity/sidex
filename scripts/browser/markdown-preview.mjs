import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const result = await build({
  stdin: { contents: `export { renderMarkdownDocument } from './src/vs/workbench/contrib/markdown/browser/markdownDocumentRenderer.ts'; export { sourceLineMarkers, markdownPreviewScript } from './src/vs/workbench/contrib/markdown/browser/markdownPreviewContent.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'iife', globalName: 'MarkdownTest', platform: 'browser', write: false,
  loader: { '.css': 'empty' }, logLevel: 'silent',
});
const browser = await chromium.launch({ executablePath: process.env.SIDEX_TEST_BROWSER || undefined, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: result.outputFiles[0].text });
  const sanitized = await page.evaluate(async () => {
    const source = '# Safe\n\n<script>window.pwned = true</script>\n\n<img src="x" onerror="window.pwned=true">\n\n[bad](javascript:alert(1))\n\n```\n<script>example</script>\n```';
    const html = await MarkdownTest.renderMarkdownDocument(source, { whenInstalledExtensionsRegistered: async () => {} }, { getLanguageIdByLanguageName: () => null, languageIdCodec: { decodeLanguageId: () => 'plaintext', encodeLanguageId: () => 1 } }, { markedExtensions: [MarkdownTest.sourceLineMarkers(source)], sanitizerConfig: { allowRelativeMediaPaths: true, allowedAttributes: { augment: ['data-source-line'] } } });
    const container = document.createElement('div');
    container.innerHTML = html;
    return { scriptCount: container.querySelectorAll('script').length, eventHandler: container.querySelector('img')?.getAttribute('onerror'), unsafeLink: container.querySelector('a')?.getAttribute('href'), code: container.querySelector('code')?.textContent, markers: container.querySelectorAll('[data-source-line]').length };
  });
  assert.equal(sanitized.scriptCount, 0);
  assert.equal(sanitized.eventHandler, null);
  assert.equal(sanitized.unsafeLink, null);
  assert.ok(sanitized.code.includes('<script>example</script>'));
  assert.ok(sanitized.markers > 1);

  const script = await page.evaluate(() => MarkdownTest.markdownPreviewScript);
  await page.setContent(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-test'; style-src 'unsafe-inline'"><style>body{margin:0}.block{height:500px}</style></head><body><span class="sidex-source-line" data-source-line="1"></span><div class="block">First</div><span class="sidex-source-line" data-source-line="11"></span><div class="block">Second</div><span class="sidex-source-line" data-source-line="21"></span><div class="block">Third</div><span class="sidex-source-line" data-source-line="31"></span><script>window.untrustedRan=true</script><script nonce="test">window.messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.messages.push(m)});${script}</script></body></html>`);
  assert.equal(await page.evaluate(() => window.untrustedRan), undefined);
  assert.ok(await page.evaluate(() => window.messages.some(message => message.type === 'sidex.markdown.ready')));
  await page.evaluate(() => window.postMessage({ type: 'sidex.markdown.line', line: 11 }, '*'));
  await page.waitForFunction(() => window.scrollY === 500);
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 250));
  await page.waitForFunction(() => window.messages.some(message => message.type === 'sidex.markdown.scroll'));
  assert.equal(await page.evaluate(() => window.messages.find(message => message.type === 'sidex.markdown.scroll').line), 6);
  await page.mouse.dblclick(300, 100);
  await page.waitForFunction(() => window.messages.some(message => message.type === 'sidex.markdown.reveal'));
  console.log('PASS: markdown sanitization, code escaping, CSP, scroll synchronization in both directions, source reveal');
} finally { await browser.close(); }
