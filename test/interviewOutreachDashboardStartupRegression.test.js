import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { interviewOutreachManagementRouter } from '../src/routes/interviewOutreachManagement.js';

const routeSource = readFileSync(
  new URL('../src/routes/interviewOutreachManagement.js', import.meta.url),
  'utf8'
);
const uiSource = readFileSync(
  new URL('../src/public/interview-outreach-management.js', import.meta.url),
  'utf8'
);

test('la ruta de gestión de entrevistas carga sin depender de la confirmación automática retirada', () => {
  assert.equal(typeof interviewOutreachManagementRouter, 'function');
  const router = interviewOutreachManagementRouter({});
  assert.equal(typeof router, 'function');

  assert.doesNotMatch(routeSource, /deriveInterviewOutreachAttendance/);
  assert.doesNotMatch(routeSource, /vacancyDashboardSearchExpansion\.js/);
  assert.doesNotMatch(routeSource, /direction:\s*'INBOUND'/);
  assert.match(routeSource, /buildInterviewManagementSnapshot\(\{\s*review(?:,|\s*\})/);
});

test('el dashboard muestra el shell de Gestión de entrevistas antes del cliente diferido', () => {
  const router = interviewOutreachManagementRouter({});
  const injectionLayer = router.stack[0];
  assert.equal(typeof injectionLayer?.handle, 'function');

  let sentBody = null;
  let nextCalled = false;
  const res = {
    send(body) {
      sentBody = body;
      return body;
    }
  };

  injectionLayer.handle(
    { method: 'GET', path: '/' },
    res,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);

  res.send('<html><body><section data-vacancy-panel="TEST-VACANCY"><header class="vacancy-header">Vacante</header></section></body></html>');

  assert.match(sentBody, /data-interview-outreach-loading-shell/);
  assert.match(sentBody, /data-interview-outreach-management/);
  assert.ok(
    sentBody.indexOf('data-interview-outreach-loading-shell')
      < sentBody.indexOf('data-interview-outreach-management'),
    'el shell debe ejecutarse antes del cliente principal diferido'
  );
  assert.match(sentBody, /board\.dataset\.interviewCoordinationBoard = vacancyId/);
  assert.match(sentBody, /title\.textContent = 'Gestión de entrevistas'/);
  assert.match(sentBody, /loading\.textContent = 'Cargando…'/);
  assert.match(sentBody, /header\.insertAdjacentElement\('afterend', board\)/);

  assert.match(uiSource, /const current = panel\.querySelector\('\[data-interview-coordination-board\]'\)/);
  assert.match(uiSource, /const board = current \|\| element\('section', 'ic-board'\)/);
});

test('la inyección conserva un solo entrypoint y no duplica el shell si el cliente ya está presente', () => {
  const router = interviewOutreachManagementRouter({});
  const injectionLayer = router.stack[0];
  let sentBody = null;
  const res = {
    send(body) {
      sentBody = body;
      return body;
    }
  };

  injectionLayer.handle({ method: 'GET', path: '/' }, res, () => {});
  const existing = '<html><body><section data-vacancy-panel="TEST-VACANCY"></section><script src="/public/interview-outreach-management.js" defer data-interview-outreach-management></script></body></html>';
  res.send(existing);

  assert.equal(sentBody, existing);
  assert.equal((sentBody.match(/data-interview-outreach-management/g) || []).length, 1);
  assert.equal((sentBody.match(/data-interview-outreach-loading-shell/g) || []).length, 0);
  assert.equal((routeSource.match(/src="\/public\/interview-outreach-management\.js"/g) || []).length, 1);
});
