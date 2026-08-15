import test from 'node:test';
import assert from 'node:assert/strict';
import {
  processDispatchWhatsappInboundMessage
} from '../src/services/dispatchWhatsappWebhookService.js';
import {
  sendDispatchWhatsappMessage
} from '../src/services/dispatchWhatsappAssignmentService.js';

const TEST_PHONE_LOCAL = '3000000001';
const TEST_PHONE = `57${TEST_PHONE_LOCAL}`;

function withOperationalMetaConfig(callback) {
  const keys = [
    'DISPATCH_META_GRAPH_VERSION',
    'DISPATCH_META_ACCESS_TOKEN',
    'DISPATCH_META_PHONE_NUMBER_ID',
    'DISPATCH_META_VERIFY_TOKEN',
    'DISPATCH_META_APP_SECRET',
    'DISPATCH_META_DUPLICATE_SEND_WINDOW_MS'
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.DISPATCH_META_GRAPH_VERSION = 'v23.0';
  process.env.DISPATCH_META_ACCESS_TOKEN = 'TEST_TOKEN';
  process.env.DISPATCH_META_PHONE_NUMBER_ID = 'TEST_PHONE_NUMBER_ID';
  process.env.DISPATCH_META_VERIFY_TOKEN = 'TEST_VERIFY_TOKEN';
  process.env.DISPATCH_META_APP_SECRET = 'TEST_APP_SECRET';
  process.env.DISPATCH_META_DUPLICATE_SEND_WINDOW_MS = '0';
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function dateMatches(value, condition) {
  if (!condition || typeof condition !== 'object') return true;
  const time = new Date(value).getTime();
  if (condition.lte && time > new Date(condition.lte).getTime()) return false;
  if (condition.gt && time <= new Date(condition.gt).getTime()) return false;
  if (condition.gte && time < new Date(condition.gte).getTime()) return false;
  return true;
}

function statusMatches(value, condition) {
  if (typeof condition === 'string') return value === condition;
  if (condition?.in) return condition.in.includes(value);
  return true;
}

function rowMatchesWhere(row, where = {}) {
  if (where.id && typeof where.id === 'string' && row.id !== where.id) return false;
  if (where.assignmentId && row.assignmentId !== where.assignmentId) return false;
  if (where.phone && row.phone !== where.phone) return false;
  if (where.providerMessageId && row.providerMessageId !== where.providerMessageId) return false;
  if (where.confirmationMessageId && row.confirmationMessageId !== where.confirmationMessageId) return false;
  if (where.status && !statusMatches(row.status, where.status)) return false;
  if (where.createdAt && !dateMatches(row.createdAt, where.createdAt)) return false;
  if (where.expiresAt && !dateMatches(row.expiresAt, where.expiresAt)) return false;
  return true;
}

function confirmationPrisma({ links, assignment, extraAssignments = [] }) {
  const assignments = new Map([assignment, ...extraAssignments].map((item) => [item.id, item]));
  const audit = [];
  let contactWindow = null;
  const requestUpdates = [];
  const findManyCalls = [];

  const dispatchWhatsappConfirmation = {
    findMany: async (input = {}) => {
      findManyCalls.push(input);
      return links
        .filter((row) => rowMatchesWhere(row, input.where))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, input.take || links.length);
    },
    findFirst: async ({ where } = {}) => links.find((row) => rowMatchesWhere(row, where)) || null,
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const row of links) {
        if (!rowMatchesWhere(row, where)) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    },
    update: async ({ where, data }) => {
      const row = links.find((item) => item.id === where.id);
      if (!row) throw new Error('test_link_not_found');
      Object.assign(row, data);
      return row;
    }
  };

  const dispatchAssignment = {
    findUnique: async ({ where }) => {
      const row = assignments.get(where.id);
      return row ? { status: row.status } : null;
    },
    updateMany: async ({ where, data }) => {
      const row = assignments.get(where.id);
      if (!row || (where.status && !statusMatches(row.status, where.status))) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }
  };

  const prisma = {
    dispatchWhatsappConfirmation,
    dispatchAssignment,
    dispatchWhatsappContactWindow: {
      findUnique: async () => contactWindow,
      create: async ({ data }) => {
        contactWindow = { id: 'window-test', ...data };
        return contactWindow;
      },
      update: async ({ data }) => {
        Object.assign(contactWindow, data);
        return contactWindow;
      },
      updateMany: async ({ data }) => {
        if (contactWindow) Object.assign(contactWindow, data);
        return { count: contactWindow ? 1 : 0 };
      }
    },
    devAuditEvent: {
      findFirst: async ({ where }) => audit.find((row) => row.entityType === where.entityType && row.entityId === where.entityId) || null,
      create: async ({ data }) => {
        const row = { id: `audit-${audit.length + 1}`, ...data };
        audit.push(row);
        return row;
      }
    },
    dispatchServiceRequest: {
      findUnique: async () => ({
        id: assignment.serviceRequestId,
        requiredWorkers: 2,
        assignments: [{ status: assignment.status, worker: { isTestProfile: false } }]
      }),
      update: async ({ data }) => {
        requestUpdates.push(data);
        return data;
      }
    }
  };
  prisma.$transaction = async (input) => {
    if (typeof input === 'function') return input(prisma);
    return Promise.all(input);
  };

  return { prisma, audit, findManyCalls, requestUpdates, getContactWindow: () => contactWindow };
}

