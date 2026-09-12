import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const tabsRuntime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');
const shellCss = fs.readFileSync('src/public/admin-module-shell.css', 'utf8');

test('el rango completo reemplaza visualmente el resumen y no deja ver todos duplicado', () => {
  assert.match(tabsRuntime, /const rangeStatusActive = hasCompleteRegistrationRange\(\)/);
  assert.match(tabsRuntime, /child\.hidden = true/);
  assert.match(tabsRuntime, /sourceToggle\.hidden = true/);

  assert.match(
    shellCss,
    /\[data-vacancy-panel\]\s+\.candidate-vacancy-section-panel\s*>\s*\[hidden\][\s\S]*?\[data-vacancy-panel\]\s+\[data-vacancy-cycle-toggle\]\[hidden\][\s\S]*?display:\s*none\s*!important;/
  );
});
