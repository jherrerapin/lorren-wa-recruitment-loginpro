import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVacancyFirstGate, VacancyFirstGateAction } from '../src/services/vacancyFirstGate.js';

const bogotaOperation = {
  id: 'op-bogota-residence-context',
  name: 'Operacion Bogota',
  city: { id: 'city-bogota-residence-context', name: 'Bogota' }
};

const activeSiberiaVacancy = {
  id: 'vac-siberia-residence-context',
  title: 'Auxiliar de Bodega Siberia',
  role: 'Auxiliar de bodega',
  city: 'Bogota',
  operation: bogotaOperation,
  operationAddress: 'Parque industrial Siberia',
  roleDescription: 'Apoyo operativo de bodega',
  requirements: 'Disponibilidad para la operación',
  conditions: 'Turnos según programación',
  isActive: true,
  acceptingApplications: true
};

function candidate(overrides = {}) {
  return {
    id: 'candidate-residence-context',
    status: 'NUEVO',
    currentStep: 'GREETING_SENT',
    vacancyId: null,
    botResumeMode: null,
    dataConsentStatus: 'PENDING',
    fullName: null,
    documentType: null,
    documentNumber: null,
    age: null,
    gender: 'UNKNOWN',
    neighborhood: null,
    locality: null,
    medicalRestrictions: null,
    transportMode: null,
    experienceInfo: null,
    experienceTime: null,
    cvData: null,
    cvOriginalName: null,
    ...overrides
  };
}

test('la compuerta reconoce residencia en Madrid y pregunta solo por la vacante faltante', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate(),
    currentVacancy: null,
    inboundText: 'Soy de Madrid',
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: {
      activeVacancies: [activeSiberiaVacancy],
      allVacancies: [activeSiberiaVacancy]
    }
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'RESIDENCE_CAPTURED_VACANCY_NEEDED');
  assert.equal(decision.replyKind, 'ASK_VACANCY_ROLE');
  assert.match(decision.reply, /para qu[eé] vacante o cargo/i);
  assert.doesNotMatch(decision.reply, /desde qu[eé] ciudad/i);
  assert.doesNotMatch(decision.reply, /no tengo vacantes activas/i);
  assert.equal(decision.resolution.residenceLocation, 'madrid');
  assert.equal(decision.resolution.city, null);
});

test('la compuerta no confunde residencia en Soacha con ausencia de vacantes cuando el cargo identifica Siberia', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate(),
    currentVacancy: null,
    inboundText: 'Soy de Soacha y me interesa auxiliar de bodega',
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: {
      activeVacancies: [activeSiberiaVacancy],
      allVacancies: [activeSiberiaVacancy]
    }
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ACTIVE_VACANCY_RESOLVED_AWAIT_CONSENT');
  assert.equal(decision.vacancyId, activeSiberiaVacancy.id);
  assert.equal(decision.resolution.residenceLocation, 'Soacha');
  assert.doesNotMatch(decision.reply, /no tengo vacantes activas en Soacha/i);
});
