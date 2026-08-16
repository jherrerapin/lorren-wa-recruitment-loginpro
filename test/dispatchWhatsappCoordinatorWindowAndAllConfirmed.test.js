import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

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
  return Promise.resolve().then(run).finally(() => {
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

function assignment({ id, status = 'CONFIRMED', phone = '3001112233' } = {}) {
  return {
    id,
    serviceRequestId: `request-${id}`,
    workerId: `worker-${id}`,
    status,
    createdByUsername: 'coordinador-test',
    createdAt: new Date('2026-08-15T18:00:00.000Z'),
    worker: { id: `worker-${id}`, fullName: 'Auxiliar Prueba', phone, isTestProfile: false },
    serviceRequest: {
      id: `request-${id}`,
      source: 'MANUAL',
      serviceDate: new Date('2026-08-16T05:00:00.000Z'),
      startTime: '08:00'
    }
  };
}

test('se conserva el horario de quiénes faltan por confirmar', () => {
  const route = fs.readFileSync('src/routes/dispatchWhatsappNotifications.js', 'utf8');
  const view = fs.readFileSync('src/views/operacionesWhatsappEstado.ejs', 'utf8');
  const service = fs.readFileSync('src/services/dispatchWhatsappAdminAlerts.js', 'utf8');
  assert.match(route, /dispatchPendingConfirmationAlertTime/);
  assert.match(route, /pendingConfirmationAlertTime/);
  assert.match(view, /Avisarme quiénes siguen sin confirmar/);
  assert.match(view, /name="dispatchPendingConfirmationAlertTime"/);
  assert.match(service, /PENDING_ALERT_ACTION/);
  assert.match(service, /runPendingConfirmationAlert/);
  assert.match(service, /pendingConfirmationAlertTime/);
});

test('un punto del coordinador renueva su propia ventana', async () => {
  const { recordDispatchWhatsappInboundWindow } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
  let current = {
    scope: 'operational',
    phone: '573009998877',
    lastInboundAt: new Date('2026-08-15T20:00:00.000Z')
  };
  const prismaClient = {
    dispatchWhatsappContactWindow: {
      findUnique: async () => current,
      update: async ({ data }) => { current = { ...current, ...data }; return current; }
    }
  };
  const result = await recordDispatchWhatsappInboundWindow({
    scope: 'operational',
    message: {
      from: '3009998877',
      text: { body: '.' },
      timestamp: String(Date.parse('2026-08-15T21:00:00.000Z') / 1000)
    },
    prismaClient
  });
  assert.equal(new Date(result.lastInboundAt).toISOString(), '2026-08-15T21:00:00.000Z');
});

test('el recordatorio de vencimiento solo sale para la ventana personal del coordinador', async () => {
  await withDispatchMetaEnv(async () => {
    const { runDispatchWhatsappWindowReminderDispatcher } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
    const audit = notificationAuditStore();
    const outbound = [];
    const now = new Date('2026-08-15T23:00:00.000Z');
    const windows = [
      { scope: 'operational', phone: '573009998877', lastInboundAt: new Date('2026-08-14T23:24:00.000Z') },
      { scope: 'operational', phone: '573001112233', lastInboundAt: new Date('2026-08-14T23:24:00.000Z') }
    ];
    const prismaClient = {
      devAuditEvent: audit.api,
      dispatchWhatsappContactWindow: { findMany: async () => windows },
      appUser: {
        findMany: async ({ where = {} } = {}) => {
          if (where.dispatchAlertPhone) return [{ dispatchAlertPhone: '573009998877' }];
          return [];
        }
      }
    };
    const axiosClient = {
      post: async (_url, payload) => {
        outbound.push(payload);
        return { data: { messages: [{ id: `wamid-${outbound.length}` }] } };
      }
    };

    const result = await runDispatchWhatsappWindowReminderDispatcher(prismaClient, { now, axiosClient });
    assert.equal(result.sent, 1);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].to, '573009998877');
    assert.match(outbound[0].text.body, /ventana personal/);
    assert.match(outbound[0].text.body, /punto \(\.\)/);
  });
});

test('el aviso de todos confirmados espera al último pendiente y se deduplica por composición', async () => {
  await withDispatchMetaEnv(async () => {
    const { sendDispatchAllConfirmedAdminAlert } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
    const audit = notificationAuditStore();
    const assignments = [
      assignment({ id: 'confirmed-a' }),
      assignment({ id: 'pending-b', status: 'CONFIRMATION_PENDING', phone: '3002223344' })
    ];
    const outbound = [];
    const prismaClient = {
      devAuditEvent: audit.api,
      appUser: {
        findUnique: async () => ({
          id: 'user-test-1',
          username: 'coordinador-test',
          isActive: true,
          dispatchAlertPhone: '573009998877'
        })
      },
      dispatchAssignment: { findMany: async () => assignments }
    };
    const axiosClient = {
      post: async (_url, payload) => {
        outbound.push(payload);
        return { data: { messages: [{ id: `wamid-admin-${outbound.length}` }] } };
      }
    };
    const link = { alertOwnerUsername: 'coordinador-test' };
    const target = assignments[0];

    const pending = await sendDispatchAllConfirmedAdminAlert({ scope: 'operational', link, assignment: target, prismaClient, axiosClient });
    assert.equal(pending.sent, false);
    assert.equal(pending.reason, 'pending_assignments');
    assert.equal(outbound.length, 0);

    assignments[1].status = 'CONFIRMED';
    const complete = await sendDispatchAllConfirmedAdminAlert({ scope: 'operational', link, assignment: target, prismaClient, axiosClient });
    assert.equal(complete.sent, true);
    assert.equal(outbound.length, 1);
    assert.match(outbound[0].text.body, /Todos tus auxiliares/);

    const duplicate = await sendDispatchAllConfirmedAdminAlert({ scope: 'operational', link, assignment: target, prismaClient, axiosClient });
    assert.equal(duplicate.sent, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(outbound.length, 1);
  });
});
