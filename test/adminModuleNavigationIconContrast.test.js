import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdminModuleNavbar } from '../src/services/adminNavigation.js';

function moduleMenu(html, key) {
  return html.match(new RegExp(`<details[^>]*data-module-menu="${key}"[\\s\\S]*?<\\/details>`))?.[0] || '';
}

test('los tres modulos usan geometria Fluent azul estable y no dependen de emojis del sistema', () => {
  const html = buildAdminModuleNavbar(
    { originalUrl: '/admin/operaciones', userRole: 'dev', session: { userRole: 'dev' } },
    '<nav class="navbar"><a href="/admin">Panel</a></nav>'
  );

  assert.doesNotMatch(html, /[👥🚚🧾]/u);
  assert.doesNotMatch(html, /#FF822D|#FCD53F|#321B41|#533566|#D3D3D3|#9B9B9B/);

  for (const key of ['recruitment', 'operations', 'payroll']) {
    const menu = moduleMenu(html, key);
    assert.ok(menu, `debe renderizar el modulo ${key}`);
    assert.match(menu, /<svg\b[^>]*class="admin-module-nav-icon-svg"/);
    assert.match(menu, /viewBox="0 0 32 32"/);
    assert.match(menu, /fill="#60A5FA"/);
    assert.match(menu, /fill="#2563EB"/);
    assert.match(menu, /width="16"/);
    assert.match(menu, /height="16"/);
    assert.match(menu, /aria-hidden="true"/);
  }

  assert.match(moduleMenu(html, 'recruitment'), /d="M15\.8402 23\.93C15\.8999/);
  assert.match(moduleMenu(html, 'operations'), /d="M2\.16 19\.3L5\.53 12\.89/);
  assert.match(moduleMenu(html, 'payroll'), /d="M25\.05 3\.105L24\.03 2\.165/);
});
