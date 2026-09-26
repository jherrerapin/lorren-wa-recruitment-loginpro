import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ConversationTurnInputSchema } from '../contracts/ConversationTurnInputSchema.js';
import { isRecruitmentWhatsappPayload } from '../../services/whatsapp.js';
import { isSupervisorPhone } from '../../services/adminSupervisor.js';

const CANDIDATE_FACT_KEYS = Object.freeze([
  'phone',
  'vacancyId',
  'currentStep',
  'status',
  'stage',
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'gender',
  'locality',
  'neighborhood',
  'transportMode',
  'medicalRestrictions',
  'experienceInfo',
  'experienceTime',
  'experienceSummary',
  'cvStorageKey',
  'cvOriginalName',
  'dataConsentStatus',
  'dataConsentVersion',
  'botPaused',
  'botResumeMode',
  'reminderState',
  'lastInboundAt',
  'lastOutboundAt'
]);

/** @param {unknown} value */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** @param {Record<string, unknown>} record @param {string} key */
function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function toJsonValue(value) {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    return value
      .map(toJsonValue)
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      const normalized = toJsonValue(nested);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  return undefined;
}

function normalizeIsoTimestamp(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value instanceof Date) return value.toISOString();
  if ((typeof value === 'string' && /^\d{10,13}$/.test(value)) || typeof value === 'number') {
    const numericValue = Number(value);
    const milliseconds = numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function buildCandidateFacts(candidate = {}) {
  const facts = {};
  for (const key of CANDIDATE_FACT_KEYS) {
    if (!hasOwn(candidate, key)) continue;
    const value = toJsonValue(candidate[key]);
    if (value !== undefined) facts[key] = value;
  }
  return facts;
}

function buildVacancySnapshot(vacancy = null) {
  if (!vacancy) return null;
  const operation = asRecord(vacancy.operation);
  const city = asRecord(operation.city);
  return {
    id: vacancy.id ?? null,
    title: vacancy.title ?? null,
    role: vacancy.role ?? null,
    city: vacancy.city ?? null,
    schedulingEnabled: vacancy.schedulingEnabled ?? null,
    interviewSchedulingEnabled: vacancy.interviewSchedulingEnabled ?? null,
    requirements: vacancy.requirements ?? null,
    conditions: vacancy.conditions ?? null,
    roleDescription: vacancy.roleDescription ?? null,
    requiredDocuments: vacancy.requiredDocuments ?? null,
    operationAddress: vacancy.operationAddress ?? null,
    minAge: vacancy.minAge ?? null,
    maxAge: vacancy.maxAge ?? null,
    experienceRequired: vacancy.experienceRequired ?? null,
    experienceTimeText: vacancy.experienceTimeText ?? null,
    operation: Object.keys(operation).length
      ? {
          name: operation.name ?? null,
          city: Object.keys(city).length ? { name: city.name ?? null } : null
        }
      : null
  };
}

function buildHistory(history = []) {
  const rows = Array.isArray(history) ? history : (Array.isArray(history?.messages) ? history.messages : []);
  const messages = rows.map((message) => {
    const row = asRecord(message);
    const role = row.role
      || (String(row.direction || '').toUpperCase() === 'OUTBOUND' ? 'assistant' : 'user');
    return {
      role,
      text: String(row.text ?? row.body ?? ''),
      occurredAt: normalizeIsoTimestamp(row.occurredAt ?? row.createdAt, new Date().toISOString())
    };
  });
  const lastBotQuestion = !Array.isArray(history)
    ? (history?.lastBotQuestion ?? null)
    : [...messages].reverse().find((message) => message.role === 'assistant' && message.text.includes('?'))?.text ?? null;
  return { messages, lastBotQuestion };
}

function buildInterpretation(interpretation = {}) {
  const source = asRecord(interpretation);
  const scheduling = asRecord(source.scheduling);
  const consent = asRecord(source.consent);
  const slot = asRecord(scheduling.slot);
  return {
    intent: source.intent ?? null,
    scheduling: {
      slot: Object.keys(slot).length
        ? {
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            timezone: slot.timezone
          }
        : null
    },
    consent: {
      decision: consent.decision ?? null
    }
  };
}

function findFirstMetaMessage(body) {
  const entry = asRecord(Array.isArray(body.entry) ? body.entry[0] : undefined);
  const change = asRecord(Array.isArray(entry.changes) ? entry.changes[0] : undefined);
  const value = asRecord(change.value);
  const messages = Array.isArray(value.messages) ? value.messages : [];
  return asRecord(messages[0]);
}

function extractMetaRawText(message) {
  const type = message.type;
  if (type === 'text') return asRecord(message.text).body ?? '';
  if (type === 'button') {
    const button = asRecord(message.button);
    return button.text ?? button.payload ?? '';
  }
  if (type === 'interactive') {
    const interactive = asRecord(message.interactive);
    return asRecord(interactive.button_reply).title
      ?? asRecord(interactive.list_reply).title
      ?? '';
  }
  if (type === 'image') return asRecord(message.image).caption ?? '';
  if (type === 'document') {
    const document = asRecord(message.document);
    return document.caption ?? document.filename ?? '';
  }
  return '';
}

function hashTurnReference(value) {
  const digest = createHash('sha256').update(String(value || '')).digest('hex').slice(0, 10);
  return `turn-${digest}`;
}

function looksLikeRuntimeBuildRequest(source = {}) {
  return ['turn', 'message', 'rawMessage', 'candidate', 'vacancy', 'history', 'pending', 'interpretation', 'execution']
    .some((key) => hasOwn(source, key));
}

export class ConversationTurnInputValidationError extends Error {
  constructor(zodError) {
    super('conversation_turn_input_invalid');
    this.name = 'ConversationTurnInputValidationError';
    this.cause = zodError;
    this.issues = zodError?.issues || [];
  }
}

/**
 * Runtime builder for the Functional Core. All database/provider objects are
 * reduced to the strict, read-only ConversationTurnInput boundary here.
 */
export async function buildValidatedConversationTurnInput(source = {}) {
  const request = asRecord(source);
  const turn = asRecord(request.turn);
  const rawMessage = asRecord(request.rawMessage ?? request.message);
  const candidate = asRecord(request.candidate);
  const pending = asRecord(request.pending);
  const execution = asRecord(request.execution);

  const input = {
    turn: {
      id: turn.id ?? rawMessage.id ?? randomUUID(),
      receivedAt: normalizeIsoTimestamp(
        turn.receivedAt ?? rawMessage.timestamp,
        new Date().toISOString()
      ),
      rawText: String(turn.rawText ?? request.rawText ?? extractMetaRawText(rawMessage) ?? '')
    },
    candidate: {
      id: candidate.id ?? null,
      facts: request.candidateFacts ?? buildCandidateFacts(candidate),
      updatedAt: normalizeIsoTimestamp(candidate.updatedAt, null)
    },
    history: buildHistory(request.history ?? []),
    pending: {
      fields: Array.isArray(pending.fields) ? pending.fields : [],
      actions: Array.isArray(pending.actions) ? pending.actions : []
    },
    execution: {
      mayReply: execution.mayReply ?? true,
      dryRun: execution.dryRun ?? false
    },
    vacancy: buildVacancySnapshot(request.vacancy),
    interpretation: buildInterpretation(request.interpretation)
  };

  const validation = await ConversationTurnInputSchema.safeParseAsync(input);
  if (!validation.success) {
    throw new ConversationTurnInputValidationError(validation.error);
  }
  return validation.data;
}

/**
 * Transitional compatibility export.
 * - With runtime data, returns Promise<ConversationTurnInput>.
 * - With no runtime data (or only logger), returns the fail-open Express shadow
 *   middleware expected by the current server until webhook cutover is complete.
 */
export function buildConversationTurnInput(sourceOrOptions = {}) {
  const source = asRecord(sourceOrOptions);
  if (looksLikeRuntimeBuildRequest(source)) {
    return buildValidatedConversationTurnInput(source);
  }
  return createConversationTurnInputShadowMiddleware(source);
}

export function createConversationTurnInputShadowMiddleware(options = {}) {
  const logger = options.logger ?? console;

  return async function conversationTurnInputShadow(req, _res, next) {
    const startedAt = performance.now();
    try {
      if (req.method && req.method !== 'POST') return;
      const body = asRecord(req.body);
      const metaMessage = findFirstMetaMessage(body);
      const hasMetaEnvelope = body.object === 'whatsapp_business_account' || hasOwn(body, 'entry');

      if (hasMetaEnvelope) {
        if (!Array.isArray(body.entry)
          || Object.keys(metaMessage).length === 0
          || !isRecruitmentWhatsappPayload(body)
          || isSupervisorPhone(metaMessage.from)) return;
      }

      req.conversationTurnInput = await buildValidatedConversationTurnInput({
        turn: asRecord(body.turn),
        rawMessage: Object.keys(metaMessage).length ? metaMessage : asRecord(body.message),
        rawText: body.rawText ?? body.text ?? body.content,
        candidate: asRecord(body.candidate),
        history: asRecord(body.history),
        pending: asRecord(body.pending),
        interpretation: asRecord(body.interpretation),
        execution: { mayReply: true, dryRun: true }
      });

      logger.debug?.({
        event: 'conversation_turn_input.shadow_valid',
        turnRef: hashTurnReference(req.conversationTurnInput.turn.id),
        latencyMs: Number((performance.now() - startedAt).toFixed(3))
      }, 'Conversation input shadow validation succeeded');
    } catch (error) {
      try {
        logger.error?.({
          event: error?.name === 'ConversationTurnInputValidationError'
            ? 'conversation_turn_input.shadow_invalid'
            : 'conversation_turn_input.shadow_error',
          latencyMs: Number((performance.now() - startedAt).toFixed(3)),
          issues: error?.issues?.map((issue) => ({ code: issue.code, path: issue.path })) || undefined,
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error)
        }, 'Conversation input shadow processing failed');
      } catch {
        // Shadow telemetry must never interrupt the legacy request path.
      }
    } finally {
      next();
    }
  };
}

export default buildConversationTurnInput;
