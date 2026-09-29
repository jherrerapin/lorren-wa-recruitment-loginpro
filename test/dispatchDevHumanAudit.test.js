import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  buildDispatchAuditEventData,
  loadDispatchDevActivity
} from '../src/services/dispatchAuditMiddleware.js';

function requestFor(path, { method = 'POST', userId = 'user-coord-test', username = 'coordinador-prueba' } = {}) {
  return {
    method,
    path,
    originalUrl: path,
    baseUrl: '',
    route: null,
    body: {},
    session: {
      userId,
      username,
      userRole: 'coordinator'
    }
  };
}

test('auditoría operativa conserva el actor resoluble y distingue creación de solicitud y confirmación manual', () => {
  const created = buildDispatchAuditEventData(
    requestFor('/admin/operaciones/solicitudes'),
    { statusCode: 302 },
    Date.now()
  );
  assert.equal(created.action, 'DISPATCH_SERVICE_REQUEST_CREATE');
  assert.equal(created.actorUserId, 'user-coord-test');
  assert.match(created.actorUsername, /^audit-[a-f0-9]{24}$/);

  const confirmed = buildDispatchAuditEventData(
    requestFor('/admin/operaciones/asignaciones/confirmar'),
    { statusCode: 200 },
    Date.now()
  );
  assert.equal(confirmed.action, 'DISPATCH_ASSIGNMENT_CONFIRM');
  assert.equal(confirmed.actorUserId, 'user-coord-test');
});

test('DEV recibe trazabilidad con textos claros, usuario humano y hora sin códigos técnicos', async () => {
  const prisma = {
    devAuditEvent: {
      findMany: async ({ where, take }) => {
        assert.equal(where.entityType, 'DISPATCH');
        assert.ok(where.action.in.includes('DISPATCH_SERVICE_REQUEST_CREATE'));
        assert.ok(where.action.in.includes('DISPATCH_ASSIGNMENT_CREATE'));
        assert.ok(where.action.in.includes('DISPATCH_ASSIGNMENT_CONFIRM'));
        assert.equal(take, 80);
        return [
          {
            id: 'audit-1',
            action: 'DISPATCH_SERVICE_REQUEST_CREATE',
            actorUserId: 'user-coord-test',
            actorRole: 'coordinator',
            actorSource: 'dashboard',
            createdAt: new Date('2026-09-29T13:30:00.000Z')
          },
          {
            id: 'audit-2',
            action: 'DISPATCH_ASSIGNMENT_CREATE',
            actorUserId: 'user-super-test',
            actorRole: 'supervisor',
            actorSource: 'dashboard',
            createdAt: new Date('2026-09-29T13:35:00.000Z')
          },
          {
            id: 'audit-3',
            action: 'DISPATCH_ASSIGNMENT_CONFIRM',
            actorUserId: 'user-coord-test',
            actorRole: 'coordinator',
            actorSource: 'dashboard',
            createdAt: new Date('2026-09-29T13:40:00.000Z')
          }
        ];
      }
    },
    appUser: {
      findMany: async ({ where }) => {
        assert.deepEqual(new Set(where.id.in), new Set(['user-coord-test', 'user-super-test']));
        return [
          { id: 'user-coord-test', username: 'coord-prueba', displayName: 'Coordinación Prueba' },
          { id: 'user-super-test', username: 'super-prueba', displayName: 'Supervisión Prueba' }
        ];
      }
    }
  };

  const activity = await loadDispatchDevActivity(prisma);
  assert.deepEqual(activity.map((item) => item.label), [
    'Solicitud creada',
    'Asignación creada',
    'Confirmación manual registrada'
  ]);
  assert.deepEqual(activity.map((item) => item.actor), [
    'Coordinación Prueba',
    'Supervisión Prueba',
    'Coordinación Prueba'
  ]);
  assert.equal(activity.every((item) => item.at && !item.at.includes('T')), true);
});

test('panel DEV inyecta la trazabilidad en el monitor existente y no crea una página paralela', () => {
  const source = fs.readFileSync('src/services/dispatchAuditMiddleware.js', 'utf8');
  assert.match(source, /const DEV_MONITOR_PATH = '\/admin\/monitor'/);
  assert.match(source, /Trazabilidad de Despacho/);
  assert.match(source, /Solo DEV/);
  assert.match(source, /requestPath\(req\) !== DEV_MONITOR_PATH \|\| role !== 'dev'/);
  assert.match(source, /injectDispatchDevActivity\(withProgrammingCopy, req\)/);
});
