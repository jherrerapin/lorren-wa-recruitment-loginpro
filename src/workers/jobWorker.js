import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { claimDueJobs, completeJob, failJob, JOB_TYPES } from '../services/jobQueue.js';
import {
  acquireMessageLock,
  releaseMessageLock
} from '../infrastructure/transport/messageIdempotency.js';
import { openaiAdapter } from '../infrastructure/llm/openaiAdapter.js';
import { extractCandidateData } from '../infrastructure/llm/aiExtractionService.js';
import { whatsappClient } from '../infrastructure/transport/whatsappClient.js';
import { downloadWhatsappMedia } from '../infrastructure/transport/whatsappMediaService.js';
import { extractDocumentText } from '../infrastructure/parsers/documentParser.js';
import {
  buildConversationTurnInput,
  deriveCandidatePendingFields
} from '../core/middlewares/buildConversationTurnInput.js';
import { calculateConversationDecision } from '../core/engine/calculateConversationDecision.js';
import { executeConversationDecision } from '../core/shell/executeConversationDecision.js';
import {
  runCandidateProcessReminderDispatcher,
  runInterviewReminderDispatcher
} from '../services/reminder.js';
import { runAutoCvMigration } from '../services/cvMigration.js';
import { ensureSupervisorWindowOpen } from '../services/adminSupervisor.js';
import { runDispatchWhatsappWindowReminderDispatcher } from '../services/dispatchWhatsappAdminAlerts.js';

const prisma = new PrismaClient();
const POLL_MS = Number.parseInt(process.env.JOB_WORKER_POLL_MS || '5000', 10);
const DISPATCH_WINDOW_REMINDER_SWEEP_MS = 10000;
let lastDispatchWindowReminderSweepAt = 0;

