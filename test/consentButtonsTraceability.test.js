import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import * as whatsapp from '../src/services/whatsapp.js';
import {
  APPLICATION_INTEREST_PENDING_MODE,
  DATA_CONSENT_PENDING_MODE,
  dataConsentGateMiddleware
} from '../src/services/dataConsentGate.js';

const originalAxiosPost = axios.post;
after(() => {
  axios.post = originalAxiosPost;
});

function webhookPayload(message) {
  return {
    entry: [{
      changes: [{ value: { messages: [structuredClone(message)] } }]
    }]
  };
}

function createHarness(initialCandidate, vacancy) {
  let candidate = structuredClone(initialCandidate);
  const sentPayloads = [];
  const inboundRows = [];
  const outboundRows = [];
  const consentEvents = [];
  let nextMessageId = 1;

  axios.post = async (_url, requestBody) => {
    sentPayloads.push(structuredClone(requestBody));
    return { data: { messages: [{ id: `TEST-OUTBOUND-${sentPayloads.length}` }] } };
  };

  function matchesCandidateWhere(where = {}) {
    if (where.id && where.id !== candidate.id) return false;
    if (where.currentStep && where.currentStep !== candidate.currentStep) return false;
    if (where.dataConsentStatus && where.dataConsentStatus !== candidate.dataConsentStatus) return false;
    return true;
  }

  const prisma = {
    candidate: {
      upsert: async () => structuredClone(candidate),
      findUnique: async () => structuredClone(candidate),
      update: async ({ data }) => {
        candidate = { ...candidate, ...structuredClone(data) };
        return structuredClone(candidate);
      },
      updateMany: async ({ where = {}, data = {} }) => {
        if (!matchesCandidateWhere(where)) return { count: 0 };
        candidate = { ...candidate, ...structuredClone(data) };
        return { count: 1 };
      }
    },
    candidateDataConsentEvent: {
      create: async ({ data }) => {
        const event = { id: `TEST-CONSENT-EVENT-${consentEvents.length + 1}`, ...structuredClone(data) };
        consentEvents.push(event);
        return event;
      }
    },
    vacancy: {
      findUnique: async ({ where }) => where.id === vacancy.id ? structuredClone(vacancy) : null
    },
    message: {
      findFirst: async ({ where = {} }) => {
        const row = inboundRows.find((message) => (
          (!where.candidateId || message.candidateId === where.candidateId)
          && (!where.waMessageId || message.waMessageId === where.waMessageId)
        ));
        return row ? structuredClone(row) : null;
      },
      createMany: async ({ data }) => {
        const rows = Array.isArray(data) ? data : [data];
        let count = 0;
        for (const row of rows) {
          if (row.waMessageId && inboundRows.some((message) => message.waMessageId === row.waMessageId)) continue;
          inboundRows.push({
            id: `TEST-INBOUND-ROW-${nextMessageId++}`,
            ...structuredClone(row),
            createdAt: new Date()
          });
          count += 1;
        }
        return { count };
      },
      create: async ({ data }) => {
        const row = {
          id: `TEST-OUTBOUND-ROW-${nextMessageId++}`,
          ...structuredClone(data),
          createdAt: new Date()
        };
        outboundRows.push(row);
        return structuredClone(row);
      },
      findMany: async () => [],
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
      findUnique: async ({ where }) => {
        const row = [...inboundRows, ...outboundRows].find((message) => message.id === where.id);
        return row ? structuredClone(row) : null;
      }
    },
    interviewBooking: {
      updateMany: async () => ({ count: 0 })
    }
  };

  return {
    prisma,
    sentPayloads,
    inboundRows,
    outboundRows,
    consentEvents,
    getCandidate: () => structuredClone(candidate)
  };
}

async function runMiddleware(harness, message) {
  const middleware = dataConsentGateMiddleware(harness.prisma);
  const req = { body: webhookPayload(message), headers: {}, ip: '127.0.0.1' };
  const observed = { nextCalls: 0, statuses: [] };
  const res = {
    sendStatus(status) {
      observed.statuses.push(status);
      return status;
    }
  };
  await middleware(req, res, () => {
    observed.nextCalls += 1;
  });
  return observed;
}

const vacancy = {
  id: 'TEST-VACANCY-CONSENT-BUTTONS',
  title: 'Auxiliar de Operación',
  city: 'Bogotá',
  isActive: true,
  acceptingApplications: true,
  requirements: 'Experiencia básica en operación',
  operation: { city: { name: 'Bogotá' } }
};

