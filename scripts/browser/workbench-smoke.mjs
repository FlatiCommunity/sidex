import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const url = process.env.SIDEX_PREVIEW_URL || 'http://127.0.0.1:15439';
const browser = await chromium.launch({ executablePath: process.env.SIDEX_TEST_BROWSER || undefined, headless: true, args: ['--no-sandbox'] });
try {
  for (const locale of ['en', 'ru', 'zh-cn', 'zh-tw']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(language => localStorage.setItem('vscode.nls.locale', language), locale);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200);
    await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
    await page.waitForTimeout(3000);
    const state = await page.evaluate(() => ({ text: document.body.innerText, language: document.documentElement.lang, nlsLanguage: globalThis._VSCODE_NLS_LANGUAGE }));
    console.log(JSON.stringify({ locale, language: state.language, nlsLanguage: state.nlsLanguage, errors, text: state.text.slice(0, 1300) }, null, 2));
    assert.ok(!state.text.includes('SideX failed to start'));
    assert.equal(state.nlsLanguage, locale);
    assert.equal(errors.length, 0, errors.join('\n'));
    const input = page.locator('.sc-input-area textarea').first();
    await input.fill('first line');
    await input.press('Shift+Enter');
    await input.pressSequentially('second line');
    assert.equal(await input.inputValue(), 'first line\nsecond line');
    const composed = await input.evaluate(element => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return { prevented: event.defaultPrevented, value: element.value };
    });
    assert.equal(composed.prevented, false, 'IME Enter must remain available to confirm its candidate');
    assert.equal(composed.value, 'first line\nsecond line');
    await input.fill('');
    await page.screenshot({ path: `../workbench-${locale}.png` });
    await context.close();
  }
  console.log('PASS: production workbench starts in all four built-in languages; multiline and IME chat input work');
} finally { await browser.close(); }