const PARSEABLE_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizedMimeType(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

function attachmentsFromPayload(payload) {
  const media = asRecord(payload?.media);
  if (!['document', 'image', 'audio'].includes(payload?.type)
    || typeof media.mediaId !== 'string'
    || typeof media.mimeType !== 'string') {
    return { current: [] };
  }
  return {
    current: [{
      providerId: media.mediaId,
      type: payload.type,
      fileName: typeof media.fileName === 'string' ? media.fileName : null,
      mimeType: media.mimeType,
      extractedText: typeof media.extractedText === 'string' ? media.extractedText : null,
      status: typeof media.status === 'string' ? media.status : 'received'
    }]
  };
}

async function processInboundDocument(payload, dependencies) {
  const media = asRecord(payload?.media);
  const mimeType = normalizedMimeType(media.mimeType);
  if (payload?.type !== 'document'
    || typeof media.mediaId !== 'string'
    || !PARSEABLE_DOCUMENT_MIME_TYPES.has(mimeType)) {
    return payload;
  }

  const downloadMedia = dependencies.downloadWhatsappMedia ?? downloadWhatsappMedia;
  const parseDocument = dependencies.extractDocumentText ?? extractDocumentText;
  let mediaBuffer = null;
  try {
    mediaBuffer = await downloadMedia(media.mediaId);
    const extractedText = await parseDocument(mediaBuffer, mimeType);
    return {
      ...payload,
      media: {
        ...media,
        extractedText,
        status: extractedText ? 'processed' : 'failed'
      }
    };
  } finally {
    // No Buffer crosses into the serializable functional core. Dropping this
    // reference makes the binary eligible for garbage collection immediately.
    mediaBuffer = null;
  }
}

async function loadExtractionContext(payload, activePrisma) {
  if (typeof payload?.from !== 'string' || !payload.from.trim()) {
    return { pendingFields: [], activeVacancies: [], candidateSummary: {}, candidateCity: null, recentCandidateMessages: [] };
  }
  const candidate = await activePrisma.candidate.findUnique({
    where: { phone: payload.from.trim() },
    include: { vacancy: true }
  });
  const activeVacancies = await activePrisma.vacancy.findMany({
    where: { isActive: true, acceptingApplications: true },
    select: {
      id: true,
      role: true,
      title: true,
      city: true,
      isActive: true,
      acceptingApplications: true,
      minAge: true,
      maxAge: true,
      experienceRequired: true,
      experienceTimeText: true,
      schedulingEnabled: true,
      zoneFilterEnabled: true
    }
  });
  const candidateSummary = candidate ? {
    city: candidate.city ?? null,
    locality: candidate.locality ?? null,
    neighborhood: candidate.neighborhood ?? null,
    vacancyId: candidate.vacancyId ?? null
  } : {};
  const recentCandidateMessages = candidate?.id && !candidate.vacancyId
    && typeof activePrisma.message?.findMany === 'function'
    ? (await activePrisma.message.findMany({
        where: { candidateId: candidate.id, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
        take: 4,
        select: { body: true }
      })).reverse().map((item) => String(item.body || '').slice(0, 500))
    : [];

  return {
    pendingFields: candidate ? deriveCandidatePendingFields(candidate) : ['dataConsent', 'vacancyId'],
    activeVacancies,
    candidateSummary,
    candidateCity: candidate?.city ?? candidate?.locality ?? null,
    recentCandidateMessages
  };
}

export function conversationDecisionTrace(input, decision, extractionStatus = 'not_run') {
  const detected = asRecord(input?.interpretation?.detectedFields);
  const directive = decision?.reply?.directive;
  return {
    event: 'conversation_decision.trace',
    extractionStatus: ['ok', 'no_result', 'not_run'].includes(extractionStatus)
      ? extractionStatus : 'not_run',
    roleDetected: typeof detected.roleHint === 'string' && Boolean(detected.roleHint.trim()),
    cityDetected: typeof detected.cityHint === 'string' && Boolean(detected.cityHint.trim()),
    vacancyMatched: Boolean(input?.vacancy?.id || input?.candidate?.facts?.vacancyId),
    directive: typeof directive === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(directive)
      ? directive : null,
    handoffToHuman: decision?.transitions?.handoffToHuman === true
  };
}

function withInterpretation(payload, extractedInterpretation, activeVacancies = []) {
  if (!extractedInterpretation) return payload;
  const interpretation = payload?.interpretation && typeof payload.interpretation === 'object'
    ? payload.interpretation
    : {};
  const extractedFields = {
    ...(interpretation.extractedFields && typeof interpretation.extractedFields === 'object'
      ? interpretation.extractedFields
      : {}),
    ...(extractedInterpretation.extractedFields || {})
  };

  const vacancyId = extractedFields.vacancyId;
  const resolvedVacancy = typeof vacancyId === 'string'
    ? activeVacancies.find((vacancy) => vacancy.id === vacancyId) ?? null
    : null;

  return {
    ...payload,
    ...(resolvedVacancy ? { resolvedVacancy } : {}),
    interpretation: {
      ...interpretation,
      ...extractedInterpretation,
      ...(Object.keys(extractedFields).length ? { extractedFields } : {})
    }
  };
}

export async function runJob(job, dependencies = {}) {
  const activePrisma = dependencies.prisma ?? prisma;

  if (job.type === JOB_TYPES.WHATSAPP_INBOUND_MESSAGE) {
    const payload = job?.payload;
    const acquire = dependencies.acquireMessageLock ?? acquireMessageLock;
    const release = dependencies.releaseMessageLock ?? releaseMessageLock;
    const buildInput = dependencies.buildConversationTurnInput ?? buildConversationTurnInput;
    const calculate = dependencies.calculateConversationDecision ?? calculateConversationDecision;
    const execute = dependencies.executeConversationDecision ?? executeConversationDecision;
    const extractData = dependencies.extractCandidateData ?? extractCandidateData;
    const llmService = dependencies.llmService ?? openaiAdapter;
    const outboundClient = dependencies.whatsappClient ?? whatsappClient;

    const acquired = await acquire(payload?.messageId, { prisma: activePrisma });
    if (!acquired) return;

    try {
      let enrichedPayload = await processInboundDocument(payload, dependencies);
      let extractionStatus = 'not_run';
      const hasExtractableEvidence = typeof enrichedPayload?.text === 'string'
        || (typeof enrichedPayload?.media?.extractedText === 'string'
          && enrichedPayload.media.extractedText.trim().length > 0);
      if (enrichedPayload?.isSystemAction !== true && hasExtractableEvidence) {
        const extractionContext = await loadExtractionContext(enrichedPayload, activePrisma);
        extractionContext.attachments = attachmentsFromPayload(enrichedPayload);
        const { pendingFields } = extractionContext;
        if (pendingFields.length) {
          const interpretation = await extractData(
            typeof enrichedPayload.text === 'string' ? enrichedPayload.text : '',
            pendingFields,
            extractionContext
          );
          extractionStatus = interpretation ? 'ok' : 'no_result';
          enrichedPayload = withInterpretation(
            enrichedPayload,
            interpretation,
            extractionContext.activeVacancies
          );
        }
      }
      const input = await buildInput(enrichedPayload, { prisma: activePrisma });
      const decision = await calculate(input);
      console.info('[CONVERSATION_DECISION_TRACE]', JSON.stringify(
        conversationDecisionTrace(input, decision, extractionStatus)
      ));
      await execute(input, decision, {
        prisma: activePrisma,
        llmService,
        whatsappClient: outboundClient
      });
    } catch (error) {
      // The queue remains the durable authority. Removing only the processing
      // lock allows failJob to schedule the same job for another attempt.
      await release(payload?.messageId, { prisma: activePrisma });
      throw error;
    }
    return;
  }

  if (job.type === JOB_TYPES.CANDIDATE_PROCESS_REMINDER) {
    await runCandidateProcessReminderDispatcher(activePrisma, {
      now: new Date(),
      candidateId: job?.payload?.candidateId ? String(job.payload.candidateId) : null
    });
    return;
  }

  if (job.type === JOB_TYPES.INTERVIEW_REMINDER) {
    await runInterviewReminderDispatcher(activePrisma, {
      now: new Date(),
      candidateId: job?.payload?.candidateId ? String(job.payload.candidateId) : null
    });
    return;
  }

  if (job.type === JOB_TYPES.CV_STORAGE_MIGRATION) {
    await runAutoCvMigration(activePrisma);
    return;
  }
  if (job.type === JOB_TYPES.ADMIN_FORWARD_ATTACHMENT) {
    // El reenvio se realiza asincronicamente por worker; no debe bloquear webhook.
    return;
  }
}

export async function tick(dependencies = {}) {
  const activePrisma = dependencies.prisma ?? prisma;
  const now = new Date();
  const jobs = await claimDueJobs(activePrisma, { limit: 20, now });

  for (const job of jobs) {
    try {
      await runJob(job, { ...dependencies, prisma: activePrisma });
      await completeJob(activePrisma, job.id);
    } catch (error) {
      if (job.type === JOB_TYPES.WHATSAPP_INBOUND_MESSAGE) {
        console.error('[WHATSAPP_INBOUND_JOB_FAILED]', {
          jobId: job.id,
          errorName: error?.name || 'UnknownError',
          providerStatus: error?.status ?? null,
          providerCode: error?.providerCode ?? null,
          requestAttempted: error?.requestAttempted ?? null
        });
      }
      await failJob(activePrisma, job.id, error?.message || 'worker_error');
    }
  }

  await ensureSupervisorWindowOpen(activePrisma, { now }).catch((error) =>
    console.warn('[ADMIN_WINDOW_KEEPALIVE_ERROR]', error?.message || error)
  );

  if (now.getTime() - lastDispatchWindowReminderSweepAt >= DISPATCH_WINDOW_REMINDER_SWEEP_MS) {
    lastDispatchWindowReminderSweepAt = now.getTime();
    await runDispatchWhatsappWindowReminderDispatcher(activePrisma, { now }).catch((error) =>
      console.warn('[DISPATCH_WINDOW_REMINDER_ERROR]', error?.message || error)
    );
  }
}

export function startJobWorker(dependencies = {}) {
  const timer = setInterval(() => {
    tick(dependencies).catch((error) => console.error('[JOB_WORKER_TICK_ERROR]', error));
  }, POLL_MS);

  console.log('[JOB_WORKER_STARTED]', { pollMs: POLL_MS });
  return timer;
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) startJobWorker();
