import axios from 'axios';
import { createMockPrisma } from './mockPrisma.js';
import { createWhatsappMock } from './mockWhatsapp.js';
import { installOpenAIMock } from './mockOpenAI.js';
import { baseOperations, baseVacancies } from '../fixtures/conversationCases.js';

function matchesDocumentCount(message, where = {}) {
  if (where.candidateId && message.candidateId !== where.candidateId) return false;
  if (where.direction && message.direction !== where.direction) return false;
  if (where.messageType && typeof where.messageType === 'object' && Array.isArray(where.messageType.in)) {
    if (!where.messageType.in.includes(message.messageType)) return false;
  } else if (where.messageType && message.messageType !== where.messageType) {
    return false;
  }
  if (where.createdAt?.gte && new Date(message.createdAt).getTime() < new Date(where.createdAt.gte).getTime()) return false;
  return true;
}

function buildWebhookPayload(phone) {
  return {
    entry: [{
      changes: [{
        value: {
          messages: [{
            id: 'wamid-cv-parity',
            from: phone,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'document',
            document: {
              id: 'media-cv-parity',
              mime_type: 'application/pdf',
              filename: 'hoja-de-vida.pdf'
            }
          }]
        }
      }]
    }]
  };
}

function findPostHandler(router) {
  const routeLayer = router.stack.find((layer) => layer.route?.methods?.post);
  const handler = routeLayer?.route?.stack?.[0]?.handle;
  if (typeof handler !== 'function') throw new Error('No se encontró el handler POST del webhook.');
  return handler;
}

async function run(mode) {
  process.env.NODE_ENV = 'test';
  process.env.USE_CONVERSATION_ENGINE = mode;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';
  process.env.ADMIN_WHATSAPP_NUMBER = '573059992222';
  process.env.FF_ATTACHMENT_ANALYZER = 'false';
  process.env.FF_ASYNC_ADMIN_MEDIA_FORWARD = 'false';
  process.env.ADMIN_MEDIA_FORWARD_NUMBERS = '';
  process.env.FORWARD_MEDIA_TO = '';
  process.env.R2_ENDPOINT = '';
  process.env.R2_ACCESS_KEY_ID = '';
  process.env.R2_SECRET_ACCESS_KEY = '';
  process.env.R2_BUCKET = '';
  process.env.LORREN_SEND_DELAY_MS = '0';

  const candidateId = 'candidate-cv-parity';
  const candidatePhone = '573001117777';
  const vacancy = structuredClone(baseVacancies.find((item) => item.id === 'vac-post'));
  const prisma = createMockPrisma({
    candidates: [{
      id: candidateId,
      phone: candidatePhone,
      status: 'NUEVO',
      currentStep: 'ASK_CV',
      vacancyId: vacancy.id,
      fullName: 'Candidato Documento',
      documentType: 'CC',
      documentNumber: '1000000007',
      age: 28,
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
      createdAt: new Date('2026-07-27T10:00:00.000Z')
    }],
    messages: [],
    vacancies: [vacancy],
    operations: baseOperations,
    interviewSlots: [],
    interviewBookings: []
  });
  prisma.message.count = async ({ where } = {}) => prisma.state.messages.filter((message) => matchesDocumentCount(message, where)).length;

  const whatsappMock = createWhatsappMock();
  const openAiCalls = [];
  const restorePost = installOpenAIMock({ whatsappMock, calls: openAiCalls, recognizeCurrentEnginePrompt: true });
  const originalGet = axios.get;
  let metadataRequests = 0;
  let downloadRequests = 0;

  axios.get = async (url) => {
    const normalizedUrl = String(url);
    if (normalizedUrl.includes('graph.facebook.com/v23.0/media-cv-parity')) {
      metadataRequests += 1;
      return { data: { url: 'https://mock-media.local/cv-parity' } };
    }
    if (normalizedUrl === 'https://mock-media.local/cv-parity') {
      downloadRequests += 1;
      return { data: Buffer.from('%PDF-1.4 mock document') };
    }
    throw new Error(`GET inesperado en harness documental: ${normalizedUrl}`);
  };

  try {
    const { webhookRouter } = await import('../../src/routes/webhook.js');
    const handler = findPostHandler(webhookRouter(prisma));
    const req = { body: buildWebhookPayload(candidatePhone), query: {} };
    let httpStatus = null;
    let nextError = null;
    const res = {
      sendStatus(status) {
        httpStatus = status;
        return this;
      },
      status(status) {
        httpStatus = status;
        return this;
      },
      send() {
        return this;
      }
    };

    await handler(req, res, (error) => {
      nextError = error || null;
    });
    if (nextError) throw nextError;

    const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
    const candidateMessages = prisma.state.messages.filter((message) => message.candidateId === candidateId);
    const outboundSources = [...new Set(candidateMessages
      .filter((message) => message.direction === 'OUTBOUND')
      .map((message) => message.rawPayload?.source)
      .filter(Boolean))].sort();
    const candidateSends = whatsappMock.sentMessages.filter((message) => message.to === candidatePhone);
    const callTypes = openAiCalls.map((call) => call.type).filter(Boolean);
    const byType = Object.fromEntries([...new Set(callTypes)].sort().map((type) => [type, callTypes.filter((item) => item === type).length]));

    return {
      version: 1,
      mode,
      httpStatus,
      candidate: {
        status: candidate.status || null,
        currentStep: candidate.currentStep || null,
        vacancyId: candidate.vacancyId || null,
        reminderState: candidate.reminderState || null,
        hasCv: Boolean(candidate.cvData || candidate.cvStorageKey),
        cvMimeType: candidate.cvMimeType || null,
        cvOriginalNamePresent: Boolean(candidate.cvOriginalName)
      },
      inbound: {
        documentStored: candidateMessages.some((message) => message.direction === 'INBOUND' && message.messageType === 'DOCUMENT'),
        uniqueMessageCount: candidateMessages.filter((message) => message.waMessageId === 'wamid-cv-parity').length
      },
      outbound: {
        candidateSendCount: candidateSends.length,
        persistedSources: outboundSources
      },
      media: {
        metadataRequests,
        downloadRequests,
        downloaded: downloadRequests === 1
      },
      openAi: {
        count: callTypes.length,
        byType
      }
    };
  } finally {
    axios.get = originalGet;
    restorePost();
  }
}

const mode = String(process.argv[2] || '');
if (mode === 'true' || mode === 'false') {
  const snapshot = await run(mode);
  console.log('__LORREN_CV_PARITY__' + JSON.stringify(snapshot));
}
