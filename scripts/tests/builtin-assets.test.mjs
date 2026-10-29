import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuiltinAssets, readBuiltinThemes } from '../builtin-assets.mjs';

test('every shipped VS Code grammar, theme, icon and font resolves offline', () => {
  const result = validateBuiltinAssets();
  assert.ok(result.grammars >= 50);
  assert.ok(result.themes >= 17);
});

test('classic light/dark themes preserve official token colors and inherited rules', () => {
  const themes = readBuiltinThemes();
  const quiet = themes.find(theme => theme.id === 'Quiet Light');
  assert.equal(quiet.uiTheme, 'vs');
  assert.equal(quiet.colors['editor.background'].toLowerCase(), '#f5f5f5');
  for (const name of ['Quiet Light', 'Monokai', 'Solarized Light', 'Default Dark Modern', 'Default Light Modern']) {
    const theme = themes.find(candidate => candidate.id === name);
    assert.ok(theme, name);
    assert.ok(theme.tokenColors.length > 10, `${name} has syntax colors`);
  }
});
