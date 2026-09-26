import { ConversationDecisionSchema } from '../contracts/ConversationDecisionSchema.js';
import { candidateDataPolicy } from './policies/candidateDataPolicy.js';
import { vacancyAssignmentPolicy } from './policies/vacancyAssignmentPolicy.js';
import { eligibilityPolicy } from './policies/eligibilityPolicy.js';
import { chatPolicy } from './policies/chatPolicy.js';
import { schedulingPolicy } from './policies/schedulingPolicy.js';
import { progressionPolicy } from './policies/progressionPolicy.js';
import { attachmentPolicy } from './policies/attachmentPolicy.js';
import { consentPolicy } from './policies/consentPolicy.js';
import { vacancyPolicy } from './policies/vacancyPolicy.js';

const DEFAULT_TERMINAL_STATUS = 'REGISTRADO';

/**
 * Policy order encodes precedence without coupling policies to one another.
 *
 * 1. Candidate data and vacancy assignment assimilate objective facts.
 * 2. Eligibility can terminate the process before any progression/scheduling.
 * 3. Generic chat and scheduling contribute ordinary turn behavior.
 * 4. Progression guards readiness and may clear premature scheduling.
 * 5. Attachment guidance overrides a generic CV request with format-specific
 *    feedback for the current attachment.
 * 6. Consent and vacancy FAQ retain final specialized reply precedence.
 */
export const conversationPolicies = Object.freeze([
  candidateDataPolicy,
  vacancyAssignmentPolicy,
  eligibilityPolicy,
  chatPolicy,
  schedulingPolicy,
  progressionPolicy,
  attachmentPolicy,
  consentPolicy,
  vacancyPolicy
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

/**
 * Deterministic deep merge for decision fragments.
 * Objects merge recursively, arrays replace, undefined never overwrites and
 * later scalar values have higher precedence.
 */
export function mergeDecisionObjects(current = {}, fragment = {}) {
  const merged = { ...current };

  for (const [key, incomingValue] of Object.entries(fragment)) {
    if (incomingValue === undefined) continue;

    const currentValue = merged[key];
    if (isPlainObject(currentValue) && isPlainObject(incomingValue)) {
      merged[key] = mergeDecisionObjects(currentValue, incomingValue);
      continue;
    }

    if (Array.isArray(incomingValue)) {
      merged[key] = [...incomingValue];
      continue;
    }

    merged[key] = incomingValue;
  }

  return merged;
}

/**
 * Cross-domain invariants belong to the orchestrator, never to one policy.
 *
 * A terminal transition:
 * - invalidates every scheduling effect in the same turn;
 * - guarantees a persisted terminal status when no policy supplied one.
 *
 * Explicit policy status always wins, so a dedicated rejection policy can
 * preserve a different status without being overwritten here.
 */
export function enforceDecisionInvariants(decision = {}) {
  const normalized = { ...decision };

  if (normalized?.transitions?.endConversation === true) {
    delete normalized.scheduling;

    const mutations = isPlainObject(normalized.mutations)
      ? normalized.mutations
      : {};
    const currentFields = isPlainObject(mutations.fieldsToPersist)
      ? mutations.fieldsToPersist
      : {};
    const fieldsToPersist = { ...currentFields };

    if (!Object.prototype.hasOwnProperty.call(fieldsToPersist, 'status') || !fieldsToPersist.status) {
      fieldsToPersist.status = DEFAULT_TERMINAL_STATUS;
    }

    normalized.mutations = {
      ...mutations,
      fieldsToPersist
    };
  }

  return normalized;
}

export function reduceConversationDecision(accumulated, fragment) {
  if (fragment == null) return enforceDecisionInvariants(accumulated);

  if (!isPlainObject(fragment)) {
    throw new TypeError('Conversation policy must return a decision fragment object.');
  }

  return enforceDecisionInvariants(
    mergeDecisionObjects(accumulated, fragment)
  );
}

/**
 * Pure asynchronous orchestrator for one validated ConversationTurnInput.
 * It performs no persistence, transport, HTTP, filesystem or provider I/O.
 *
 * Terminal decisions stop further policy evaluation so later generic or
 * specialized replies cannot overwrite a completed/rejected turn.
 *
 * @param {import('../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<import('../contracts/ConversationDecisionSchema.js').ConversationDecision>}
 */
export async function calculateConversationDecision(input) {
  let decision = {};

  for (const policy of conversationPolicies) {
    if (typeof policy !== 'function') {
      throw new TypeError('Conversation policy must be a function.');
    }

    const fragment = await policy(input);
    decision = reduceConversationDecision(decision, fragment);

    if (decision?.transitions?.endConversation === true) {
      break;
    }
  }

  const validation = await ConversationDecisionSchema.safeParseAsync(decision);

  if (!validation.success) {
    const error = new Error('Invalid ConversationDecision produced by functional core.');
    error.name = 'ConversationDecisionValidationError';
    error.cause = validation.error;
    throw error;
  }

  return validation.data;
}

export default calculateConversationDecision;
