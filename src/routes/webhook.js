import express from 'express';
import { MessageDirection, MessageType } from '@prisma/client';
import { buildConversationTurnInput } from '../core/middlewares/buildConversationTurnInput.js';
import { calculateConversationDecision } from '../core/engine/calculateConversationDecision.js';
import { executeConversationDecision } from '../core/shell/executeConversationDecision.js';
import {
  extractMessages,
  sendReplyButtonsMessage,
  sendTextMessage
} from '../services/whatsapp.js';
import { tryOpenAIParse } from '../services/aiParser.js';
import { conversationUnderstanding } from '../services/conversationUnderstanding.js';
import { detectConversationIntent } from '../services/conversationIntent.js';
import { parseNaturalData } from '../services/candidateData.js';
import { resolveVacancyFromText } from '../services/vacancyResolver.js';
import { getCandidateReadiness, hasValidCv } from '../services/readinessGuard.js';
import {
  shouldBlockAutomation,
  shouldResumeAutomationOnInbound
} from '../services/botAutomationPolicy.js';
import {
  acquireCandidateMultilineBatch,
  resumeCandidateAutomationOnInbound,
  scheduleCandidateMultilineWindow
} from '../services/candidateStateService.js';
import {
  consolidateTextMessages,
  getMultilineWindowMs
} from '../services/multiline.js';
import {
  cancelReminderOnInbound,
  scheduleReminderForCandidate
} from '../services/reminder.js';
import { fetchMediaMetadata, downloadMedia } from '../services/media.js';
import { isCvMimeTypeAllowed } from '../services/cvFlow.js';
import { storeCandidateCv } from '../services/cvStorage.js';
import { deliverAutomaticOutboundText } from '../services/automaticOutboundDeliveryService.js';
import {
  handleSupervisorInbound,
  isSupervisorPhone,
  notifySupervisorAttachment
} from '../services/adminSupervisor.js';
import { sanitizeForRawPayload } from '../services/debugTrace.js';
import {
  findInboundConversationMessage,
  loadConversationInterpretationContext,
  markConversationMessagesResponded,
  persistInboundConversationMessage
} from '../services/conversationMessageRepository.js';

// Transitional server compatibility. The runtime route below owns the real
// ConversationTurnInput after cutover; this middleware remains fail-open until
// its server mount is removed in a separate infrastructure-only cleanup.
export const conversationTurnInputShadow = buildConversationTurnInput();

const MAX_MESSAGES_PER_WINDOW = Number.parseInt(process.env.RATE_LIMIT_MAX || '15', 10);
const RATE_WINDOW_MS = Number.parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || String(10 * 60 * 1000),
  10
);
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const HISTORY_LIMIT = 12;
const DEFAULT_SCHEDULING_TIMEZONE = 'America/Bogota';

/** @type {Map<string, number[]>} */
const phoneTimestamps = new Map();

const rateLimitCleanupTimer = setInterval(() => {
  const windowStart = Date.now() - RATE_WINDOW_MS;
  for (const [phone, timestamps] of phoneTimestamps.entries()) {
    const active = timestamps.filter((timestamp) => timestamp > windowStart);
    if (active.length) phoneTimestamps.set(phone, active);
    else phoneTimestamps.delete(phone);
  }
}, CLEANUP_INTERVAL_MS);
rateLimitCleanupTimer.unref?.();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkRateLimit(phone) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const timestamps = (phoneTimestamps.get(phone) || [])
    .filter((timestamp) => timestamp > windowStart);

  if (timestamps.length >= MAX_MESSAGES_PER_WINDOW) {
    console.warn('[RATE_LIMIT_HIT]', JSON.stringify({
      phone,
      count: timestamps.length,
      windowMs: RATE_WINDOW_MS
    }));
    return false;
  }

  timestamps.push(now);
  phoneTimestamps.set(phone, timestamps);
  return true;
}

function normalizeText(value = '') {
  return typeof value === 'string' ? value.trim() : '';
}

