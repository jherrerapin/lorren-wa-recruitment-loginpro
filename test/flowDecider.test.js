import test from 'node:test';
import assert from 'node:assert/strict';
import { decideNextAction, FlowDeciderAction } from '../src/services/flowDecider.js';

const baseCandidate = Object.freeze({
  id: 'candidate-1',
  vacancyId: 'vacancy-1',
  interestConfirmed: true,
  fullName: 'Ana Perez',
  documentType: 'CC',
  documentNumber: '123',
  age: 28,
  locality: 'Chapinero',
  medicalRestrictions: 'No',
  transportMode: 'Transmilenio',
  hasCv: true
});

const baseVacancy = Object.freeze({
  id: 'vacancy-1',
  isActive: true,
  acceptingApplications: true,
  requiredCandidateFields: ['fullName', 'documentType'],
  hasInterviews: true
});

function decide(candidatePatch = {}, vacancyPatch = {}, messagePatch = {}) {
  return decideNextAction(
    { ...baseCandidate, ...candidatePatch },
    { ...baseVacancy, ...vacancyPatch },
    { intent: 'READY_TO_CONTINUE', ...messagePatch }
  );
}

test('returns IDENTIFY_VACANCY when candidate has no assigned vacancyId', () => {
  const decision = decide({ vacancyId: null });

  assert.deepEqual(decision, { action: FlowDeciderAction.IDENTIFY_VACANCY, payload: null });
});

test('returns PRESENT_VACANCY when vacancy is identified but interest is not confirmed', () => {
  const decision = decide({ interestConfirmed: false });

  assert.deepEqual(decision, { action: FlowDeciderAction.PRESENT_VACANCY, payload: null });
});

test('returns COLLECT_DATA with configured missing fields after interest is confirmed', () => {
  const decision = decide({ documentType: '' }, { requiredCandidateFields: ['fullName', 'documentType', 'age'] });

  assert.deepEqual(decision, { action: FlowDeciderAction.COLLECT_DATA, payload: ['documentType'] });
});

test('returns REQUEST_CV when configured data is complete and CV is missing', () => {
  const decision = decide({ hasCv: false, cvStorageKey: null, cvData: null });

  assert.deepEqual(decision, { action: FlowDeciderAction.REQUEST_CV, payload: null });
});

test('returns SCHEDULE_INTERVIEW when everything is complete and vacancy has interviews', () => {
  const decision = decide();

  assert.deepEqual(decision, { action: FlowDeciderAction.SCHEDULE_INTERVIEW, payload: null });
});

test('returns CONFIRM_RECEIPT when everything is complete and active vacancy has no interviews', () => {
  const decision = decide({}, { hasInterviews: false });

  assert.deepEqual(decision, { action: FlowDeciderAction.CONFIRM_RECEIPT, payload: null });
});

test('returns SAVE_PROFILE when everything is complete but vacancy is inactive', () => {
  const decision = decide({}, { isActive: false, acceptingApplications: false, hasInterviews: false });

  assert.deepEqual(decision, { action: FlowDeciderAction.SAVE_PROFILE, payload: null });
});

test('returns ANSWER_FROM_VACANCY for a processed vacancy-question intent after required flow is complete', () => {
  const decision = decide({}, { hasInterviews: null }, { intent: 'VACANCY_QUESTION', text: '¿Cuál es el horario?' });

  assert.deepEqual(decision, { action: FlowDeciderAction.ANSWER_FROM_VACANCY, payload: null });
});

test('returns ESCALATE_TO_ADMIN when processed intent indicates Lorren cannot answer', () => {
  const decision = decide({}, { hasInterviews: null }, { intent: 'CANNOT_ANSWER', text: 'Necesito algo especial' });

  assert.deepEqual(decision, { action: FlowDeciderAction.ESCALATE_TO_ADMIN, payload: null });
});

test('does not infer vacancy questions from incoming text without processed intent', () => {
  const decision = decide({}, { hasInterviews: null }, { intent: 'UNKNOWN', text: '¿Cuál es el salario de la vacante?' });

  assert.deepEqual(decision, { action: FlowDeciderAction.ESCALATE_TO_ADMIN, payload: null });
});
