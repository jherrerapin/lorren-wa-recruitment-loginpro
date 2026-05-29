import { getCandidateReadiness, hasValidCv } from './readinessGuard.js';

export const FlowDeciderAction = Object.freeze({
  IDENTIFY_VACANCY: 'IDENTIFY_VACANCY',
  PRESENT_VACANCY: 'PRESENT_VACANCY',
  COLLECT_DATA: 'COLLECT_DATA',
  REQUEST_CV: 'REQUEST_CV',
  SCHEDULE_INTERVIEW: 'SCHEDULE_INTERVIEW',
  CONFIRM_RECEIPT: 'CONFIRM_RECEIPT',
  SAVE_PROFILE: 'SAVE_PROFILE',
  ANSWER_FROM_VACANCY: 'ANSWER_FROM_VACANCY',
  ESCALATE_TO_ADMIN: 'ESCALATE_TO_ADMIN'
});

const VACANCY_QUESTION_INTENTS = new Set([
  'VACANCY_QUESTION',
  'ASK_VACANCY',
  'ASK_ABOUT_VACANCY',
  'QUESTION_ABOUT_VACANCY'
]);

const ADMIN_ESCALATION_INTENTS = new Set([
  'UNKNOWN',
  'UNSUPPORTED',
  'ADMIN_ESCALATION',
  'NEEDS_ADMIN',
  'CANNOT_ANSWER'
]);

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function getAssignedVacancyId(candidateState = {}) {
  return candidateState.vacancyId
    || candidateState.assignedVacancyId
    || candidateState.currentVacancyId
    || null;
}

function hasConfirmedInterest(candidateState = {}) {
  return Boolean(
    candidateState.interestConfirmed
      || candidateState.hasConfirmedInterest
      || candidateState.confirmedInterest
      || candidateState.vacancyInterestConfirmed
  );
}

function getConfiguredFields(vacancyConfig = {}) {
  return vacancyConfig.requiredCandidateFields
    || vacancyConfig.requiredFields
    || vacancyConfig.dataFields
    || vacancyConfig.fieldsToCollect
    || null;
}

function getMissingConfiguredFields(candidateState = {}, vacancyConfig = {}) {
  if (Array.isArray(candidateState.missingFields)) return candidateState.missingFields;
  if (Array.isArray(candidateState.missingDataFields)) return candidateState.missingDataFields;
  if (candidateState.readiness && Array.isArray(candidateState.readiness.missingFields)) {
    return candidateState.readiness.missingFields;
  }

  const configuredFields = getConfiguredFields(vacancyConfig);
  if (Array.isArray(configuredFields)) {
    const data = candidateState.data || candidateState.profile || candidateState;
    return configuredFields.filter((field) => !hasValue(data?.[field]));
  }

  return getCandidateReadiness(candidateState, vacancyConfig, { requireCv: false }).missingFields;
}

function hasCandidateCv(candidateState = {}) {
  if (candidateState.hasCv !== undefined) return Boolean(candidateState.hasCv);
  if (candidateState.hasCV !== undefined) return Boolean(candidateState.hasCV);
  if (candidateState.cvReceived !== undefined) return Boolean(candidateState.cvReceived);
  return Boolean(candidateState.cvUrl || candidateState.cvFileId || hasValidCv(candidateState));
}

function vacancyIsInactive(vacancyConfig = {}) {
  return vacancyConfig.isActive === false
    || vacancyConfig.acceptingApplications === false
    || String(vacancyConfig.status || '').toUpperCase() === 'INACTIVE';
}

function vacancyHasInterviews(vacancyConfig = {}) {
  return Boolean(
    vacancyConfig.hasInterviews
      || vacancyConfig.interviewsEnabled
      || vacancyConfig.requiresInterview
      || vacancyConfig.interviewConfig?.enabled
      || vacancyConfig.interview?.enabled
  );
}

function getIntent(incomingMessage = {}) {
  return incomingMessage.intent
    || incomingMessage.processedIntent
    || incomingMessage.classification?.intent
    || null;
}

function buildDecision(action, payload = null) {
  return { action, payload };
}

export function decideNextAction(candidateState = {}, vacancyConfig = {}, incomingMessage = {}) {
  const assignedVacancyId = getAssignedVacancyId(candidateState);
  if (!assignedVacancyId) return buildDecision(FlowDeciderAction.IDENTIFY_VACANCY);

  if (!hasConfirmedInterest(candidateState)) return buildDecision(FlowDeciderAction.PRESENT_VACANCY);

  const missingFields = getMissingConfiguredFields(candidateState, vacancyConfig);
  if (missingFields.length > 0) return buildDecision(FlowDeciderAction.COLLECT_DATA, missingFields);

  if (!hasCandidateCv(candidateState)) return buildDecision(FlowDeciderAction.REQUEST_CV);

  if (vacancyIsInactive(vacancyConfig)) return buildDecision(FlowDeciderAction.SAVE_PROFILE);

  if (vacancyHasInterviews(vacancyConfig)) return buildDecision(FlowDeciderAction.SCHEDULE_INTERVIEW);

  if (vacancyConfig.hasInterviews === false || vacancyConfig.interviewsEnabled === false || vacancyConfig.requiresInterview === false) {
    return buildDecision(FlowDeciderAction.CONFIRM_RECEIPT);
  }

  const intent = getIntent(incomingMessage);
  if (VACANCY_QUESTION_INTENTS.has(intent)) return buildDecision(FlowDeciderAction.ANSWER_FROM_VACANCY);
  if (ADMIN_ESCALATION_INTENTS.has(intent)) return buildDecision(FlowDeciderAction.ESCALATE_TO_ADMIN);

  return buildDecision(FlowDeciderAction.ESCALATE_TO_ADMIN);
}
