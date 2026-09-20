import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { webhookRouter } from '../src/routes/webhook.js';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import { installOpenAIMock } from './helpers/mockOpenAI.js';
import { baseOperations, baseVacancies } from './fixtures/conversationCases.js';

const PHONE = '573001119901';
const WINDOW_MS = 5000;

function matchesCount(message, where = {}) {
  if (where.candidateId && message.candidateId !== where.candidateId) return false;
  if (where.direction && message.direction !== where.direction) return false;
  if (where.messageType?.in && !where.messageType.in.includes(message.messageType)) return false;
  if (typeof where.messageType === 'string' && message.messageType !== where.messageType) return false;
  if (where.createdAt?.gte && new Date(message.createdAt) < new Date(where.createdAt.gte)) return false;
  return true;
}

function buildCandidate(overrides = {}) {
  return {
    id: 'candidate-mixed-turn',
    phone: PHONE,
    status: 'NUEVO',
    currentStep: 'ASK_CV',
    vacancyId: 'vac-post',
    fullName: 'Candidata Prueba',
    documentType: 'CC',
    documentNumber: '1000000901',
    age: 29,
    gender: 'UNKNOWN',
    neighborhood: 'Jordan',
    locality: null,
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Bicicleta',
    experienceInfo: null,
    experienceTime: null,
    cvData: null,
    cvStorageKey: null,
    cvOriginalName: null,
    cvMimeType: null,
    reminderState: 'NONE',
    reminderScheduledFor: null,
    botPaused: false,
    botPausedAt: null,
    botPausedBy: null,
    botPauseReason: null,
    botResumeMode: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    createdAt: new Date('2026-09-20T12:00:00.000Z'),
    ...overrides
  };
}

function buildPayload(message) {
  return { entry: [{ changes: [{ value: { messages: [message] } }] }] };
}

function postHandler(prisma) {
  const layer = webhookRouter(prisma).stack.find((item) => item.route?.methods?.post);
  const handler = layer?.route?.stack?.[0]?.handle;
  assert.equal(typeof handler, 'function');
  return handler;
}

