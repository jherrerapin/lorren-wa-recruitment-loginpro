import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALTERNATIVE_VACANCY_OFFER_MODE,
  ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE,
  VacancyFirstGateAction,
  resolveVacancyFirstGate
} from '../src/services/vacancyFirstGate.js';
import {
  VacancyConceptAlternativeAction,
  evaluateVacancyConceptAlternative,
  vacancyRequiresPrequalification
} from '../src/services/vacancyConceptMatcher.js';

const ConversationStep = Object.freeze({
  MENU: 'MENU',
  GREETING_SENT: 'GREETING_SENT'
});

const bogotaOperation = { id: 'op-bogota', name: 'Operacion Bogota', city: { id: 'city-bogota', name: 'Bogota' } };
const ibagueOperation = { id: 'op-ibague', name: 'Operacion Ibague', city: { id: 'city-ibague', name: 'Ibague' } };

function vacancy(overrides = {}) {
  return {
    id: 'vac-base',
    title: 'Auxiliar de cargue y descargue',
    role: 'Auxiliar de cargue y descargue',
    city: 'Bogota',
    operation: bogotaOperation,
    roleDescription: 'Apoyo operativo en cargue y descargue.',
    requirements: 'Disponibilidad para labor operativa.',
    conditions: 'Condiciones registradas.',
    experienceRequired: 'NO',
    minExperienceMonths: null,
    experienceTimeText: null,
    isActive: true,
    acceptingApplications: true,
    ...overrides
  };
}

function candidate(overrides = {}) {
  return {
    id: 'cand-test',
    status: 'NUEVO',
    currentStep: ConversationStep.GREETING_SENT,
    vacancyId: null,
    botResumeMode: null,
    ...overrides
  };
}

async function decide({ text, candidatePatch = {}, vacancies = [], currentVacancy = null, prisma = null }) {
  return resolveVacancyFirstGate({
    prisma,
    candidate: candidate(candidatePatch),
    currentVacancy,
    inboundText: text,
    currentStep: candidatePatch.currentStep || ConversationStep.GREETING_SENT,
    recentMessages: [],
    vacancyHints: {
      allVacancies: vacancies,
      activeVacancies: vacancies.filter((item) => item.isActive && item.acceptingApplications)
    }
  });
}

test('concept matcher ofrece alternativa abierta si el cargo pedido no existe pero hay vacante operativa en la ciudad', () => {
  const cargueBogota = vacancy({ id: 'vac-cargue-bogota' });
  const alternative = evaluateVacancyConceptAlternative({
    city: 'Bogota',
    requestedRoleText: 'servicio general',
    activeVacancies: [cargueBogota]
  });

  assert.equal(alternative.action, VacancyConceptAlternativeAction.OFFER_ALTERNATIVE);
  assert.equal(alternative.suggestedVacancyId, 'vac-cargue-bogota');
  assert.equal(alternative.requiresPrequalification, false);
  assert.match(alternative.reply, /servicio general/i);
  assert.match(alternative.reply, /Auxiliar de cargue y descargue/i);
});

test('concept matcher pide prevalidacion si la alternativa activa requiere experiencia o formacion', () => {
  const liderIbague = vacancy({
    id: 'vac-lider-ibague',
    title: 'Lider de operacion',
    role: 'Lider de operacion',
    city: 'Ibague',
    operation: ibagueOperation,
    requirements: 'Tecnico o tecnologo con experiencia liderando personal operativo.',
    experienceRequired: 'YES',
    experienceTimeText: '1 año liderando equipos'
  });

  assert.equal(vacancyRequiresPrequalification(liderIbague), true);

  const alternative = evaluateVacancyConceptAlternative({
    city: 'Ibague',
    requestedRoleText: 'servicios generales',
    activeVacancies: [liderIbague]
  });

  assert.equal(alternative.action, VacancyConceptAlternativeAction.ASK_PREQUALIFICATION);
  assert.equal(alternative.suggestedVacancyId, 'vac-lider-ibague');
  assert.match(alternative.reply, /requiere/i);
  assert.match(alternative.reply, /perfil/i);
});

test('vacancyFirstGate no dice que no hay vacantes en la ciudad si existe alternativa activa abierta', async () => {
  const cargueBogota = vacancy({ id: 'vac-cargue-bogota-flow' });
  const decision = await decide({
    text: 'Bogotá servicio general',
    vacancies: [cargueBogota]
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'open_alternative_available');
  assert.equal(decision.replyKind, 'ALTERNATIVE_VACANCY_OFFER');
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.botResumeMode, `${ALTERNATIVE_VACANCY_OFFER_MODE}:vac-cargue-bogota-flow`);
  assert.match(decision.reply, /opcion activa/i);
});

test('vacancyFirstGate prefiltra alternativa especializada antes de asignar', async () => {
  const liderIbague = vacancy({
    id: 'vac-lider-ibague-flow',
    title: 'Lider de operacion',
    role: 'Lider de operacion',
    city: 'Ibague',
    operation: ibagueOperation,
    requirements: 'Tecnico o tecnologo con experiencia liderando personal operativo.',
    experienceRequired: 'YES',
    experienceTimeText: '1 año liderando equipos'
  });

  const decision = await decide({
    text: 'Ibagué servicios generales',
    vacancies: [liderIbague]
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'alternative_requires_prequalification');
  assert.equal(decision.replyKind, 'ALTERNATIVE_PREQUALIFICATION_PROMPT');
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.botResumeMode, `${ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE}:vac-lider-ibague-flow`);
  assert.match(decision.reply, /cuentas con ese perfil/i);
});

test('aceptacion posterior de alternativa abierta asigna la vacante sugerida', async () => {
  const cargueBogota = vacancy({ id: 'vac-cargue-accepted' });
  const prisma = {
    vacancy: {
      async findUnique({ where }) {
        assert.equal(where.id, 'vac-cargue-accepted');
        return cargueBogota;
      }
    }
  };

  const decision = await decide({
    text: 'Sí, me interesa esa opción',
    candidatePatch: { botResumeMode: `${ALTERNATIVE_VACANCY_OFFER_MODE}:vac-cargue-accepted` },
    vacancies: [cargueBogota],
    prisma
  });

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.reason, 'ALTERNATIVE_VACANCY_ACCEPTED');
  assert.equal(decision.vacancyId, 'vac-cargue-accepted');
});

test('rechazo de alternativa no asigna vacante y vuelve a oferta de perfil futuro', async () => {
  const decision = await decide({
    text: 'No gracias, solo servicios generales',
    candidatePatch: { botResumeMode: `${ALTERNATIVE_VACANCY_OFFER_MODE}:vac-cargue-declined` },
    vacancies: []
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ALTERNATIVE_VACANCY_DECLINED');
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.match(decision.reply, /no te asigno/i);
  assert.match(decision.reply, /perfil registrado/i);
});
