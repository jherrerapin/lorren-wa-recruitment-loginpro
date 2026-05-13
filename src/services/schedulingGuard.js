import { getCandidateReadiness } from './readinessGuard.js';

const BLOCKED_STATUSES = new Set(['RECHAZADO', 'PAUSADO', 'NO_INTERESADO']);

export function evaluateSchedulingGuard({ candidate = {}, vacancy = null, nextSlot = null, actionType = '', acceptedOfferedSlot = true } = {}) {
  const readiness = getCandidateReadiness(candidate, vacancy);
  const reasons = [];

  if (readiness.missingFields.length) reasons.push(`missing_fields:${readiness.missingFields.join(',')}`);
  if (!readiness.hasValidCv) reasons.push('missing_cv');
  if (!candidate.vacancyId && !vacancy?.id) reasons.push('missing_vacancy');
  if (!vacancy?.schedulingEnabled) reasons.push('scheduling_disabled');
  if (vacancy && vacancy.isActive !== true) reasons.push('vacancy_inactive');
  if (vacancy && vacancy.acceptingApplications !== true) reasons.push('vacancy_not_accepting_applications');
  if (!nextSlot?.slot) reasons.push('missing_valid_slot');
  if (candidate.gender === 'FEMALE') reasons.push('female_candidate');
  if (candidate.status && BLOCKED_STATUSES.has(String(candidate.status))) reasons.push(`blocked_status:${candidate.status}`);
  if (actionType === 'confirm_booking' && !acceptedOfferedSlot) reasons.push('candidate_did_not_accept_offered_slot');

  return {
    allowed: reasons.length === 0,
    reasons,
    primaryReason: reasons[0] || null,
    readiness
  };
}
