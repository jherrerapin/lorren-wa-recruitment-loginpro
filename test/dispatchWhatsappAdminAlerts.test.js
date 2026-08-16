import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path) { return fs.readFileSync(path, 'utf8'); }

function assignmentFixture() {
  return {
    id: 'assignment-test-1',
    worker: { fullName: 'Auxiliar Prueba', phone: '3001234567', isTestProfile: false },
    serviceRequest: {
      serviceDate: new Date('2026-08-16T05:00:00.000Z'),
      operationPointName: 'Punto Prueba',
      address: 'Dirección Prueba',
      startTime: '08:00'
    }
  };
}

function matchesEntityId(condition, entityId) {
  if (typeof condition === 'string') return condition === entityId;
  if (Array.isArray(condition?.in)) return condition.in.includes(entityId);
  return true;
}

function schedulerPrisma({ configEvents, assignments = [], confirmationRows = [], runEvents = [], userOverrides = {} }) {
  return {
    devAuditEvent: {
      findMany: async ({ where = {} }) => {
        if (where.entityType === 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG') return configEvents;
        if (where.entityType !== 'DISPATCH_WHATSAPP_AUTOMATION_RUN') return [];
        return runEvents
          .filter((event) => (
            event.entityType === where.entityType
            && (!where.action || event.action === where.action)
            && matchesEntityId(where.entityId, event.entityId)
          ))
          .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
      },
      findFirst: async ({ where = {} }) => runEvents.find((event) => (
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
        id: 'user-test-1',
        username: 'coordinador-test',
        dispatchAlertPhone: '573009998877',
        isActive: true,
        ...userOverrides
      }]
    },
    dispatchAssignment: { findMany: async () => assignments },
    dispatchWhatsappConfirmation: {
      findMany: async ({ where = {} } = {}) => confirmationRows.filter((row) => {
        const ids = where.assignmentId?.in;
        if (Array.isArray(ids) && !ids.includes(row.assignmentId)) return false;
        const gte = where.createdAt?.gte ? new Date(where.createdAt.gte).getTime() : null;
        return !gte || new Date(row.createdAt).getTime() >= gte;
      })
    }
  };
}

function scheduledAssignment({
  id,
  status = 'CONFIRMATION_PENDING',
  fullName = 'Auxiliar Prueba',
  phone = '3001112233',
  serviceDate = '2026-08-16T05:00:00.000Z',
  startTime = '08:00',
  createdAt = '2026-08-15T20:00:00.000Z',
  source = 'MANUAL',
  isTestProfile = false
}) {
  return {
    id,
    serviceRequestId: `request-${id}`,
    workerId: `worker-${id}`,
    status,
    createdByUsername: 'coordinador-test',
    createdAt: new Date(createdAt),
    worker: { id: `worker-${id}`, fullName, phone, isTestProfile },
    serviceRequest: {
      id: `request-${id}`,
      source,
      serviceDate: new Date(serviceDate),
      startTime
    }
  };
}

function withDispatchMetaEnv(run) {
  const keys = [
    'DISPATCH_META_GRAPH_VERSION',
    'DISPATCH_META_ACCESS_TOKEN',
    'DISPATCH_META_PHONE_NUMBER_ID',
    'DISPATCH_META_VERIFY_TOKEN',
    'DISPATCH_META_APP_SECRET'
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    DISPATCH_META_GRAPH_VERSION: 'v23.0',
    DISPATCH_META_ACCESS_TOKEN: 'TEST-token-not-real',
    DISPATCH_META_PHONE_NUMBER_ID: 'TEST-phone-id',
    DISPATCH_META_VERIFY_TOKEN: 'TEST-verify',
    DISPATCH_META_APP_SECRET: 'TEST-secret'
  });
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function notificationAuditStore() {
  const events = [];
  return {
    events,
    api: {
      findMany: async ({ where = {} } = {}) => {
        if (where.entityType === 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG') return [];
        return events.filter((event) => (
          (!where.entityType || event.entityType === where.entityType)
          && (!where.entityId || event.entityId === where.entityId)
          && (!where.action || event.action === where.action)
        )).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      },
      findFirst: async ({ where = {} } = {}) => events
        .filter((event) => (
          (!where.entityType || event.entityType === where.entityType)
          && (!where.entityId || event.entityId === where.entityId)
          && (!where.action || event.action === where.action)
        ))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null,
      create: async ({ data }) => {
        const row = { id: `audit-${events.length + 1}`, ...data, createdAt: data.createdAt || new Date() };
        events.push(row);
        return row;
      }
    }
  };
}

test('configuración del coordinador conserva solo el número de alertas y elimina el recordatorio de ventanas', () => {
  const schema = read('prisma/schema.prisma');
  const dashboard = read('src/views/operacionesDashboard.ejs');
  const dashboardRoute = read('src/routes/dispatchDashboardMetrics.js');
  const alerts = read('src/services/dispatchWhatsappAdminAlerts.js');

  assert.match(schema, /dispatchAlertPhone\s+String\?/);
  assert.match(dashboard, /Mis alertas de despacho por WhatsApp/);
  assert.match(dashboard, /name="dispatchAlertPhone"/);
  assert.doesNotMatch(dashboard, /dispatchWindowExpiryReminderEnabled/);
  assert.doesNotMatch(dashboard, /Recordarme antes de que venza la ventana/);
  assert.doesNotMatch(dashboardRoute, /dispatchWindowExpiryReminderEnabled/);
  assert.doesNotMatch(alerts, /dispatchWindowExpiryReminderEnabled/);
  assert.doesNotMatch(alerts, /dispatchWhatsappWindowReminder\./);
  assert.match(dashboardRoute, /data: \{ dispatchAlertPhone \}/);
});

test('mensaje normal de asignación conserva literalmente el cuerpo canónico y usa dos botones', async () => {
  const client = await import('../src/services/dispatchWhatsappCloudClient.js');
  const payload = client.buildDispatchAssignmentInteractivePayload({ assignment: assignmentFixture(), phone: '3001234567' });
  assert.equal(payload.type, 'interactive');
  assert.deepEqual(payload.interactive.action.buttons.map((button) => button.reply.title), ['CONFIRMADO', 'REPORTAR NOVEDAD']);
  assert.deepEqual(payload.interactive.action.buttons.map((button) => button.reply.id), ['dispatch_confirm:assignment-test-1', 'dispatch_novelty:assignment-test-1']);
});

test('alerta de novedad conserva auxiliar e instrucción de contacto', async () => {
  const { buildDispatchNoveltyAdminAlertText } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
  const text = buildDispatchNoveltyAdminAlertText(assignmentFixture());
  assert.match(text, /Auxiliar Prueba/);
  assert.match(text, /Punto Prueba/);
  assert.match(text, /Comunícate con el auxiliar/);
});

test('envío prioriza ventana de 24h y deja plantilla solo como fallback', () => {
  const assignment = read('src/services/dispatchWhatsappAssignmentService.js');
  assert.match(assignment, /getDispatchWhatsappContactWindowStatus/);
  assert.match(assignment, /contactWindow\.isOpen/);
  assert.match(assignment, /sendCloudAssignmentInteractive/);
  assert.match(assignment, /deliveryMode = 'SESSION_INTERACTIVE'/);
  assert.match(assignment, /deliveryMode = 'TEMPLATE'/);
});

test('cada inbound reinicia la ventana antes de interpretar si es confirmación', () => {
  const webhook = read('src/services/dispatchWhatsappWebhookService.js');
  assert.match(webhook, /recordDispatchWhatsappInboundWindow/);
  assert.ok(webhook.indexOf('recordDispatchWhatsappInboundWindow') < webhook.indexOf('const buttonAction'));
  assert.match(webhook, /sendDispatchNoveltyAdminAlert/);
  assert.match(webhook, /sendDispatchAllConfirmedAdminAlert/);
});

test('un punto del auxiliar renueva lastInboundAt aunque no sea una confirmación', async () => {
  const { recordDispatchWhatsappInboundWindow } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
  let current = { scope: 'operational', phone: '573001112233', lastInboundAt: new Date('2026-08-15T20:00:00.000Z') };
  const prismaClient = {
    dispatchWhatsappContactWindow: {
      findUnique: async () => current,
      update: async ({ data }) => { current = { ...current, ...data }; return current; }
    }
  };
  const result = await recordDispatchWhatsappInboundWindow({
    scope: 'operational',
    message: { from: '3001112233', text: { body: '.' }, timestamp: String(Date.parse('2026-08-15T21:00:00.000Z') / 1000) },
    prismaClient
  });
  assert.equal(new Date(result.lastInboundAt).toISOString(), '2026-08-15T21:00:00.000Z');
});

test('recordatorio de ventana se envía al auxiliar y se deduplica por la ventana renovable', async () => {
  await withDispatchMetaEnv(async () => {
    const { runDispatchWhatsappWindowReminderDispatcher } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
    const audit = notificationAuditStore();
    const outbound = [];
    const now = new Date('2026-08-15T23:00:00.000Z');
    const window = {
      scope: 'operational',
      phone: '573001112233',
      lastInboundAt: new Date('2026-08-14T23:24:00.000Z')
    };
    const prismaClient = {
      devAuditEvent: audit.api,
      dispatchWhatsappContactWindow: { findMany: async () => [window] },
      dispatchWhatsappConfirmation: {
        findMany: async () => [{
          status: 'SENT',
          assignment: scheduledAssignment({ id: 'window-reminder', serviceDate: '2026-08-16T05:00:00.000Z' })
        }]
      },
      appUser: { findMany: async () => [] }
    };
    const axiosClient = {
      post: async (_url, payload) => {
        outbound.push(payload);
        return { data: { messages: [{ id: `wamid-${outbound.length}` }] } };
      }
    };

    const first = await runDispatchWhatsappWindowReminderDispatcher(prismaClient, { now, axiosClient });
    assert.equal(first.sent, 1);
    assert.equal(outbound[0].to, '573001112233');
    assert.match(outbound[0].text.body, /punto \(\.\)/);
    assert.match(outbound[0].text.body, /25 minutos/);

    const duplicate = await runDispatchWhatsappWindowReminderDispatcher(prismaClient, { now: new Date(now.getTime() + 60_000), axiosClient });
    assert.equal(duplicate.sent, 0);
    assert.equal(outbound.length, 1);

    window.lastInboundAt = new Date('2026-08-15T00:24:00.000Z');
    const renewedNow = new Date('2026-08-15T23:59:00.000Z');
    const renewed = await runDispatchWhatsappWindowReminderDispatcher(prismaClient, { now: renewedNow, axiosClient });
    assert.equal(renewed.sent, 1);
    assert.equal(outbound.length, 2);
  });
});

test('horario automático se guarda por usuario sin conservar el reporte horario de pendientes', async () => {
  const {
    isDispatchBogotaScheduleDue,
    loadDispatchWhatsappAutomationSettings,
    normalizeDispatchAutomationTime,
    saveDispatchWhatsappAutomationSettings
  } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
  const events = [];
  const prismaClient = {
    devAuditEvent: {
      create: async ({ data }) => { events.push({ ...data, createdAt: new Date('2026-08-15T20:00:00.000Z') }); return data; },
      findFirst: async ({ where }) => events.filter((event) => (
        event.entityType === where.entityType && event.entityId === where.entityId && event.action === where.action
      )).at(-1) || null
    }
  };

  assert.equal(normalizeDispatchAutomationTime('18:05'), '18:05');
  assert.equal(normalizeDispatchAutomationTime('25:00'), null);
  assert.equal(isDispatchBogotaScheduleDue('18:00', new Date('2026-08-15T23:30:00.000Z')), true);

  await saveDispatchWhatsappAutomationSettings({ prismaClient, userId: 'user-test-1', assignmentAutoSendTime: '18:30' });
  assert.deepEqual(await loadDispatchWhatsappAutomationSettings({ prismaClient, userId: 'user-test-1' }), { assignmentAutoSendTime: '18:30' });

  events.push({
    entityType: 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG', entityId: 'user-test-legacy', action: 'SET_DISPATCH_WHATSAPP_AUTOMATION',
    metadata: { assignmentAutoSendTime: '17:00', pendingConfirmationAlertTime: '19:00' }, createdAt: new Date('2026-08-15T20:00:00.000Z')
  });
  assert.deepEqual(await loadDispatchWhatsappAutomationSettings({ prismaClient, userId: 'user-test-legacy' }), { assignmentAutoSendTime: '17:00' });
});

test('scheduler envía pendientes sin evidencia previa y no genera reporte al coordinador', async () => {
  const { runDispatchUserAutomationScheduler } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
  const now = new Date('2026-08-15T23:30:00.000Z');
  const configEvents = [{
    entityType: 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG', entityId: 'user-test-1', action: 'SET_DISPATCH_WHATSAPP_AUTOMATION',
    metadata: { assignmentAutoSendTime: '18:30', pendingConfirmationAlertTime: '19:15' }, createdAt: new Date('2026-08-14T20:00:00.000Z')
  }];
  const runEvents = [];
  const confirmationRows = [{ assignmentId: 'already-sent', status: 'SENT', createdAt: new Date('2026-08-15T23:00:00.000Z') }];
  const unsent = scheduledAssignment({ id: 'needs-send' });
  const alreadySent = scheduledAssignment({ id: 'already-sent', phone: '3002223344' });
  const prismaClient = schedulerPrisma({ configEvents, assignments: [unsent, alreadySent], confirmationRows, runEvents });
  const assignmentSends = [];
  const sendAssignmentMessage = async ({ context, phone, actorUsername }) => {
    assignmentSends.push({ assignmentId: context.assignmentId, phone, actorUsername });
    confirmationRows.push({ assignmentId: context.assignmentId, status: 'SENT', createdAt: now });
    return { providerMessageId: 'wamid-test-send' };
  };

  const first = await runDispatchUserAutomationScheduler(prismaClient, { now, sendAssignmentMessage });
  assert.equal(first.targetDateKey, '2026-08-16');
  assert.equal(first.assignmentSent, 1);
  assert.equal('pendingAlertsSent' in first, false);
  assert.deepEqual(assignmentSends, [{ assignmentId: 'needs-send', phone: '573001112233', actorUsername: 'coordinador-test' }]);

  const second = await runDispatchUserAutomationScheduler(prismaClient, { now, sendAssignmentMessage });
  assert.equal(second.assignmentSent, 0);
  assert.equal(assignmentSends.length, 1);
});

test('un fallo transitorio espera cinco minutos y luego recupera el envío automático', async () => {
  const { runDispatchUserAutomationScheduler } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
  const configEvents = [{
    entityType: 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG', entityId: 'user-test-1', action: 'SET_DISPATCH_WHATSAPP_AUTOMATION',
    metadata: { assignmentAutoSendTime: '18:30' }, createdAt: new Date('2026-08-14T20:00:00.000Z')
  }];
  const runEvents = [];
  const confirmationRows = [];
  const assignment = scheduledAssignment({ id: 'transient-retry' });
  const prismaClient = schedulerPrisma({ configEvents, assignments: [assignment], confirmationRows, runEvents });
  let attempts = 0;
  const sendAssignmentMessage = async ({ context }) => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('fallo temporal simulado'), { code: 'provider_temporal' });
    confirmationRows.push({ assignmentId: context.assignmentId, status: 'SENT', createdAt: new Date('2026-08-15T23:36:00.000Z') });
    return { providerMessageId: 'wamid-recovered' };
  };

  const first = await runDispatchUserAutomationScheduler(prismaClient, { now: new Date('2026-08-15T23:31:00.000Z'), sendAssignmentMessage });
  assert.equal(first.assignmentFailed, 1);
  const tooSoon = await runDispatchUserAutomationScheduler(prismaClient, { now: new Date('2026-08-15T23:32:00.000Z'), sendAssignmentMessage });
  assert.equal(tooSoon.assignmentAttempts, 0);
  const recovered = await runDispatchUserAutomationScheduler(prismaClient, { now: new Date('2026-08-15T23:36:00.000Z'), sendAssignmentMessage });
  assert.equal(recovered.assignmentSent, 1);
  assert.equal(attempts, 2);
});