function assignmentFixture(id = 'assignment-test') {
  return {
    id,
    serviceRequestId: 'request-test',
    workerId: 'worker-test',
    status: 'CONFIRMATION_PENDING',
    worker: { id: 'worker-test', fullName: 'Auxiliar Prueba', phone: TEST_PHONE_LOCAL, isTestProfile: false },
    serviceRequest: { id: 'request-test', source: 'INTERNAL' }
  };
}

function linkFixture({
  id = 'link-test',
  assignment = assignmentFixture(),
  status = 'SENT',
  providerMessageId = 'wamid.outbound.test',
  createdAt = '2026-08-14T23:00:00.000Z'
} = {}) {
  return {
    id,
    assignmentId: assignment.id,
    serviceRequestId: assignment.serviceRequestId,
    phone: TEST_PHONE,
    providerMessageId,
    confirmationMessageId: null,
    confirmationReceivedAt: null,
    status,
    createdAt: new Date(createdAt),
    expiresAt: new Date('2026-08-16T23:00:00.000Z'),
    assignment
  };
}

function successfulAxios() {
  const calls = [];
  return {
    calls,
    client: {
      post: async (...args) => {
        calls.push(args);
        return { data: { messages: [{ id: `wamid.reply.${calls.length}` }] } };
      }
    }
  };
}

async function runInboundReplay({ message, links, assignment, extraAssignments = [] }) {
  const state = confirmationPrisma({ links, assignment, extraAssignments });
  const axios = successfulAxios();
  const result = await withOperationalMetaConfig(() => processDispatchWhatsappInboundMessage({
    scope: 'operational',
    message,
    prismaClient: state.prisma,
    axiosClient: axios.client
  }));
  return { ...state, axios, result };
}

test('quick reply de plantilla correlaciona context.id con el outbound exacto aunque un reenvío lo haya marcado EXPIRED', async () => {
  const assignment = assignmentFixture();
  const link = linkFixture({ assignment, status: 'EXPIRED', providerMessageId: 'wamid.outbound.template' });
  const replay = await runInboundReplay({
    assignment,
    links: [link],
    message: {
      id: 'wamid.inbound.template',
      from: TEST_PHONE,
      timestamp: '1786752600',
      type: 'button',
      context: { id: 'wamid.outbound.template' },
      button: { text: 'CONFIRMADO', payload: `dispatch_confirm:${assignment.id}` }
    }
  });

  assert.equal(replay.result.handled, true);
  assert.equal(replay.result.assignmentConfirmed, true);
  assert.equal(assignment.status, 'CONFIRMED');
  assert.equal(link.confirmationMessageId, 'wamid.inbound.template');
  assert.equal(link.status, 'CONFIRMED');
  assert.equal(replay.findManyCalls[0].where.providerMessageId, 'wamid.outbound.template');
  assert.equal(replay.axios.calls.length, 1);
});

test('botón interactivo de sesión confirma por assignmentId y conserva evidencia en el vínculo seleccionado', async () => {
  const assignment = assignmentFixture('assignment-interactive');
  const link = linkFixture({ assignment, id: 'link-interactive', providerMessageId: 'wamid.outbound.interactive' });
  const replay = await runInboundReplay({
    assignment,
    links: [link],
    message: {
      id: 'wamid.inbound.interactive',
      from: TEST_PHONE,
      timestamp: '1786752700',
      type: 'interactive',
      context: { id: 'wamid.outbound.interactive' },
      interactive: {
        type: 'button_reply',
        button_reply: { id: `dispatch_confirm:${assignment.id}`, title: 'CONFIRMADO' }
      }
    }
  });

  assert.equal(replay.result.assignmentConfirmed, true);
  assert.equal(assignment.status, 'CONFIRMED');
  assert.equal(link.confirmationMessageId, 'wamid.inbound.interactive');
  assert.ok(link.confirmationReceivedAt instanceof Date);
});

