import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ConversationTurnInputSchema } from '../contracts/ConversationTurnInputSchema.js';
import { isRecruitmentWhatsappPayload } from '../../services/whatsapp.js';
import { isSupervisorPhone } from '../../services/adminSupervisor.js';

/** @typedef {import('express').Request} Request */
/** @typedef {import('express').Response} Response */
/** @typedef {import('express').NextFunction} NextFunction */
/** @typedef {import('../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} ConversationTurnInput */

/**
 * @typedef {object} BuildConversationTurnInputOptions
 * @property {{ debug?: Function, error?: Function }} [logger]
 */

/** @param {unknown} value */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** @param {Record<string, unknown>} body */
function findFirstMetaMessage(body) {
  const entries = Array.isArray(body.entry) ? body.entry : [];

  for (const entryValue of entries) {
    const entry = asRecord(entryValue);
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const changeValue of changes) {
      const change = asRecord(changeValue);
      const value = asRecord(change.value);
      const messages = Array.isArray(value.messages) ? value.messages : [];
      if (messages.length > 0) return asRecord(messages[0]);
    }
  }

  return {};
}

/** Preserve the textual evidence exposed by each supported Meta message type. */
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

/** Convert Meta's epoch timestamp to the ISO timestamp required by the core. */
function normalizeReceivedAt(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();

  if ((typeof value === 'string' && /^\d{10,13}$/.test(value)) || typeof value === 'number') {
    const numericValue = Number(value);
    const milliseconds = numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  return value;
}

/**
 * Build a fail-open shadow observer. Validation and logging failures always end
 * at `next()` and therefore cannot block the existing webhook controller.
 *
 * @param {BuildConversationTurnInputOptions} [options]
 * @returns {(req: Request & { conversationTurnInput?: ConversationTurnInput }, res: Response, next: NextFunction) => Promise<void>}
 */
export function buildConversationTurnInput(options = {}) {
  const logger = options.logger ?? console;

  return async function conversationTurnInputShadow(req, _res, next) {
    const startedAt = performance.now();

    try {
      const body = asRecord(req.body);
      const directMessage = asRecord(body.message);
      const metaMessage = findFirstMetaMessage(body);
      const isMetaWebhook = Array.isArray(body.entry);

      // Status callbacks and traffic owned by another WhatsApp flow are not
      // candidate conversation turns. Keep the shadow observer aligned with
      // the same deterministic guards used by the legacy controller.
      if (isMetaWebhook && (
        Object.keys(metaMessage).length === 0
        || !isRecruitmentWhatsappPayload(body)
        || isSupervisorPhone(metaMessage.from)
      )) return;

      const sourceTurn = asRecord(body.turn);
      const sourceCandidate = asRecord(body.candidate);
      const sourceHistory = asRecord(body.history);
      const sourcePending = asRecord(body.pending);
      const rawText = sourceTurn.rawText
        ?? (Object.keys(metaMessage).length > 0 ? extractMetaRawText(metaMessage) : undefined)
        ?? directMessage.rawText
        ?? directMessage.content
        ?? body.rawText
        ?? body.text
        ?? body.content
        ?? '';

      const input = {
        turn: {
          id: sourceTurn.id ?? metaMessage.id ?? body.turnId ?? directMessage.id ?? randomUUID(),
          receivedAt: normalizeReceivedAt(
            sourceTurn.receivedAt ?? metaMessage.timestamp ?? directMessage.timestamp ?? body.timestamp
          ),
          rawText
        },
        candidate: {
          id: sourceCandidate.id ?? null,
          facts: sourceCandidate.facts ?? {},
          updatedAt: sourceCandidate.updatedAt ?? null
        },
        history: {
          messages: sourceHistory.messages ?? [],
          lastBotQuestion: sourceHistory.lastBotQuestion ?? null
        },
        pending: {
          fields: sourcePending.fields ?? [],
          actions: sourcePending.actions ?? []
        },
        execution: {
          mayReply: true,
          dryRun: true
        }
      };

      const result = await ConversationTurnInputSchema.safeParseAsync(input);
      const latencyMs = Number((performance.now() - startedAt).toFixed(3));

      if (result.success) {
        req.conversationTurnInput = result.data;
        logger.debug?.({
          event: 'conversation_turn_input.shadow_valid',
          turnId: result.data.turn.id,
          latencyMs
        }, 'Conversation input shadow validation succeeded');
      } else {
        logger.error?.({
          event: 'conversation_turn_input.shadow_invalid',
          latencyMs,
          issues: result.error.flatten()
        }, 'Conversation input shadow validation failed');
      }
    } catch (error) {
      const latencyMs = Number((performance.now() - startedAt).toFixed(3));
      try {
        logger.error?.({
          event: 'conversation_turn_input.shadow_error',
          latencyMs,
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error)
        }, 'Conversation input shadow processing failed');
      } catch {
        // Logging must never interrupt the legacy request path.
      }
    } finally {
      next();
    }
  };
}

export default buildConversationTurnInput;