test('tres fallos automáticos agotan los reintentos del día', async () => {
  const { runDispatchUserAutomationScheduler } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
  const configEvents = [{
    entityType: 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG', entityId: 'user-test-1', action: 'SET_DISPATCH_WHATSAPP_AUTOMATION',
    metadata: { assignmentAutoSendTime: '18:30' }, createdAt: new Date('2026-08-14T20:00:00.000Z')
  }];
  const runEvents = [];
  const prismaClient = schedulerPrisma({ configEvents, assignments: [scheduledAssignment({ id: 'bounded-retry' })], runEvents });
  let attempts = 0;
  const sendAssignmentMessage = async () => { attempts += 1; throw Object.assign(new Error('fallo simulado'), { code: 'provider_down' }); };
  for (const at of ['2026-08-15T23:31:00.000Z', '2026-08-15T23:36:00.000Z', '2026-08-15T23:41:00.000Z']) {
    const result = await runDispatchUserAutomationScheduler(prismaClient, { now: new Date(at), sendAssignmentMessage });
    assert.equal(result.assignmentFailed, 1);
  }
  const exhausted = await runDispatchUserAutomationScheduler(prismaClient, { now: new Date('2026-08-15T23:46:00.000Z'), sendAssignmentMessage });
  assert.equal(exhausted.assignmentAttempts, 0);
  assert.equal(attempts, 3);
});

