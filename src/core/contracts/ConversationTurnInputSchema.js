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
  experienceRequired: z.enum(['YES', 'NO', 'INDIFFERENT']).nullable().default(null),
  experienceTimeText: z.string().nullable().default(null),
  operation: VacancyOperationSchema.nullable().default(null)
}).strict().readonly();

/**
 * Immutable attachment evidence for the current turn. Provider-specific raw
 * payloads stay outside the Functional Core; only normalized facts cross the
 * boundary. `isCv` is evidence produced by the shell, never inferred here.
 */
export const AttachmentItemSchema = z.object({
  type: z.enum(['document', 'image', 'audio', 'video', 'sticker', 'unknown']).default('unknown'),
  mediaId: z.string().trim().min(1).nullable().default(null),
  fileName: z.string().nullable().default(null),
  mimeType: z.string().trim().min(1).nullable().default(null),
  caption: z.string().nullable().default(null),
  isCv: z.boolean().default(false)
}).strict().readonly();

export const AttachmentsSchema = z.object({
  items: z.array(AttachmentItemSchema).readonly().default([]),
  hasCv: z.boolean().default(false)
}).strict().readonly();

export const InterpretationSchedulingSchema = z.object({
  slot: SchedulingSlotSchema.nullable().default(null)
}).strict().readonly();

export const InterpretationConsentSchema = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED', 'REVOKED', 'PENDING']).nullable().default(null)
}).strict().readonly();

/**
 * Candidate entities extracted from the current turn. The shape is explicit
 * and strict so unknown semantic fields cannot silently enter persistence.
 * Business validation remains the responsibility of pure policies/guards.
 */
export const InterpretationCandidateFieldsSchema = z.object({
  fullName: z.string().trim().min(1).nullable().optional(),
  documentType: z.string().trim().min(1).nullable().optional(),
  documentNumber: z.string().trim().min(1).nullable().optional(),
  age: z.number().int().nullable().optional(),
  gender: z.string().trim().min(1).nullable().optional(),
  neighborhood: z.string().trim().min(1).nullable().optional(),
  locality: z.string().trim().min(1).nullable().optional(),
  medicalRestrictions: z.string().trim().min(1).nullable().optional(),
  transportMode: z.string().trim().min(1).nullable().optional(),
  experienceInfo: z.string().trim().min(1).nullable().optional(),
  experienceTime: z.string().trim().min(1).nullable().optional(),
  experienceSummary: z.string().trim().min(1).nullable().optional()
}).strict().readonly();

/**
 * Semantic interpretation already resolved upstream. The functional core does
 * not call models or external classifiers; it only consumes this evidence.
 */
export const InterpretationSchema = z.object({
  intent: z.string().trim().min(1).nullable().default(null),
  fields: InterpretationCandidateFieldsSchema.default({}),
  scheduling: InterpretationSchedulingSchema.default({ slot: null }),
  consent: InterpretationConsentSchema.default({ decision: null })
}).strict().readonly();

/**
 * Sole input contract for the functional conversation core. Transport details
 * and tenant/account identifiers intentionally remain outside this boundary.
 *
 * `vacancy`, `attachments` and `interpretation` have safe defaults so the
 * existing fail-open shadow middleware can continue validating legacy turns
 * while enrichment is migrated into the imperative shell.
 */
export const ConversationTurnInputSchema = z.object({
  turn: TurnSchema,
  candidate: CandidateSchema,
  history: HistorySchema,
  pending: PendingSchema,
  execution: ExecutionSchema,
  vacancy: VacancySchema.nullable().default(null),
  attachments: AttachmentsSchema.default({
    items: [],
    hasCv: false
  }),
  interpretation: InterpretationSchema.default({
    intent: null,
    fields: {},
    scheduling: { slot: null },
    consent: { decision: null }
  })
}).strict().readonly();

/** @typedef {z.infer<typeof ConversationTurnInputSchema>} ConversationTurnInput */

export default ConversationTurnInputSchema;
