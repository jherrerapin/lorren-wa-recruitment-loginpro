import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdminModuleNavbar } from '../src/services/adminNavigation.js';

function moduleMenu(html, key) {
  return html.match(new RegExp(`<details[^>]*data-module-menu="${key}"[\\s\\S]*?<\\/details>`))?.[0] || '';
}

test('los tres modulos usan SVG azules estables y no dependen de emojis del sistema', () => {
  const html = buildAdminModuleNavbar(
    { originalUrl: '/admin/operaciones', userRole: 'dev', session: { userRole: 'dev' } },
    '<nav class="navbar"><a href="/admin">Panel</a></nav>'
  );

  assert.doesNotMatch(html, /[👥🚚🧾]/u);

  for (const key of ['recruitment', 'operations', 'payroll']) {
    const menu = moduleMenu(html, key);
    assert.ok(menu, `debe renderizar el modulo ${key}`);
    assert.match(menu, /<svg\b[^>]*class="admin-module-nav-icon-svg"/);
    assert.match(menu, /fill="#60A5FA"/);
    assert.match(menu, /fill="#2563EB"/);
    assert.match(menu, /width="16"/);
    assert.match(menu, /height="16"/);
    assert.match(menu, /aria-hidden="true"/);
  }

  assert.match(moduleMenu(html, 'operations'), /<circle\b[^>]*cx="6"[^>]*cy="17\.2"/);
  assert.match(moduleMenu(html, 'payroll'), /<path\b[^>]*d="M5 2\.5h14v18\.8/);
});