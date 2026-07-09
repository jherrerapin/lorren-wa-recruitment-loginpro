import { CandidateStatus } from '@prisma/client';
import { getCandidateReadiness } from './readinessGuard.js';
import { isSubstantiallySimilarReply, normalizeReplySignature, ReplySimilarityThreshold } from './replySimilarityPolicy.js';

export function buildRequirementRejectionDecision({ candidate = {}, vacancy = null } = {}) {
  const readiness = getCandidateReadiness(candidate, vacancy);
  const failure = readiness.eligibilityFailures?.[0] || null;
  if (!failure) {
    return { allowed: false, reason: 'missing_requirement_evidence', failure: null };
  }

  const reason = failure.message || failure.label || 'No cumple un requisito de la vacante';
  const details = [
    failure.code || failure.reason || failure.field || 'requirement_failed',
    failure.details || null
  ].filter(Boolean).join(': ');

  return {
    allowed: true,
    reason,
    details,
    failure,
    evidence: {
      field: failure.field || null,
      code: failure.code || failure.reason || null,
      candidateValue: failure.candidateAge ?? null,
      requirement: {
        minAge: failure.minAge ?? null,
        maxAge: failure.maxAge ?? null
      }
    }
  };
}

function hasRejectionAction(actions = []) {
  return (actions || []).some((action) => action?.type === 'mark_rejected');
}

function removeRejectionActions(actions = []) {
  return (actions || []).filter((action) => action?.type !== 'mark_rejected');
}

function hasRecentSimilarRejectionReply(reply = '', recentMessages = []) {
  const normalizedReply = normalizeReplySignature(reply);
  if (!normalizedReply) return false;
  return (recentMessages || [])
    .filter((message) => message?.direction === 'OUTBOUND')
    .slice(-5)
    .some((message) => {
      const body = message?.body || '';
      return normalizeReplySignature(body) === normalizedReply
        || isSubstantiallySimilarReply(reply, body, { threshold: ReplySimilarityThreshold.LOOP_GUARD });
    });
}

export function applyRejectionMemoryPolicy(decision = {}, context = {}) {
  if (context?.candidate?.status !== CandidateStatus.RECHAZADO) {
    return { ...decision, rejectionMemoryApplied: false };
  }

  if (!hasRejectionAction(decision.actions)) {
    return { ...decision, rejectionMemoryApplied: false };
  }

  const actions = removeRejectionActions(decision.actions);
  const isQuestion = Boolean(context.isQuestionAnswer);
  const shouldRewrite = isQuestion || hasRecentSimilarRejectionReply(decision.reply, context.recentMessages);
  if (!shouldRewrite) {
    return { ...decision, actions, rejectionMemoryApplied: true };
  }

  return {
    ...decision,
    actions,
    reply: isQuestion
      ? 'Tu resultado sigue registrado por el requisito indicado. Si tienes una duda puntual sobre la vacante o sobre qué pasó, te respondo con lo que esté registrado.'
      : 'Ya quedó registrado el resultado de tu postulación. Si necesitas aclarar algo puntual, escríbeme la duda y la reviso contigo.',
    rejectionMemoryApplied: true
  };
}