function rawTextFromMessage(message = {}) {
  if (message.type === 'text') return String(message.text?.body || '');
  if (message.type === 'button') {
    return String(message.button?.text || message.button?.payload || '');
  }
  if (message.type === 'interactive') {
    return String(
      message.interactive?.button_reply?.title
      || message.interactive?.list_reply?.title
      || ''
    );
  }
  if (message.type === 'image') return String(message.image?.caption || '');
  if (message.type === 'document') return String(message.document?.caption || '');
  return '';
}

function inboundBodyFromMessage(message = {}) {
  const semanticText = rawTextFromMessage(message);
  if (semanticText) return semanticText;
  if (message.type === 'document') return String(message.document?.filename || '');
  if (message.type === 'audio') return String(message.audio?.mime_type || '');
  if (message.type === 'video') return String(message.video?.caption || '');
  return '';
}

function resolveInboundMessageType(message = {}) {
  switch (message.type) {
    case 'text':
    case 'button':
      return MessageType.TEXT;
    case 'interactive':
      return MessageType.INTERACTIVE;
    case 'document':
      return MessageType.DOCUMENT;
    case 'image':
      return MessageType.IMAGE;
    default:
      return MessageType.UNKNOWN;
  }
}

function attachmentItemFromMessage(message = {}, isCv = false) {
  const supportedTypes = new Set(['document', 'image', 'audio', 'video', 'sticker']);
  const type = supportedTypes.has(message.type) ? message.type : 'unknown';
  const media = message?.[type] && typeof message[type] === 'object'
    ? message[type]
    : {};

  return {
    type,
    mediaId: media.id ? String(media.id) : null,
    fileName: media.filename ? String(media.filename) : null,
    mimeType: media.mime_type ? String(media.mime_type) : null,
    caption: media.caption ? String(media.caption) : null,
    isCv
  };
}

function candidateKnownData(candidate = {}) {
  const keys = [
    'vacancyId',
    'currentStep',
    'status',
    'fullName',
    'documentType',
    'documentNumber',
    'age',
    'locality',
    'neighborhood',
    'transportMode',
    'medicalRestrictions',
    'experienceInfo',
    'experienceTime',
    'experienceSummary',
    'dataConsentStatus'
  ];

  return Object.fromEntries(
    keys
      .filter((key) => candidate[key] !== undefined && candidate[key] !== null)
      .map((key) => [key, candidate[key]])
  );
}

function vacancyAiContext(vacancy = null) {
  if (!vacancy) return null;
  return {
    id: vacancy.id || null,
    title: vacancy.title || null,
    role: vacancy.role || null,
    city: vacancy.operation?.city?.name || vacancy.city || null,
    requirements: vacancy.requirements || null,
    conditions: vacancy.conditions || null,
    experienceRequired: vacancy.experienceRequired || null,
    experienceTimeText: vacancy.experienceTimeText || null
  };
}

function normalizePipelineError(error) {
  const validationIssues = error?.issues
    || error?.cause?.issues
    || error?.cause?.errors
    || null;

  return {
    name: error?.name || 'Error',
    message: String(error?.message || error || 'unknown_error').slice(0, 500),
    issues: Array.isArray(validationIssues)
      ? validationIssues.slice(0, 20).map((issue) => ({
          code: issue?.code || null,
          path: Array.isArray(issue?.path) ? issue.path : [],
          message: issue?.message || null
        }))
      : null
  };
}

function logPipelineError(error, context = {}) {
  const normalized = normalizePipelineError(error);
  const validationError = [
    'ConversationTurnInputValidationError',
    'ConversationDecisionValidationError'
  ].includes(normalized.name);

  console.error(
    validationError ? '[CONVERSATION_PIPELINE_VALIDATION_ERROR]' : '[CONVERSATION_PIPELINE_ERROR]',
    JSON.stringify({ ...context, error: normalized })
  );
}

