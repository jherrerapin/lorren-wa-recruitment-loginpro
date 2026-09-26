import { z } from 'zod';
import { JsonValueSchema, SchedulingSlotSchema } from './ConversationTurnInputSchema.js';

export const ConversationReplySchema = z.object({
  text: z.string().trim().min(1)
}).strict().readonly();

export const ConversationMutationsSchema = z.object({
  fieldsToPersist: z.record(z.string().trim().min(1), JsonValueSchema).default({})
}).strict().readonly();

export const ConversationTransitionsSchema = z.object({
  endConversation: z.boolean().default(false)
}).strict().readonly();

const SuggestSlotsSchedulingSchema = z.object({
  action: z.literal('suggest_slots')
}).strict().readonly();

const ReserveSlotSchedulingSchema = z.object({
  action: z.literal('reserve_slot'),
  slot: SchedulingSlotSchema
}).strict().readonly();

const CancelBookingSchedulingSchema = z.object({
  action: z.literal('cancel_booking')
}).strict().readonly();

export const ConversationSchedulingSchema = z.discriminatedUnion('action', [
  SuggestSlotsSchedulingSchema,
  ReserveSlotSchedulingSchema,
  CancelBookingSchedulingSchema
]);

/**
 * Canonical output of the functional conversation core.
 * Effects are declarative: the imperative shell owns persistence, scheduling,
 * transport delivery and all other external side effects.
 */
export const ConversationDecisionSchema = z.object({
  reply: ConversationReplySchema.nullable().default(null),
  mutations: ConversationMutationsSchema.default({ fieldsToPersist: {} }),
  transitions: ConversationTransitionsSchema.default({ endConversation: false }),
  scheduling: ConversationSchedulingSchema.nullable().default(null)
}).strict().readonly();

/** @typedef {z.infer<typeof ConversationDecisionSchema>} ConversationDecision */

export default ConversationDecisionSchema;
