import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { runDispatchUserAutomationScheduler } from '../src/services/dispatchWhatsappAdminAlerts.js';

function schedulerPrisma({ confirmationRows = [] } = {}) {
  const config = {
    id: 'config-1',
    entityType: 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG',
    entityId: 'user-1',
    action: 'SET_DISPATCH_WHATSAPP_AUTOMATION',
    metadata: { assignmentAutoSendTime: '18:30' },
    createdAt: new Date('2026-08-12T20:00:00.000Z')
  };
  const assignment = {
    id: 'assignment-1',
    serviceRequestId: 'request-1',
    workerId: 'worker-1',
    status: 'CONFIRMATION_PENDING',
    createdByUsername: 'coordinador-prueba',
    createdAt: new Date('2026-08-13T20:00:00.000Z'),
    worker: { id: 'worker-1', fullName: 'Auxiliar Prueba', phone: '3001112233', isTestProfile: false },
    serviceRequest: {
      id: 'request-1',
      source: 'MANUAL',
      serviceDate: new Date('2026-08-14T05:00:00.000Z'),
      startTime: '08:00'
    }
  };
  return {
    devAuditEvent: {
      findMany: async ({ where = {} }) => {
        if (where.entityType === 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG') return [config];
        return [];
      },
      create: async ({ data }) => data
    },
    appUser: {
      findMany: async () => [{ id: 'user-1', username: 'coordinador-prueba', dispatchAlertPhone: null, isActive: true }]
    },
    dispatchAssignment: { findMany: async () => [assignment] },
    dispatchWhatsappConfirmation: { findMany: async () => confirmationRows }
  };
}

test('una confirmación activa anterior al día actual bloquea un reenvío automático', async () => {
  const prismaClient = schedulerPrisma({
    confirmationRows: [{ assignmentId: 'assignment-1', status: 'SENT', createdAt: new Date('2026-08-12T23:00:00.000Z') }]
  });
  let sends = 0;
  const result = await runDispatchUserAutomationScheduler(prismaClient, {
    now: new Date('2026-08-14T00:30:00.000Z'),
    sendAssignmentMessage: async () => { sends += 1; return { providerMessageId: 'wamid-no-deberia-enviarse' }; }
  });
  assert.equal(result.assignmentAttempts, 0);
  assert.equal(result.assignmentSent, 0);
  assert.equal(sends, 0);
});

test('el scheduler conserva una sola autoridad de envío y elimina el reporte programado de pendientes', () => {
  const source = fs.readFileSync('src/services/dispatchWhatsappAdminAlerts.js', 'utf8');
  assert.match(source, /async function runAutomaticAssignmentSends/);
  assert.match(source, /export async function runDispatchUserAutomationScheduler/);
  assert.doesNotMatch(source, /runPendingConfirmationAlert/);
  assert.doesNotMatch(source, /PENDING_CONFIRMATION_ALERT/);
  assert.doesNotMatch(source, /pendingConfirmationAlertTime/);
  assert.doesNotMatch(source, /sendAdminMessage/);
});