export async function saveInboundMessage(
  prisma,
  candidateId,
  message,
  body,
  type,
  phone
) {
  const waMessageId = message?.id || null;
  const persist = (messageType) => persistInboundConversationMessage(prisma, {
    candidateId,
    waMessageId,
    messageType,
    body,
    rawPayload: sanitizeForRawPayload(message)
  });

  let persisted;
  try {
    persisted = await persist(type);
  } catch (error) {
    const enumMismatch = /invalid input value for enum "MessageType"/i
      .test(String(error?.message || ''));
    if (!enumMismatch || type === MessageType.UNKNOWN) throw error;

    console.warn('[INBOUND_MESSAGE_TYPE_FALLBACK]', JSON.stringify({
      phone: phone || null,
      candidateId,
      waMessageId,
      requestedType: type,
      persistedType: MessageType.UNKNOWN
    }));
    persisted = await persist(MessageType.UNKNOWN);
  }

  if (!persisted.created) {
    console.info('[INBOUND_DUPLICATE_IGNORED]', JSON.stringify({
      phone: phone || null,
      waMessageId
    }));
    return { isNew: false, id: null };
  }

  await prisma.candidate.update({
    where: { id: candidateId },
    data: { lastInboundAt: new Date() }
  });

  if (!waMessageId) return { isNew: true, id: null };

  const stored = await findInboundConversationMessage(prisma, {
    candidateId,
    waMessageId
  });

  return {
    isNew: true,
    id: stored.message?.id || null
  };
}

async function prepareCandidateForInboundAutomation(prisma, candidate = {}) {
  if (!candidate?.botPaused) return candidate;
  if (shouldBlockAutomation(candidate, { direction: 'INBOUND' })) return candidate;
  if (!shouldResumeAutomationOnInbound(candidate)) return candidate;

  const transition = await resumeCandidateAutomationOnInbound(prisma, {
    candidateId: candidate.id,
    expected: {
      botPaused: candidate.botPaused,
      botPausedAt: candidate.botPausedAt ?? null,
      botPausedBy: candidate.botPausedBy ?? null,
      botPauseReason: candidate.botPauseReason ?? null,
      botResumeMode: candidate.botResumeMode ?? null
    },
    now: new Date()
  });

  return transition.candidate || candidate;
}

async function loadVacancy(prisma, vacancyId) {
  if (!vacancyId) return null;
  return prisma.vacancy.findUnique({
    where: { id: vacancyId },
    include: {
      operation: {
        include: { city: true }
      }
    }
  });
}

