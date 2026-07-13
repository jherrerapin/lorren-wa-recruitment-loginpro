import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { buildDispatchAuditEventData } from '../src/services/dispatchAuditMiddleware.js';

const REQUIRED_DEV_AUDIT_FIELDS = [
  'id',
  'entityType',
  'entityId',
  'entityLabel',
  'action',
  'actorUserId',
  'actorUsername',
  'actorRole',
  'actorSource',
  'ipAddress',
  'forwardedFor',
  'userAgent',
  'method',
  'path',
  'fromValue',
  'toValue',
  'metadata',
  'createdAt'
];

test('Prisma expone el contrato de DevAuditEvent usado por la pantalla de vacantes', () => {
  const model = Prisma.dmmf.datamodel.models.find((entry) => entry.name === 'DevAuditEvent');

  assert.ok(model, 'El modelo DevAuditEvent debe existir en el cliente Prisma generado');

  const availableFields = new Set(model.fields.map((field) => field.name));
  const missingFields = REQUIRED_DEV_AUDIT_FIELDS.filter((field) => !availableFields.has(field));

  assert.deepEqual(
    missingFields,
    [],
    `Faltan campos de auditoría requeridos por /admin/vacancies: ${missingFields.join(', ')}`
  );
});

test('la auditoría de despacho usa el contrato actual y no los campos heredados', () => {
  const request = {
    method: 'POST',
    path: '/admin/operaciones/asignaciones/assign',
    originalUrl: '/admin/operaciones/asignaciones/assign',
    body: { assignmentId: 'assignment-1' },
    params: {},
    query: {},
    session: { username: 'operador-prueba', userRole: 'admin' },
    get(header) {
      if (header === 'user-agent') return 'node-test';
      if (header === 'referer') return 'https://example.test/admin/operaciones';
      return null;
    }
  };

  const data = buildDispatchAuditEventData(request, { statusCode: 200 }, Date.now());

  assert.equal(data.entityType, 'DISPATCH');
  assert.equal(data.entityId, 'assignment-1');
  assert.equal(data.action, 'DISPATCH_ASSIGNMENT_CREATE');
  assert.equal(data.actorUsername, 'operador-prueba');
  assert.equal(data.actorRole, 'admin');
  assert.equal(data.method, 'POST');
  assert.equal(data.metadata.statusCode, 200);
  assert.equal(Object.hasOwn(data, 'username'), false);
  assert.equal(Object.hasOwn(data, 'target'), false);
  assert.equal(Object.hasOwn(data, 'detail'), false);
});
