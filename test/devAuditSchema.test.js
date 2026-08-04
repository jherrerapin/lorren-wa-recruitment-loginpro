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

function testHeaders(values = {}) {
  return function get(header) {
    return values[String(header || '').toLowerCase()] || null;
  };
}

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

test('la auditoría de despacho persiste únicamente metadatos técnicos permitidos', () => {
  const request = {
    method: 'POST',
    baseUrl: '/admin/operaciones',
    route: { path: '/asignaciones/assign' },
    path: '/admin/operaciones/asignaciones/assign',
    originalUrl: '/admin/operaciones/asignaciones/assign?TEST-QUERY-SECRET=TEST-VALUE',
    body: { assignmentId: 'TEST-ASSIGNMENT-ID' },
    params: { assignmentId: 'TEST-ASSIGNMENT-ID' },
    query: { token: 'TEST-QUERY-TOKEN' },
    session: { username: 'TEST-OPERATOR', userRole: 'admin' },
    get: testHeaders({
      'user-agent': 'TEST-USER-AGENT',
      referer: 'https://example.test/TEST-PRIVATE-REFERER',
      authorization: 'Bearer TEST-AUTHORIZATION',
      cookie: 'TEST-COOKIE=TEST-COOKIE-VALUE'
    })
  };

  const data = buildDispatchAuditEventData(request, { statusCode: 200 }, Date.now());

  assert.equal(data.entityType, 'DISPATCH');
  assert.match(data.entityId, /^audit-[a-f0-9]{24}$/);
  assert.equal(data.entityLabel, '/admin/operaciones/asignaciones/assign');
  assert.equal(data.action, 'DISPATCH_ASSIGNMENT_CREATE');
  assert.match(data.actorUsername, /^audit-[a-f0-9]{24}$/);
  assert.equal(data.actorRole, 'admin');
  assert.equal(data.method, 'POST');
  assert.equal(data.path, '/admin/operaciones/asignaciones/assign');
  assert.deepEqual(Object.keys(data.metadata).sort(), ['durationMs', 'operationResult', 'statusCode']);
  assert.equal(data.metadata.statusCode, 200);
  assert.equal(data.metadata.operationResult, 'SUCCESS');
  assert.equal(Object.hasOwn(data, 'userAgent'), false);
  assert.equal(Object.hasOwn(data, 'username'), false);
  assert.equal(Object.hasOwn(data, 'target'), false);
  assert.equal(Object.hasOwn(data, 'detail'), false);
});

test('tokens, credenciales, PII, coordenadas, adjuntos y notas no quedan en el evento', () => {
  const sensitiveValues = [
    'TEST-PUBLIC-TOKEN-0123456789ABCDEF',
    'TEST-AUTHORIZATION-CREDENTIAL',
    'TEST-COOKIE-CREDENTIAL',
    'TEST-PASSWORD-CREDENTIAL',
    'TEST-DOCUMENT-1234567890',
    'TEST-PHONE-3000000001',
    'TEST-EMAIL@example.test',
    'TEST-LATITUDE-4.1234567',
    'TEST-LONGITUDE--74.1234567',
    'TEST-ATTACHMENT-CONTENT',
    'TEST-FREE-NOTE-WITH-PII',
    'TEST-OPERATOR@example.test'
  ];
  const request = {
    method: 'POST',
    baseUrl: '/operaciones',
    route: { path: '/cliente/:publicToken' },
    path: '/operaciones/cliente/TEST-PUBLIC-TOKEN-0123456789ABCDEF',
    originalUrl: '/operaciones/cliente/TEST-PUBLIC-TOKEN-0123456789ABCDEF?token=TEST-QUERY-TOKEN',
    body: {
      password: 'TEST-PASSWORD-CREDENTIAL',
      documentNumber: 'TEST-DOCUMENT-1234567890',
      requestedByPhone: 'TEST-PHONE-3000000001',
      requestedByEmail: 'TEST-EMAIL@example.test',
      latitude: 'TEST-LATITUDE-4.1234567',
      longitude: 'TEST-LONGITUDE--74.1234567',
      attachment: 'TEST-ATTACHMENT-CONTENT',
      notes: 'TEST-FREE-NOTE-WITH-PII'
    },
    params: { publicToken: 'TEST-PUBLIC-TOKEN-0123456789ABCDEF' },
    query: { token: 'TEST-QUERY-TOKEN' },
    session: { username: 'TEST-OPERATOR@example.test', userRole: 'admin' },
    get: testHeaders({
      authorization: 'Bearer TEST-AUTHORIZATION-CREDENTIAL',
      cookie: 'TEST-COOKIE=TEST-COOKIE-CREDENTIAL',
      'user-agent': 'TEST-USER-AGENT',
      referer: 'https://example.test/TEST-PRIVATE-REFERER'
    })
  };

  const data = buildDispatchAuditEventData(request, { statusCode: 201 }, Date.now());
  const serialized = JSON.stringify(data);

  assert.equal(data.path, '/operaciones/cliente/:publicToken');
  assert.equal(data.entityLabel, '/operaciones/cliente/:publicToken');
  assert.equal(data.metadata.operationResult, 'SUCCESS');
  for (const value of sensitiveValues) {
    assert.equal(serialized.includes(value), false, `La auditoría no debe persistir ${value}`);
  }
  for (const forbiddenKey of [
    'body',
    'params',
    'query',
    'referer',
    'authorization',
    'cookie',
    'password',
    'documentNumber',
    'requestedByPhone',
    'requestedByEmail',
    'latitude',
    'longitude',
    'attachment',
    'notes'
  ]) {
    assert.equal(Object.hasOwn(data.metadata, forbiddenKey), false);
  }
});

test('la ruta de respaldo elimina tokens aunque Express no exponga la plantilla', () => {
  const token = '0123456789abcdef0123456789abcdef0123456789abcdef';
  const request = {
    method: 'POST',
    path: `/operaciones/cliente/${token}`,
    originalUrl: `/operaciones/cliente/${token}?password=TEST-PASSWORD`,
    body: {},
    params: { publicToken: token },
    query: { password: 'TEST-PASSWORD' },
    session: {},
    get: testHeaders()
  };

  const data = buildDispatchAuditEventData(request, { statusCode: 204 }, Date.now());
  const serialized = JSON.stringify(data);

  assert.equal(data.path, '/operaciones/cliente/:token');
  assert.equal(data.entityLabel, '/operaciones/cliente/:token');
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('TEST-PASSWORD'), false);
});