async function loadConversationHistory(prisma, candidateId) {
  const rows = await prisma.message.findMany({
    where: {
      candidateId,
      OR: [
        { direction: MessageDirection.OUTBOUND },
        {
          direction: MessageDirection.INBOUND,
          respondedAt: { not: null }
        }
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
    select: {
      direction: true,
      body: true,
      createdAt: true
    }
  });

  return rows.reverse().map((row) => ({
    role: row.direction === MessageDirection.OUTBOUND ? 'assistant' : 'user',
    text: String(row.body || ''),
    occurredAt: row.createdAt
  }));
}

async function loadPendingActions(prisma, candidateId) {
  const latestOutbound = await prisma.message.findFirst({
    where: {
      candidateId,
      direction: MessageDirection.OUTBOUND
    },
    orderBy: { createdAt: 'desc' },
    select: { rawPayload: true }
  });

  const actions = latestOutbound?.rawPayload?.pendingActions;
  return Array.isArray(actions) ? actions : [];
}

async function prepareAttachmentEvidence(prisma, candidate, message) {
  if (!['document', 'image', 'audio', 'video', 'sticker'].includes(message.type)) {
    return {
      manualOnly: false,
      attachments: {
        items: [],
        hasCv: hasValidCv(candidate)
      }
    };
  }

  const media = message?.[message.type] || {};
  await notifySupervisorAttachment(prisma, candidate, {
    mediaType: message.type,
    media,
    caption: media.caption || media.filename || media.mime_type || ''
  }).catch((error) => {
    console.warn('[ADMIN_SUPERVISOR_ATTACHMENT_ERROR]', String(error?.message || error));
  });

  // Audio remains a human-review transport path. It is deliberately not
  // transcribed and never enters the automatic conversation decision pipeline.
  if (message.type === 'audio') {
    return {
      manualOnly: true,
      attachments: {
        items: [attachmentItemFromMessage(message, false)],
        hasCv: hasValidCv(candidate)
      }
    };
  }

  let currentTurnIsCv = false;
  if (message.type === 'document') {
    const mimeType = String(message.document?.mime_type || '');
    const filename = String(message.document?.filename || 'hoja_de_vida');

    if (isCvMimeTypeAllowed(mimeType, filename)) {
      const metadata = await fetchMediaMetadata(message.document.id);
      const buffer = await downloadMedia(metadata.url);
      await storeCandidateCv(prisma, candidate.id, buffer, {
        mimeType: mimeType || null,
        originalName: filename
      });
      currentTurnIsCv = true;
    }
  }

  const refreshedCandidate = currentTurnIsCv
    ? await prisma.candidate.findUnique({ where: { id: candidate.id } })
    : candidate;

  return {
    manualOnly: false,
    attachments: {
      items: [attachmentItemFromMessage(message, currentTurnIsCv)],
      hasCv: currentTurnIsCv || hasValidCv(refreshedCandidate)
    }
  };
}

async function scheduleTextBatch(prisma, candidateId) {
  const windowMs = getMultilineWindowMs();
  return scheduleCandidateMultilineWindow(prisma, {
    candidateId,
    windowMs,
    now: new Date()
  });
}

async function acquireTextBatch(prisma, candidateId, scheduled = {}) {
  const acquired = await acquireCandidateMultilineBatch(prisma, {
    candidateId,
    expected: { multilineBatchVersion: scheduled.batchVersion },
    now: new Date()
  });
  return acquired.count === 1;
}

async function loadPendingTextBatch(prisma, candidateId) {
  return prisma.message.findMany({
    where: {
      candidateId,
      direction: MessageDirection.INBOUND,
      messageType: MessageType.TEXT,
      respondedAt: null
    },
    orderBy: { createdAt: 'asc' },
    take: 12
  });
}

async function resolveTurnVacancy(prisma, candidate, rawText) {
  const currentVacancy = await loadVacancy(prisma, candidate.vacancyId);
  if (!normalizeText(rawText)) {
    return { currentVacancy, turnVacancy: currentVacancy };
  }

  const resolution = await resolveVacancyFromText(prisma, rawText);
  return {
    currentVacancy,
    turnVacancy: resolution?.resolved && resolution.vacancy
      ? resolution.vacancy
      : currentVacancy
  };
}

async function buildTurnInterpretation({
  rawText,
  candidate,
  vacancy,
  pendingFields,
  conversationContext
}) {
  const fallbackIntent = detectConversationIntent(rawText, {
    currentStep: candidate.currentStep,
    isDoneStep: candidate.currentStep === 'DONE'
  });

  if (!normalizeText(rawText)) {
    return {
      intent: fallbackIntent,
      fields: {},
      scheduling: { slot: null },
      consent: { decision: null }
    };
  }

  const semanticContext = {
    currentStep: candidate.currentStep,
    pendingFields,
    lastBotQuestion: conversationContext.lastBotQuestion,
    recentConversation: conversationContext.recentConversation,
    vacancy: vacancyAiContext(vacancy),
    candidateKnownData: candidateKnownData(candidate)
  };

  const aiResult = await tryOpenAIParse(rawText, semanticContext);
  const understanding = await conversationUnderstanding(rawText, {
    aiResult,
    context: semanticContext,
    runtime: {
      localParsedData: parseNaturalData(rawText),
      engineFields: {},
      engineUsage: {},
      vacancy,
      fallbackIntent
    }
  });

  const interpreted = understanding.turnInterpretation || {};
  return {
    // Deterministic intent detection supplies the vocabulary expected by the
    // canonical mapper. AI remains the semantic entity extractor upstream.
    intent: fallbackIntent || interpreted.intent || aiResult.intent || null,
    fields: interpreted.fields || understanding.candidateFields || {},
    scheduling: { slot: null },
    consent: { decision: null }
  };
}

function pendingActionsFromExecution(execution = {}) {
  if (
    execution?.scheduling?.action !== 'suggest_slots'
    || !Array.isArray(execution.scheduling.suggestions)
    || execution.scheduling.suggestions.length === 0
  ) {
    return [];
  }

  const slots = execution.scheduling.suggestions;
  const timezone = slots[0]?.timezone || DEFAULT_SCHEDULING_TIMEZONE;
  return [{
    type: 'suggested_slots',
    payload: {
      slots,
      timezone
    }
  }];
}

async function deliverExecutionReply({
  prisma,
  candidate,
  to,
  input,
  execution
}) {
  const reply = execution?.reply;
  const text = String(reply?.text || '').trim();
  const buttons = Array.isArray(reply?.buttons) ? reply.buttons : [];
  if (!text) return null;

  const pendingActions = pendingActionsFromExecution(execution);
  const rawPayload = {
    source: 'functional_core',
    turnId: input.turn.id,
    intent: input.interpretation.intent,
    schedulingAction: execution?.scheduling?.action || null,
    pendingActions
  };

  const interactive = buttons.length > 0;
  const delivery = await deliverAutomaticOutboundText(prisma, {
    candidateId: candidate.id,
    to,
    body: text,
    messageType: interactive ? MessageType.INTERACTIVE : MessageType.TEXT,
    rawPayload
  }, {
    sendText: interactive
      ? (recipient, body) => sendReplyButtonsMessage(recipient, body, buttons)
      : sendTextMessage
  });

  if (delivery?.sent) {
    await scheduleReminderForCandidate(prisma, candidate.id).catch((error) => {
      console.warn('[REMINDER_SCHEDULE_ERROR]', String(error?.message || error));
    });
  }

  return delivery;
}

async function executeFunctionalTurn({
  prisma,
  candidateId,
  to,
  rawMessage,
  rawText,
  attachments
}) {
  let candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  candidate = await prepareCandidateForInboundAutomation(prisma, candidate);
  if (!candidate || shouldBlockAutomation(candidate, { direction: 'INBOUND' })) {
    return { blocked: true };
  }

  const { turnVacancy } = await resolveTurnVacancy(prisma, candidate, rawText);
  const readiness = getCandidateReadiness(candidate, turnVacancy, { requireCv: false });
  const pendingFields = readiness.missingFields || [];

  const [conversationContext, history, pendingActions] = await Promise.all([
    loadConversationInterpretationContext(prisma, { candidateId }),
    loadConversationHistory(prisma, candidateId),
    loadPendingActions(prisma, candidateId)
  ]);

  const interpretation = await buildTurnInterpretation({
    rawText,
    candidate,
    vacancy: turnVacancy,
    pendingFields,
    conversationContext
  });

  const input = await buildConversationTurnInput({
    rawMessage,
    rawText,
    candidate,
    vacancy: turnVacancy,
    history,
    pending: {
      fields: pendingFields,
      actions: pendingActions
    },
    attachments,
    interpretation,
    execution: {
      mayReply: true,
      dryRun: false
    }
  });

  const decision = await calculateConversationDecision(input);
  const execution = await executeConversationDecision({
    prisma,
    input,
    decision
  });

  await deliverExecutionReply({
    prisma,
    candidate,
    to,
    input,
    execution
  });

  return {
    blocked: false,
    input,
    decision,
    execution
  };
}

async function processTextMessage({ prisma, candidate, from, message, inbound }) {
  const scheduled = await scheduleTextBatch(prisma, candidate.id);
  await sleep(scheduled.windowMs ?? getMultilineWindowMs());

  if (!await acquireTextBatch(prisma, candidate.id, scheduled)) return;

  const batch = await loadPendingTextBatch(prisma, candidate.id);
  if (!batch.length) return;

  const consolidatedText = consolidateTextMessages(batch);
  const anchor = batch[batch.length - 1];
  const rawMessage = {
    ...(anchor.rawPayload && typeof anchor.rawPayload === 'object'
      ? anchor.rawPayload
      : message),
    id: anchor.waMessageId || message.id,
    type: 'text',
    text: { body: consolidatedText }
  };

  await executeFunctionalTurn({
    prisma,
    candidateId: candidate.id,
    to: from,
    rawMessage,
    rawText: consolidatedText,
    attachments: {
      items: [],
      hasCv: hasValidCv(await prisma.candidate.findUnique({ where: { id: candidate.id } }))
    }
  });

  await markConversationMessagesResponded(prisma, {
    messageIds: batch.map((row) => row.id),
    respondedAt: new Date()
  });

  // Kept only to make the ownership of the persisted inbound explicit in the
  // single-message case; batching may have selected a newer anchor.
  void inbound;
}

async function processNonTextMessage({ prisma, candidate, from, message, inbound }) {
  const candidateBeforeAttachment = await prisma.candidate.findUnique({
    where: { id: candidate.id }
  });
  const prepared = await prepareAttachmentEvidence(
    prisma,
    candidateBeforeAttachment,
    message
  );

  if (prepared.manualOnly) return;

  await executeFunctionalTurn({
    prisma,
    candidateId: candidate.id,
    to: from,
    rawMessage: message,
    rawText: rawTextFromMessage(message),
    attachments: prepared.attachments
  });

  if (inbound.id) {
    await markConversationMessagesResponded(prisma, {
      messageIds: [inbound.id],
      respondedAt: new Date()
    });
  }
}

async function processCandidateMessage(prisma, message) {
  const from = String(message?.from || '').trim();
  if (!from) return;

  if (isSupervisorPhone(from)) {
    if (message.type === 'text') {
      await handleSupervisorInbound(prisma, message);
    } else {
      console.info('[ADMIN_SUPERVISOR_NON_TEXT_IGNORED]', JSON.stringify({
        from,
        type: message.type || 'unknown'
      }));
    }
    return;
  }

  if (!checkRateLimit(from)) return;

  const candidate = await prisma.candidate.upsert({
    where: { phone: from },
    update: {},
    create: { phone: from }
  });

  const body = inboundBodyFromMessage(message);
  const inbound = await saveInboundMessage(
    prisma,
    candidate.id,
    message,
    body,
    resolveInboundMessageType(message),
    from
  );
  if (!inbound.isNew) return;

  await cancelReminderOnInbound(prisma, candidate.id).catch((error) => {
    console.warn('[REMINDER_CANCEL_ERROR]', String(error?.message || error));
  });

  let freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
  freshCandidate = await prepareCandidateForInboundAutomation(prisma, freshCandidate);
  if (shouldBlockAutomation(freshCandidate, { direction: 'INBOUND' })) return;

  if (message.type === 'text') {
    await processTextMessage({
      prisma,
      candidate: freshCandidate,
      from,
      message,
      inbound
    });
    return;
  }

  await processNonTextMessage({
    prisma,
    candidate: freshCandidate,
    from,
    message,
    inbound
  });
}

async function processWebhookPayload(prisma, payload) {
  const messages = extractMessages(payload);
  for (const message of messages) {
    try {
      await processCandidateMessage(prisma, message);
    } catch (error) {
      logPipelineError(error, {
        phone: message?.from || null,
        messageId: message?.id || null,
        messageType: message?.type || null
      });
    }
  }
}

export function webhookRouter(prisma) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  router.post('/', (req, res) => {
    const payload = req.body;

    // Meta must be acknowledged immediately. Internal processing is explicitly
    // fail-open so provider retries cannot amplify an application-side failure.
    res.sendStatus(200);

    void processWebhookPayload(prisma, payload).catch((error) => {
      logPipelineError(error, { scope: 'webhook_payload' });
    });
  });

  return router;
}
