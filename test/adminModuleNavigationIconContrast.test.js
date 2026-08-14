import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildAdminModuleNavbar } from '../src/services/adminNavigation.js';

const NAVIGATION_CSS = readFileSync(new URL('../src/public/admin-module-navigation.css', import.meta.url), 'utf8');
const EXPECTED_ICON_HASHES = Object.freeze({
  recruitment: 'e7eaaf8afa37ce88d8ae6e5d3bacd888e50a73ca03901b341744884a0482cbb7',
  operations: 'bbd17efbd96fc8bebe06bc14539f0d8103563991bb1115c6d659ed283b077a6e',
  payroll: '596874974d97c50d4a4fdd0b4b8462b9e0d06d03b0370a088691340c79f2c137'
});

function moduleMenu(html, key) {
  return html.match(new RegExp(`<details[^>]*data-module-menu="${key}"[\\s\\S]*?<\\/details>`))?.[0] || '';
}

function iconDataFromCss(key) {
  const selector = `.admin-module-menu[data-module-menu="${key}"] .admin-module-nav-icon`;
  const start = NAVIGATION_CSS.indexOf(selector);
  assert.notEqual(start, -1, `debe existir el icono visual de ${key}`);
  const end = NAVIGATION_CSS.indexOf('}', start);
  const block = NAVIGATION_CSS.slice(start, end + 1);
  const data = block.match(/data:image\/png;base64,([^"\)]+)/)?.[1] || '';
  assert.ok(data, `debe existir el PNG embebido de ${key}`);
  return Buffer.from(data, 'base64');
}

test('el navbar fija los modelos de la referencia sin depender del emoji del sistema', () => {
  const html = buildAdminModuleNavbar(
    { originalUrl: '/admin/operaciones', userRole: 'dev', session: { userRole: 'dev' } },
    '<nav class="navbar"><a href="/admin">Panel</a></nav>'
  );

  assert.doesNotMatch(html, /[👥🚚🧾]/u);
  assert.match(NAVIGATION_CSS, /\.admin-module-menu\[data-module-menu\] \.admin-module-nav-icon-svg\s*\{[^}]*opacity:\s*0;/s);

  for (const key of ['recruitment', 'operations', 'payroll']) {
    assert.ok(moduleMenu(html, key), `debe renderizar el modulo ${key}`);
    const digest = createHash('sha256').update(iconDataFromCss(key)).digest('hex');
    assert.equal(digest, EXPECTED_ICON_HASHES[key], `debe conservar el modelo visual aprobado de ${key}`);
  }
});
