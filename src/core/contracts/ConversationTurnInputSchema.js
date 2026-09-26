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

/** Canonical scheduling slot understood by the functional core. */
export const SchedulingSlotSchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  timezone: z.string().trim().min(1)
}).strict().readonly();

export const VacancyCitySchema = z.object({
  name: z.string().trim().min(1).nullable().default(null)
}).strict().readonly();

export const VacancyOperationSchema = z.object({
  name: z.string().trim().min(1).nullable().default(null),
  city: VacancyCitySchema.nullable().default(null)
}).strict().readonly();

/**
 * Read-only vacancy snapshot supplied by the imperative shell.
 * Only facts required by pure policies cross the functional-core boundary.
 */
export const VacancySchema = z.object({
  id: z.string().trim().min(1).nullable().default(null),
  title: z.string().trim().min(1).nullable().default(null),
  role: z.string().trim().min(1).nullable().default(null),
  city: z.string().trim().min(1).nullable().default(null),
  schedulingEnabled: z.boolean().nullable().default(null),
  interviewSchedulingEnabled: z.boolean().nullable().default(null),
  requirements: z.string().nullable().default(null),
  conditions: z.string().nullable().default(null),
  roleDescription: z.string().nullable().default(null),
  requiredDocuments: z.string().nullable().default(null),
  operationAddress: z.string().nullable().default(null),
  minAge: z.number().int().nullable().default(null),
  maxAge: z.number().int().nullable().default(null),
  experienceRequired: z.enum(['YES', 'NO']).nullable().default(null),
  experienceTimeText: z.string().nullable().default(null),
  operation: VacancyOperationSchema.nullable().default(null)
}).strict().readonly();

export const InterpretationSchedulingSchema = z.object({
  slot: SchedulingSlotSchema.nullable().default(null)
}).strict().readonly();

export const InterpretationConsentSchema = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED', 'REVOKED', 'PENDING']).nullable().default(null)
}).strict().readonly();

/**
 * Semantic interpretation already resolved upstream. The functional core does
 * not call models or external classifiers; it only consumes this evidence.
 */
export const InterpretationSchema = z.object({
  intent: z.string().trim().min(1).nullable().default(null),
  scheduling: InterpretationSchedulingSchema.default({ slot: null }),
  consent: InterpretationConsentSchema.default({ decision: null })
}).strict().readonly();

/**
 * Sole input contract for the functional conversation core. Transport details
 * and tenant/account identifiers intentionally remain outside this boundary.
 *
 * `vacancy` and `interpretation` have safe defaults so the existing fail-open
 * shadow middleware can continue validating legacy turns while enrichment is
 * migrated into the imperative shell.
 */
export const ConversationTurnInputSchema = z.object({
  turn: TurnSchema,
  candidate: CandidateSchema,
  history: HistorySchema,
  pending: PendingSchema,
  execution: ExecutionSchema,
  vacancy: VacancySchema.nullable().default(null),
  interpretation: InterpretationSchema.default({
    intent: null,
    scheduling: { slot: null },
    consent: { decision: null }
  })
}).strict().readonly();

/** @typedef {z.infer<typeof ConversationTurnInputSchema>} ConversationTurnInput */

export default ConversationTurnInputSchema;
