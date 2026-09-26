import { ConversationDecisionSchema } from '../contracts/ConversationDecisionSchema.js';
import { candidateDataPolicy } from './policies/candidateDataPolicy.js';
import { chatPolicy } from './policies/chatPolicy.js';
import { consentPolicy } from './policies/consentPolicy.js';
import { vacancyPolicy } from './policies/vacancyPolicy.js';
import { schedulingPolicy } from './policies/schedulingPolicy.js';

/**
 * Policy order encodes precedence without coupling policies to one another.
 * Candidate data is assimilated first so extracted facts survive regardless of
 * the conversational intent. The generic chat fallback runs next; domain-
 * specific consent and vacancy policies may replace its reply. Scheduling
 * contributes only declarative scheduling effects.
 */
export const conversationPolicies = Object.freeze([
  candidateDataPolicy,
  chatPolicy,
  consentPolicy,
  vacancyPolicy,
  schedulingPolicy
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
 * A terminal transition invalidates every scheduling effect in the same turn.
 */
export function enforceDecisionInvariants(decision = {}) {
  const normalized = { ...decision };

  if (normalized?.transitions?.endConversation === true) {
    delete normalized.scheduling;
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