function responseRecorder() {
  return {
    statusCode: null,
    sendStatus(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    send() {
      return this;
    }
  };
}

async function invoke(handler, message) {
  const response = responseRecorder();
  let nextError = null;
  await handler({ body: buildPayload(message), query: {} }, response, (error) => {
    nextError = error || null;
  });
  if (nextError) throw nextError;
  assert.equal(response.statusCode, 200);
}

async function runMixedTurn({
  order,
  mediaFailure = null,
  candidateOverrides = {},
  text = 'Adjunto mi hoja de vida'
}) {
  const scenarioId = `${order}-${mediaFailure || 'success'}`;
  const candidateId = `candidate-mixed-turn-${scenarioId}`;
  const previousEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    LORREN_REASONING_WINDOW_MS: process.env.LORREN_REASONING_WINDOW_MS,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    META_PHONE_NUMBER_ID: process.env.META_PHONE_NUMBER_ID,
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    ADMIN_WHATSAPP_NUMBER: process.env.ADMIN_WHATSAPP_NUMBER,
    FF_ATTACHMENT_ANALYZER: process.env.FF_ATTACHMENT_ANALYZER,
    FF_ASYNC_ADMIN_MEDIA_FORWARD: process.env.FF_ASYNC_ADMIN_MEDIA_FORWARD,
    ADMIN_MEDIA_FORWARD_NUMBERS: process.env.ADMIN_MEDIA_FORWARD_NUMBERS,
    FORWARD_MEDIA_TO: process.env.FORWARD_MEDIA_TO,
    LORREN_SEND_DELAY_MS: process.env.LORREN_SEND_DELAY_MS
  };
  Object.assign(process.env, {
    NODE_ENV: 'production',
    LORREN_REASONING_WINDOW_MS: String(WINDOW_MS),
    OPENAI_API_KEY: 'test-openai-key',
    META_PHONE_NUMBER_ID: 'test-phone-id',
    META_ACCESS_TOKEN: 'test-access-token',
    ADMIN_WHATSAPP_NUMBER: '',
    FF_ATTACHMENT_ANALYZER: 'false',
    FF_ASYNC_ADMIN_MEDIA_FORWARD: 'false',
    ADMIN_MEDIA_FORWARD_NUMBERS: '',
    FORWARD_MEDIA_TO: '',
    LORREN_SEND_DELAY_MS: '0'
  });

  const vacancy = structuredClone(baseVacancies.find((item) => item.id === 'vac-post'));
  const prisma = createMockPrisma({
    candidates: [buildCandidate({ id: candidateId, ...candidateOverrides })],
    messages: [],
    vacancies: [vacancy],
    operations: baseOperations,
    interviewSlots: [],
    interviewBookings: []
  });
  prisma.message.count = async ({ where } = {}) => (
    prisma.state.messages.filter((message) => matchesCount(message, where)).length
  );

  const whatsapp = createWhatsappMock();
  const openAiCalls = [];
  const restoreOpenAI = installOpenAIMock({
    whatsappMock: whatsapp,
    calls: openAiCalls,
    recognizeCurrentEnginePrompt: true
  });
  const originalGet = axios.get;
  const mediaCalls = [];
  axios.get = async (url) => {
    const value = String(url);
    mediaCalls.push(value);
    if (value.includes('graph.facebook.com/v23.0/media-mixed-turn')) {
      if (mediaFailure === 'metadata') throw new Error('controlled_metadata_failure');
      return { data: { url: 'https://mock-media.local/mixed-turn' } };
    }
    if (value === 'https://mock-media.local/mixed-turn') {
      if (mediaFailure === 'download') throw new Error('controlled_download_failure');
      return { data: Buffer.from('%PDF-1.4 controlled CV') };
    }
    throw new Error(`unexpected_get:${value}`);
  };

  const timestamp = String(Math.floor(Date.now() / 1000));
  const textMessage = {
    id: `wamid-text-${order}-${mediaFailure || 'success'}`,
    from: PHONE,
    timestamp,
    type: 'text',
    text: { body: text }
  };
  const documentMessage = {
    id: `wamid-document-${order}-${mediaFailure || 'success'}`,
    from: PHONE,
    timestamp,
    type: 'document',
    document: {
      id: 'media-mixed-turn',
      mime_type: 'application/pdf',
      filename: 'hoja-de-vida-prueba.pdf'
    }
  };

  try {
    const handler = postHandler(prisma);
    const first = order === 'text-document' ? textMessage : documentMessage;
    const second = order === 'text-document' ? documentMessage : textMessage;
    const firstRequest = invoke(handler, first);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondRequest = invoke(handler, second);
    await Promise.all([firstRequest, secondRequest]);

    const candidateMessages = whatsapp.sentMessages.filter((message) => message.to === PHONE);
    const inbound = prisma.state.messages
      .filter((message) => message.candidateId === candidateId && message.direction === 'INBOUND');
    const textInbound = inbound.find((message) => message.messageType === 'TEXT');
    const documentInbound = inbound.find((message) => message.messageType === 'DOCUMENT');
    return {
      candidate: await prisma.candidate.findUnique({ where: { id: candidateId } }),
      candidateMessages,
      textInbound,
      documentInbound,
      mediaCalls,
      openAiCalls
    };
  } finally {
    axios.get = originalGet;
    restoreOpenAI();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

for (const order of ['text-document', 'document-text']) {
  test(`router texto+HV: ${order} conserva un único dueño y persiste ambos inbound`, async () => {
    const result = await runMixedTurn({ order });

    assert.equal(result.candidateMessages.length, 1);
    assert.match(result.candidateMessages[0].body, /información y hoja de vida quedaron registradas/i);
    assert.ok(result.textInbound?.respondedAt);
    assert.ok(result.documentInbound?.respondedAt);
    assert.equal(result.documentInbound?.rawPayload?.logicalTurn?.state, 'CV_SAVED');
    assert.equal(result.candidate.currentStep, 'DONE');
    assert.equal(result.candidate.status, 'REGISTRADO');
    assert.ok(result.candidate.cvData || result.candidate.cvStorageKey);
  });
}

for (const order of ['text-document', 'document-text']) {
  for (const mediaFailure of ['metadata', 'download']) {
    test(`router texto+HV: ${order} con fallo de ${mediaFailure} persiste texto y no duplica respuesta`, async () => {
      const result = await runMixedTurn({
        order,
        mediaFailure,
        candidateOverrides: {
          age: null,
          dataConsentStatus: 'ACCEPTED',
          dataConsentVersion: 'lorren-v2-2026-07-v3'
        },
        text: 'Tengo 30 años y adjunto mi hoja de vida'
      });

      assert.equal(result.candidateMessages.length, 1);
      assert.match(result.candidateMessages[0].body, /hoja de vida|archivo PDF|inténtalo nuevamente/i);
      assert.ok(result.textInbound?.respondedAt);
      assert.ok(result.documentInbound?.respondedAt);
      assert.equal(result.documentInbound?.rawPayload?.logicalTurn?.state, 'FAILED');
      assert.equal(result.candidate.age, 30);
      assert.equal(Boolean(result.candidate.cvData || result.candidate.cvStorageKey), false);
      assert.equal(result.mediaCalls.length, mediaFailure === 'metadata' ? 1 : 2);
    });
  }
}
