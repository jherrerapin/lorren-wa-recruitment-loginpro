import { MessageDirection, MessageType } from '@prisma/client';
import { shouldBlockAutomation } from './botAutomationPolicy.js';
import { acquireCandidateMultilineBatch } from './candidateStateService.js';
import { createDebugTrace, summarizeError } from './debugTrace.js';
import { consolidateTextMessages, summarizeConsolidatedInput } from './multiline.js';
import {
  markConversationMessagesResponded,
  mergeConversationMessagePayload
} from './conversationMessageRepository.js';

const DEFAULT_BATCH_LIMIT = 20;
const MAX_PENDING_TEXTS = 12;

function normalizeLimit(value) {
  const limit = Number(value ?? DEFAULT_BATCH_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('multiline_batch_limit_invalid');
  }
  return limit;
}

function normalizeNow(value) {
  const now = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(now.getTime())) throw new TypeError('multiline_batch_now_invalid');
  return now;
}

function requireProcessorClient(prisma) {
  if (
    typeof prisma?.candidate?.findMany !== 'function'
    || typeof prisma?.candidate?.findUnique !== 'function'
    || typeof prisma?.candidate?.updateMany !== 'function'
    || typeof prisma?.message?.findMany !== 'function'
  ) {
    throw new TypeError('multiline_batch_prisma_client_required');
  }
  return prisma;
}

function requireTextProcessor(value) {
  if (typeof value !== 'function') {
    throw new TypeError('multiline_batch_text_processor_required');
  }
  return value;
}

async function attachBatchDebugTrace(prisma, messageId, debugTrace) {
  if (!messageId || typeof prisma?.message?.findUnique !== 'function' || typeof prisma?.message?.update !== 'function') return;
  await mergeConversationMessagePayload(prisma, {
    messageId,
    patch: { debugTrace }
  }).catch((error) => {
    console.warn('[MULTILINE_WORKER_TRACE_ERROR]', JSON.stringify({
      messageId,
      error: summarizeError(error)
    }));
  });
}

async function markPotentialDuplicateByDocument(prisma, candidateId) {
  if (typeof prisma?.candidate?.findFirst !== 'function') return;
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { id: true, phone: true, documentType: true, documentNumber: true }
  });
  if (!candidate?.documentType || !candidate?.documentNumber) return;

  const duplicate = await prisma.candidate.findFirst({
    where: {
      id: { not: candidate.id },
      documentType: candidate.documentType,
      documentNumber: candidate.documentNumber,
      phone: { not: candidate.phone }
    },
    select: { id: true, phone: true }
  });
  if (!duplicate) return;

  await prisma.candidate.update({
    where: { id: candidate.id },
    data: {
      potentialDuplicate: true,
      potentialDuplicateAt: new Date(),
      potentialDuplicateNote: `Documento coincide con ${duplicate.phone}`
    }
  });
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
    take: MAX_PENDING_TEXTS
  });
}

async function processClaimedBatch(prisma, snapshot, now, processCandidateText) {
  const candidate = await prisma.candidate.findUnique({ where: { id: snapshot.id } });
  if (!candidate || shouldBlockAutomation(candidate, { direction: 'INBOUND' })) {
    return { processed: false, reason: candidate ? 'automation_blocked' : 'candidate_missing' };
  }

  const pendingBatch = await loadPendingTextBatch(prisma, candidate.id);
  if (!pendingBatch.length) return { processed: false, reason: 'no_pending_texts' };

  const consolidatedText = consolidateTextMessages(pendingBatch);
  const anchorMessage = pendingBatch[pendingBatch.length - 1];
  const debugTrace = createDebugTrace({
    phone: candidate.phone,
    currentStepBefore: candidate.currentStep
  });

  try {
    await processCandidateText(
      prisma,
      candidate,
      candidate.phone,
      consolidatedText,
      debugTrace,
      {
        inboundMessageId: anchorMessage.waMessageId,
        batchedMessageCount: pendingBatch.length,
        usedMultilineContext: pendingBatch.length > 1,
        consolidatedInputSummary: summarizeConsolidatedInput(consolidatedText)
      }
    );
    await markPotentialDuplicateByDocument(prisma, candidate.id);
    await markConversationMessagesResponded(prisma, {
      messageIds: pendingBatch.map((message) => message.id),
      respondedAt: now
    });
    return { processed: true, messageCount: pendingBatch.length };
  } catch (error) {
    debugTrace.error_summary = summarizeError(error);
    console.error('[MULTILINE_WORKER_PROCESS_ERROR]', JSON.stringify({
      candidateId: candidate.id,
      error: debugTrace.error_summary
    }));
    return { processed: false, reason: 'processing_error', error };
  } finally {
    const updatedCandidate = await prisma.candidate.findUnique({
      where: { id: candidate.id },
      select: { currentStep: true }
    }).catch(() => null);
    debugTrace.currentStep_after = updatedCandidate?.currentStep || debugTrace.currentStep_before;
    await attachBatchDebugTrace(prisma, anchorMessage.id, debugTrace);
  }
}

export async function processDueMultilineCandidates(prisma, options = {}) {
  const client = requireProcessorClient(prisma);
  const now = normalizeNow(options.now);
  const limit = normalizeLimit(options.limit);
  const processCandidateText = requireTextProcessor(options.processCandidateText);

  const dueCandidates = await client.candidate.findMany({
    where: {
      multilineWindowUntil: { lte: now }
    },
    orderBy: { multilineWindowUntil: 'asc' },
    take: limit,
    select: {
      id: true,
      phone: true,
      multilineBatchVersion: true,
      multilineWindowUntil: true
    }
  });

  const stats = {
    due: dueCandidates.length,
    claimed: 0,
    processed: 0,
    blocked: 0,
    empty: 0,
    errors: 0
  };

  for (const snapshot of dueCandidates) {
    const claim = await acquireCandidateMultilineBatch(client, {
      candidateId: snapshot.id,
      expected: { multilineBatchVersion: snapshot.multilineBatchVersion },
      now
    });
    if (claim.count !== 1) continue;
    stats.claimed += 1;

    const result = await processClaimedBatch(client, snapshot, now, processCandidateText);
    if (result.processed) stats.processed += 1;
    else if (result.reason === 'automation_blocked') stats.blocked += 1;
    else if (result.reason === 'no_pending_texts' || result.reason === 'candidate_missing') stats.empty += 1;
    else if (result.reason === 'processing_error') stats.errors += 1;
  }

  return stats;
}
