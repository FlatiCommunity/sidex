import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/webview-compat.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'safari15', write: false, logLevel: 'silent' });
const context = vm.createContext({ console, setTimeout, clearTimeout });
vm.runInContext('delete Array.prototype.at; delete Array.prototype.findLast; delete Array.prototype.findLastIndex; delete String.prototype.at; delete Object.hasOwn; globalThis.structuredClone = undefined;', context);
vm.runInContext(outputFiles[0].text, context);

test('older WebKit gets the standard indexed collection APIs used by the workbench', () => {
  assert.equal(vm.runInContext('[1,2,3].at(-1)', context), 3);
  assert.equal(vm.runInContext('[1,2,3].at(-10)', context), undefined);
  assert.equal(vm.runInContext('"Русский".at(-1)', context), 'й');
  assert.equal(vm.runInContext('[1,2,3].findLast(n => n < 3)', context), 2);
  assert.equal(vm.runInContext('[1,,3].findLastIndex(n => n === undefined)', context), 1);
  assert.equal(vm.runInContext('Object.hasOwn(Object.create({inherited: true}), "inherited")', context), false);
});

test('configuration cloning preserves cycles, binary data and nested values', () => {
  const valid = vm.runInContext(`(() => { const source = { text: 'Русский', data: new Uint8Array([0,255]), map: new Map([['x', 1]]) }; source.self = source; const copy = structuredClone(source); return copy !== source && copy.self === copy && copy.text === source.text && copy.data[1] === 255 && copy.data !== source.data && copy.map.get('x') === 1; })()`, context);
  assert.equal(valid, true);
});