test('WhatsApp construye el consentimiento con exactamente dos reply buttons', () => {
  assert.equal(typeof whatsapp.buildWhatsAppReplyButtonsPayload, 'function');
  const payload = whatsapp.buildWhatsAppReplyButtonsPayload(
    'TEST-PHONE-CONSENT-BUTTONS',
    'Texto de consentimiento de prueba',
    [
      { id: 'consent_accept', title: 'Sí, autorizo' },
      { id: 'consent_reject', title: 'No autorizo' }
    ]
  );

  assert.equal(payload.type, 'interactive');
  assert.equal(payload.interactive.type, 'button');
  assert.equal(payload.interactive.body.text, 'Texto de consentimiento de prueba');
  assert.deepEqual(payload.interactive.action.buttons, [
    { type: 'reply', reply: { id: 'consent_accept', title: 'Sí, autorizo' } },
    { type: 'reply', reply: { id: 'consent_reject', title: 'No autorizo' } }
  ]);
});

test('el prompt de consentimiento sale por botones sin crear otra autoridad', async () => {
  const candidate = {
    id: 'TEST-CANDIDATE-CONSENT-PROMPT',
    phone: 'TEST-PHONE-CONSENT-PROMPT',
    vacancyId: vacancy.id,
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    botResumeMode: APPLICATION_INTEREST_PENDING_MODE,
    botPaused: false,
    status: 'NUEVO'
  };
  const harness = createHarness(candidate, vacancy);

  await runMiddleware(harness, {
    id: 'TEST-WAMID-CONSENT-PROMPT',
    from: candidate.phone,
    type: 'text',
    text: { body: 'Sí, quiero postularme.' }
  });

  assert.equal(harness.sentPayloads.length, 1);
  const payload = harness.sentPayloads[0];
  assert.equal(payload.type, 'interactive');
  assert.match(payload.interactive.body.text, /Autorizo a LoginPro/i);
  assert.deepEqual(
    payload.interactive.action.buttons.map((button) => button.reply.title),
    ['Sí, autorizo', 'No autorizo']
  );
  assert.equal(harness.getCandidate().botResumeMode, DATA_CONSENT_PENDING_MODE);
});

test('button_reply de aceptación persiste el texto visible de la decisión y registra consentimiento', async () => {
  const candidate = {
    id: 'TEST-CANDIDATE-CONSENT-ACCEPT',
    phone: 'TEST-PHONE-CONSENT-ACCEPT',
    vacancyId: vacancy.id,
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    botResumeMode: DATA_CONSENT_PENDING_MODE,
    botPaused: false,
    status: 'NUEVO'
  };
  const harness = createHarness(candidate, vacancy);

  await runMiddleware(harness, {
    id: 'TEST-WAMID-CONSENT-ACCEPT',
    from: candidate.phone,
    type: 'interactive',
    interactive: {
      type: 'button_reply',
      button_reply: { id: 'consent_accept', title: 'Sí, autorizo' }
    }
  });

  assert.equal(harness.consentEvents.length, 1);
  assert.equal(harness.consentEvents[0].status, 'ACCEPTED');
  assert.equal(harness.getCandidate().dataConsentStatus, 'ACCEPTED');
  const inbound = harness.inboundRows.find((row) => row.waMessageId === 'TEST-WAMID-CONSENT-ACCEPT');
  assert.equal(inbound?.body, 'Sí, autorizo');
  assert.doesNotMatch(inbound?.body || '', /\[CONSENT_/);
});

test('PII enviada antes de autorizar no se persiste literalmente ni aparece como etiqueta técnica', async () => {
  const candidate = {
    id: 'TEST-CANDIDATE-PRECONSENT-PII',
    phone: 'TEST-PHONE-PRECONSENT-PII',
    vacancyId: vacancy.id,
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    botResumeMode: APPLICATION_INTEREST_PENDING_MODE,
    botPaused: false,
    status: 'NUEVO'
  };
  const harness = createHarness(candidate, vacancy);
  const protectedText = 'Mi documento es 99999123';

  await runMiddleware(harness, {
    id: 'TEST-WAMID-PRECONSENT-PII',
    from: candidate.phone,
    type: 'text',
    text: { body: protectedText }
  });

  const inbound = harness.inboundRows.find((row) => row.waMessageId === 'TEST-WAMID-PRECONSENT-PII');
  assert.ok(inbound);
  assert.notEqual(inbound.body, protectedText);
  assert.doesNotMatch(inbound.body || '', /99999123/);
  assert.doesNotMatch(inbound.body || '', /^\[.*\]$/);
  assert.match(inbound.body || '', /no fue almacenado|no se almacenó/i);
});
