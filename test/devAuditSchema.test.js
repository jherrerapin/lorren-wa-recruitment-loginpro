import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

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
