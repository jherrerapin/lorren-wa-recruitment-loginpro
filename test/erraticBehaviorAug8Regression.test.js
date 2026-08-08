import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidateFields, parseNaturalData } from '../src/services/candidateData.js';
import { VacancyFirstGateAction, resolveVacancyFirstGate } from '../src/services/vacancyFirstGate.js';

const vacancy = {
  id: 'vac-neiva', title: 'Líder de Operación', role: 'Líder de Operación',
  roleDescription: 'Liderar y administrar equipos de trabajo.',
  requirements: 'Experiencia mínima de 6 meses en operaciones logísticas y manejo de personal.',
  conditions: 'Salario a convenir. Turnos rotativos.', operationAddress: 'Sector Las Brisas',
  city: 'Neiva', isActive: true, acceptingApplications: true,
  operation: { id: 'op-neiva', name: 'Operación Isimo Neiva', city: { id: 'city-neiva', name: 'Neiva' } }
};

function candidate(overrides = {}) {
  return {
    id: 'cand-aug8', status: 'NUEVO', currentStep: 'GREETING_SENT', vacancyId: vacancy.id, vacancy,
    botPaused: false, botResumeMode: 'awaiting_application_interest', reminderState: 'SKIPPED',
    reminderScheduledFor: null, dataConsentStatus: 'PENDING', ...overrides
  };
}

test('confirmar interés nunca pide datos antes del consentimiento', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null, candidate: candidate(), currentVacancy: vacancy, currentStep: 'GREETING_SENT',
    inboundText: 'Si deseo postularme a la vacante', recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.replyKind, 'DATA_CONSENT_PROMPT');
  assert.match(decision.reply, /autorización|autorizo/i);
  assert.doesNotMatch(decision.reply, /compárteme nombre|numero de documento|edad, el barrio|restricciones medicas/i);
});

test('pregunta sobre tipo de operación se responde antes de reinterpretar la vacante', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null, candidate: candidate(), currentVacancy: vacancy, currentStep: 'GREETING_SENT',
    inboundText: 'Pero que tipo de operación es?', recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.replyKind, 'VACANCY_INFORMATION_ANSWER');
  assert.match(decision.reply, /Operación Isimo Neiva/i);
  assert.doesNotMatch(decision.reply, /ya es la que tienes asociada/i);
});

test('consulta comercial no entra al flujo de candidato ni solicita hoja de vida', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate({ currentStep: 'MENU', vacancyId: null, vacancy: null, botResumeMode: null }),
    currentVacancy: null, currentStep: 'MENU',
    inboundText: 'Soy Miguel y tengo una empresa de última milla y descargue; operamos en Huila, Caquetá y Putumayo',
    recentMessages: [], vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.replyKind, 'COMMERCIAL_INQUIRY_BOUNDARY');
  assert.match(decision.reply, /propuesta comercial/i);
  assert.doesNotMatch(decision.reply, /compárteme|hoja de vida como archivo|postulación aún/i);
});

test('bloque corto conserva edad, restricción y más de cuatro años de experiencia', () => {
  const normalized = normalizeCandidateFields(parseNaturalData('28, no tengo restricción médica, sí, más de 4 años'));
  assert.equal(normalized.age, 28);
  assert.equal(normalized.medicalRestrictions, 'Sin restricciones médicas');
  assert.equal(normalized.experienceInfo, 'Sí');
  assert.equal(normalized.experienceTime, '4 años');
});

test('cuatro años nunca se normaliza como tres años', () => {
  const normalized = normalizeCandidateFields(parseNaturalData('Tengo cuatro años de experiencia en logística'));
  assert.equal(normalized.experienceTime, '4 años');
});