test('aviso de todos confirmados sale una vez por composición y no sale mientras exista un pendiente', async () => {
  await withDispatchMetaEnv(async () => {
    const { sendDispatchAllConfirmedAdminAlert } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
    const audit = notificationAuditStore();
    const assignments = [
      scheduledAssignment({ id: 'confirmed-a', status: 'CONFIRMED' }),
      scheduledAssignment({ id: 'pending-b', status: 'CONFIRMATION_PENDING', phone: '3002223344' })
    ];
    const outbound = [];
    const prismaClient = {
      devAuditEvent: audit.api,
      appUser: {
        findUnique: async () => ({ id: 'user-test-1', username: 'coordinador-test', isActive: true, dispatchAlertPhone: '573009998877' })
      },
      dispatchAssignment: { findMany: async () => assignments }
    };
    const axiosClient = {
      post: async (_url, payload) => { outbound.push(payload); return { data: { messages: [{ id: `wamid-admin-${outbound.length}` }] } }; }
    };
    const target = assignments[0];
    const link = { alertOwnerUsername: 'coordinador-test' };

    const pending = await sendDispatchAllConfirmedAdminAlert({ scope: 'operational', link, assignment: target, prismaClient, axiosClient });
    assert.equal(pending.sent, false);
    assert.equal(pending.reason, 'pending_assignments');
    assert.equal(outbound.length, 0);

    assignments[1].status = 'CONFIRMED';
    const complete = await sendDispatchAllConfirmedAdminAlert({ scope: 'operational', link, assignment: target, prismaClient, axiosClient });
    assert.equal(complete.sent, true);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].to, '573009998877');
    assert.match(outbound[0].text.body, /Todos tus auxiliares/);

    const duplicate = await sendDispatchAllConfirmedAdminAlert({ scope: 'operational', link, assignment: target, prismaClient, axiosClient });
    assert.equal(duplicate.sent, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(outbound.length, 1);

    assignments.push(scheduledAssignment({ id: 'confirmed-c', status: 'CONFIRMED', phone: '3003334455' }));
    const changedComposition = await sendDispatchAllConfirmedAdminAlert({ scope: 'operational', link, assignment: target, prismaClient, axiosClient });
    assert.equal(changedComposition.sent, true);
    assert.equal(outbound.length, 2);
  });
});

test('UI conserva solo hora de envío y explica el aviso automático de todos confirmados', () => {
  const route = read('src/routes/dispatchWhatsappNotifications.js');
  const view = read('src/views/operacionesWhatsappEstado.ejs');
  assert.match(route, /router\.post\('\/programacion-automatica'/);
  assert.match(route, /saveDispatchWhatsappAutomationSettings/);
  assert.doesNotMatch(route, /pendingConfirmationAlertTime/);
  assert.doesNotMatch(route, /dispatchPendingConfirmationAlertTime/);
  assert.match(view, /Envío automático de confirmaciones/);
  assert.match(view, /name="dispatchAssignmentAutoSendTime"/);
  assert.doesNotMatch(view, /dispatchPendingConfirmationAlertTime/);
  assert.doesNotMatch(view, /Avisarme quiénes siguen sin confirmar/);
  assert.match(view, /todos tus auxiliares activos de una misma fecha hayan confirmado/);
});
