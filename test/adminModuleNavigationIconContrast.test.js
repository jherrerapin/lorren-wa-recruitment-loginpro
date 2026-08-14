import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdminModuleNavbar } from '../src/services/adminNavigation.js';

test('Reclutamiento usa un SVG monocromatico y no depende del emoji del sistema', () => {
  const html = buildAdminModuleNavbar(
    { originalUrl: '/admin', userRole: 'admin', session: { userRole: 'admin' } },
    '<nav class="navbar"><a href="/admin">Panel</a></nav>'
  );

  const recruitment = html.match(/<details[^>]*data-module-menu="recruitment"[\s\S]*?<\/details>/)?.[0] || '';

  assert.ok(recruitment, 'debe renderizar el modulo Reclutamiento');
  assert.doesNotMatch(recruitment, /👥/u);
  assert.match(recruitment, /<svg\b[^>]*class="admin-module-nav-icon-svg"/);
  assert.match(recruitment, /stroke="currentColor"/);
  assert.match(recruitment, /width="16"/);
  assert.match(recruitment, /height="16"/);
  assert.match(recruitment, /aria-hidden="true"/);
});