test('confirmación por texto ignora un vínculo más nuevo inválido y usa el candidato válido creado antes del inbound', async () => {
  const assignment = assignmentFixture('assignment-text-valid');
  const invalidAssignment = {
    ...assignmentFixture('assignment-text-invalid'),
    status: 'NO_CONFIRMO',
    worker: { ...assignment.worker, id: 'worker-invalid' }
  };
  const validLink = linkFixture({
    assignment,
    id: 'link-valid',
    providerMessageId: 'wamid.valid',
    createdAt: '2026-08-14T23:00:00.000Z'
  });
  const invalidNewerLink = linkFixture({
    assignment: invalidAssignment,
    id: 'link-invalid-newer',
    providerMessageId: 'wamid.invalid',
    createdAt: '2026-08-14T23:02:00.000Z'
  });
  const replay = await runInboundReplay({
    assignment,
    extraAssignments: [invalidAssignment],
    links: [invalidNewerLink, validLink],
    message: {
      id: 'wamid.inbound.text',
      from: TEST_PHONE,
      timestamp: '1786752300',
      type: 'text',
      text: { body: 'Confirmado' }
    }
  });

  assert.equal(replay.result.assignmentConfirmed, true);
  assert.equal(assignment.status, 'CONFIRMED');
  assert.equal(invalidAssignment.status, 'NO_CONFIRMO');
  assert.equal(validLink.confirmationMessageId, 'wamid.inbound.text');
  assert.equal(invalidNewerLink.confirmationMessageId, null);
  assert.deepEqual(replay.findManyCalls[0].where.status.in, ['PENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN', 'NOVELTY_REPORTED']);
});

test('un reenvío que falla no expira el vínculo anterior todavía utilizable', async () => {
  const assignment = {
    ...assignmentFixture('assignment-resend'),
    status: 'CONFIRMATION_PENDING',
    serviceRequest: {
      id: 'request-test',
      source: 'INTERNAL',
      serviceDate: new Date('2099-01-01T05:00:00.000Z'),
      operationPoint: null
    }
  };
  const previousLink = linkFixture({ assignment, id: 'link-previous', status: 'SENT', providerMessageId: 'wamid.previous' });
  const links = [previousLink];
  const prisma = {
    dispatchAssignment: {
      findFirst: async () => assignment,
      updateMany: async () => ({ count: 0 })
    },
    dispatchWhatsappContactWindow: {
      findUnique: async () => ({ scope: 'operational', phone: TEST_PHONE, lastInboundAt: new Date() })
    },
    dispatchWhatsappConfirmation: {
      findFirst: async () => null,
      create: async ({ data }) => {
        const link = {
          id: 'link-replacement',
          ...data,
          createdAt: new Date(),
          confirmationMessageId: null,
          confirmationReceivedAt: null,
          assignment
        };
        links.push(link);
        return link;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const link of links) {
          if (!rowMatchesWhere(link, where)) continue;
          Object.assign(link, data);
          count += 1;
        }
        return { count };
      },
      update: async ({ where, data }) => {
        const link = links.find((item) => item.id === where.id);
        Object.assign(link, data);
        return link;
      }
    },
    $transaction: async (input) => Promise.all(input)
  };
  const failingAxios = {
    post: async () => {
      const error = new Error('provider unavailable');
      error.response = { data: { error: { code: 131000, message: 'provider unavailable' } } };
      throw error;
    }
  };

  await assert.rejects(
    () => withOperationalMetaConfig(() => sendDispatchWhatsappMessage({
      phone: TEST_PHONE,
      context: {
        assignmentId: assignment.id,
        serviceRequestId: assignment.serviceRequestId,
        workerId: assignment.workerId
      },
      scope: 'operational',
      prismaClient: prisma,
      axiosClient: failingAxios
    })),
    /Meta rechazó la operación/
  );

  assert.equal(previousLink.status, 'SENT');
  assert.equal(links.find((link) => link.id === 'link-replacement').status, 'FAILED');
});
