import assert from 'node:assert/strict';
import test from 'node:test';
import { runDispatchUserAutomationScheduler } from '../src/services/dispatchWhatsappAdminAlerts.js';

function matchesEntityId(condition, entityId) {
  if (typeof condition === 'string') return condition === entityId;
  if (Array.isArray(condition?.in)) return condition.in.includes(entityId);
  return true;
}

function buildPrisma({ config, assignmentsByMode, confirmations = [], runEvents = [] }) {
  return {
    devAuditEvent: {
      findMany: async ({ where = {} }) => {
        if (where.entityType === 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG') return [config];
        if (where.entityType !== 'DISPATCH_WHATSAPP_AUTOMATION_RUN') return [];
        return runEvents
          .filter((event) => (
            event.entityType === where.entityType
            && (!where.action || event.action === where.action)
            && matchesEntityId(where.entityId, event.entityId)
          ))
          .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
      },
      findFirst: async ({ where }) => runEvents.find((event) => (
        event.entityType === where.entityType
        && event.entityId === where.entityId
        && event.action === where.action
      )) || null,
      create: async ({ data }) => {
        const row = { ...data, id: `run-${runEvents.length + 1}`, createdAt: data.createdAt || new Date() };
        runEvents.push(row);
        return row;
      }
    },
    appUser: {
      findMany: async () => [{
        id: config.entityId,
        username: 'coordinador-recovery',
        dispatchAlertPhone: '15550000001',
        isActive: true
      }]
    },
    dispatchAssignment: {
      findMany: async () => [...assignmentsByMode.assigned, ...assignmentsByMode.pending]
    },
    dispatchWhatsappConfirmation: {
      findMany: async ({ where = {} } = {}) => confirmations.filter((row) => {
        const ids = where.assignmentId?.in;
        if (Array.isArray(ids) && !ids.includes(row.assignmentId)) return false;
        const gte = where.createdAt?.gte ? new Date(where.createdAt.gte).getTime() : null;
        return !gte || new Date(row.createdAt).getTime() >= gte;
      })
    }
  };
}

function assignment({ id, status = 'ASSIGNED', startTime = '08:00', createdAt = '2026-08-12T21:00:00.000Z' }) {
  return {
    id,
    serviceRequestId: `request-${id}`,
    workerId: `worker-${id}`,
    status,
    createdByUsername: 'coordinador-recovery',
    createdAt: new Date(createdAt),
    worker: { id: `worker-${id}`, fullName: `Auxiliar ${id}`, phone: '15550000002' },
    serviceRequest: {
      id: `request-${id}`,
      source: 'MANUAL',
      serviceDate: new Date('2026-08-13T05:00:00.000Z'),
      startTime
    }
  };
}

test('recupera D→D+1 después de medianoche y omite turnos que ya iniciaron', async () => {
  const runEvents = [];
  const assignmentSends = [];
  const adminSends = [];
  const future = assignment({ id: 'future', startTime: '08:00' });
  const started = assignment({ id: 'started', startTime: '00:05' });
  const pendingFuture = assignment({ id: 'pending-future', status: 'CONFIRMATION_PENDING', startTime: '08:00' });
  const pendingStarted = assignment({ id: 'pending-started', status: 'CONFIRMATION_PENDING', startTime: '00:05' });
  const confirmations = [
    { assignmentId: 'pending-future', status: 'SENT', createdAt: new Date('2026-08-12T23:00:00.000Z') },
    { assignmentId: 'pending-started', status: 'SENT', createdAt: new Date('2026-08-12T23:00:00.000Z') }
  ];
  const config = {
    id: 'config-recovery',
    entityType: 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG',
    entityId: 'user-recovery',
    action: 'SET_DISPATCH_WHATSAPP_AUTOMATION',
    metadata: { assignmentAutoSendTime: '19:00', pendingConfirmationAlertTime: '20:00' },
    createdAt: new Date('2026-08-12T15:00:00.000Z')
  };
  const prismaClient = buildPrisma({
    config,
    assignmentsByMode: { assigned: [future, started], pending: [pendingFuture, pendingStarted] },
    confirmations,
    runEvents
  });
  const sendAssignmentMessage = async ({ context }) => {
    assignmentSends.push(context.assignmentId);
    confirmations.push({ assignmentId: context.assignmentId, status: 'SENT', createdAt: new Date('2026-08-13T05:15:00.000Z') });
    return { providerMessageId: 'wamid-recovery' };
  };
  const sendAdminMessage = async ({ text }) => {
    adminSends.push(text);
    return 'wamid-admin-recovery';
  };
  const now = new Date('2026-08-13T05:15:00.000Z'); // 00:15 Colombia.

  const first = await runDispatchUserAutomationScheduler(prismaClient, { now, sendAssignmentMessage, sendAdminMessage });
  assert.equal(first.targetDateKey, '2026-08-14');
  assert.equal(first.recoveryTargetDateKey, '2026-08-13');
  assert.equal(first.recoveryAssignmentSent, 1);
  assert.equal(first.recoveryPendingAlertsSent, 1);
  assert.deepEqual(assignmentSends, ['future']);
  assert.equal(adminSends.length, 1);
  assert.match(adminSends[0], /pending-future/);
  assert.doesNotMatch(adminSends[0], /pending-started/);

  const second = await runDispatchUserAutomationScheduler(prismaClient, { now, sendAssignmentMessage, sendAdminMessage });
  assert.equal(second.recoveryAssignmentSent, 0);
  assert.equal(second.recoveryPendingAlertsSent, 0);
  assert.deepEqual(assignmentSends, ['future']);
  assert.equal(adminSends.length, 1);
});

test('23:59 en Colombia conserva la tanda normal para D+1', async () => {
  const sends = [];
  const confirmations = [];
  const tomorrow = assignment({ id: 'tomorrow', startTime: '08:00', createdAt: '2026-08-13T20:00:00.000Z' });
  tomorrow.serviceRequest.serviceDate = new Date('2026-08-14T05:00:00.000Z');
  const config = {
    id: 'config-normal',
    entityType: 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG',
    entityId: 'user-normal',
    action: 'SET_DISPATCH_WHATSAPP_AUTOMATION',
    metadata: { assignmentAutoSendTime: '19:00', pendingConfirmationAlertTime: null },
    createdAt: new Date('2026-08-13T10:00:00.000Z')
  };
  const prismaClient = buildPrisma({
    config,
    assignmentsByMode: { assigned: [tomorrow], pending: [] },
    confirmations
  });
  const sendAssignmentMessage = async ({ context }) => {
    sends.push(context.assignmentId);
    confirmations.push({ assignmentId: context.assignmentId, status: 'SENT', createdAt: new Date('2026-08-14T04:59:00.000Z') });
    return { providerMessageId: 'wamid-normal' };
  };
  const now = new Date('2026-08-14T04:59:00.000Z'); // 23:59 Colombia del 13/08.

  const result = await runDispatchUserAutomationScheduler(prismaClient, { now, sendAssignmentMessage });
  assert.equal(result.targetDateKey, '2026-08-14');
  assert.equal(result.assignmentSent, 1);
  assert.equal(result.recoveryAssignmentSent, 0);
  assert.deepEqual(sends, ['tomorrow']);
});

test('una configuración guardada el mismo día no fabrica una recuperación del día anterior', async () => {
  const sends = [];
  const today = assignment({ id: 'today-new-config', startTime: '08:00' });
  const config = {
    id: 'config-new',
    entityType: 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG',
    entityId: 'user-new',
    action: 'SET_DISPATCH_WHATSAPP_AUTOMATION',
    metadata: { assignmentAutoSendTime: '19:00', pendingConfirmationAlertTime: null },
    createdAt: new Date('2026-08-13T05:05:00.000Z')
  };
  const prismaClient = buildPrisma({
    config,
    assignmentsByMode: { assigned: [today], pending: [] }
  });
  const sendAssignmentMessage = async ({ context }) => {
    sends.push(context.assignmentId);
    return { providerMessageId: 'wamid-should-not-send' };
  };
  const now = new Date('2026-08-13T05:15:00.000Z');

  const result = await runDispatchUserAutomationScheduler(prismaClient, { now, sendAssignmentMessage });
  assert.equal(result.recoveryAssignmentSent, 0);
  assert.deepEqual(sends, []);
});
