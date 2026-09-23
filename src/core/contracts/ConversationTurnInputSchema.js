import { z } from 'zod';

export const JsonValueSchema = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
);

/**
 * Evidence for the current turn. `rawText` is deliberately not trimmed,
 * normalized or transformed: the exact received text remains available.
 */
export const TurnSchema = z.object({
  id: z.string().trim().min(1),
  receivedAt: z.string().datetime({ offset: true }),
  rawText: z.string()
}).strict().readonly();

/** Consolidated candidate facts already known by the caller. */
export const CandidateSchema = z.object({
  id: z.string().trim().min(1).nullable(),
  facts: z.record(z.string().trim().min(1), JsonValueSchema),
  updatedAt: z.string().datetime({ offset: true }).nullable()
}).strict().readonly();

export const HistoryMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  occurredAt: z.string().datetime({ offset: true })
}).strict().readonly();

export const HistorySchema = z.object({
  messages: z.array(HistoryMessageSchema).readonly(),
  lastBotQuestion: z.string().nullable()
}).strict().readonly();

export const PendingActionSchema = z.object({
  type: z.string().trim().min(1),
  payload: z.record(z.string(), JsonValueSchema)
}).strict().readonly();

export const PendingSchema = z.object({
  fields: z.array(z.string().trim().min(1)).readonly(),
  actions: z.array(PendingActionSchema).readonly()
}).strict().readonly();

export const ExecutionSchema = z.object({
  mayReply: z.boolean(),
  dryRun: z.boolean()
}).strict().readonly();

/**
 * Sole input contract for the functional conversation core. Transport details
 * and tenant/account identifiers intentionally remain outside this boundary.
 */
export const ConversationTurnInputSchema = z.object({
  turn: TurnSchema,
  candidate: CandidateSchema,
  history: HistorySchema,
  pending: PendingSchema,
  execution: ExecutionSchema
}).strict().readonly();

/** @typedef {z.infer<typeof ConversationTurnInputSchema>} ConversationTurnInput */

export default ConversationTurnInputSchema;
