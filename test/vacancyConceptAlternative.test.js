import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALTERNATIVE_VACANCY_OFFER_MODE,
  ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE,
  resolveVacancyFirstGate,
  VacancyFirstGateAction
} from '../src/services/vacancyFirstGate.js';

function city(name = 'Bogota') {
  return { id: `city-${name}`, name };
}

const bogotaCity = city('Bogota');
const ibagueCity = city('Ibague');
const bogotaOperation = { id: 'op-bogota', name: 'Montevideo', city: bogotaCity };
const ibagueOperation = { id: 'op-ibague', name: 'Zona aeropuerto', city: ibagueCity };

function vacancy(overrides = {}) {
  return {
    id: 'vac-cargue-bogota',
    title: 'Auxiliar de Cargue y Descargue Bogota',
    role: 'Auxiliar de cargue y descargue',
    roleDescription: 'Apoyo operativo en bodega, cargue y descargue.',
    requirements: '',
    conditions: '',
    requiredDocuments: '',
    city: 'Bogota',
    operation: bogotaOperation,
    isActive: true,
    acceptingApplications: true,
    ...overrides
  };
}

async function decide({ text, vacancies = [], candidatePatch = {}, prisma = null }) {
  const effectivePrisma = prisma || {
    vacancy: {
      async findMany() {
        return vacancies;
      },
      async findUnique({ where }) {
        return vacancies.find((item) => item.id === where.id) || null;
      }
    }
  };

  return resolveVacancyFirstGate({
    prisma: effectivePrisma,
    candidate: { id: 'cand-1', currentStep: 'GREETING_SENT', ...candidatePatch },
    currentVacancy: null,
    inboundText: text,
    currentStep: candidatePatch.currentStep || 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: vacancies, activeVacancies: vacancies.filter((item) => item.isActive && item.acceptingApplications) }
  });
}

test('concept matcher ofrece alternativa abierta si el cargo pedido no existe pero hay vacante operativa en la ciudad', async () => {
  const cargueBogota = vacancy({ id: 'vac-cargue-alt' });
  const decision = await decide({ text: 'Bogotá servicios generales', vacancies: [cargueBogota] });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'open_alternative_available');
  assert.equal(decision.replyKind, 'ALTERNATIVE_VACANCY_OFFER');
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.botResumeMode, `${ALTERNATIVE_VACANCY_OFFER_MODE}:vac-cargue-alt`);
  assert.match(decision.reply, /opcion activa/i);
});

test('concept matcher pide prevalidacion si la alternativa activa requiere experiencia o formacion', async () => {
  const liderIbague = vacancy({
    id: 'vac-lider-ibague-flow',
    title: 'Lider de Operaciones Ibagué',
    role: 'Lider de Operaciones',
    roleDescription: 'Liderar y administrar equipos de trabajo.',
    city: 'Ibague',
    operation: ibagueOperation,
    requirements: 'Tecnico o tecnologo con experiencia liderando personal operativo.',
    experienceRequired: 'YES',
    experienceTimeText: '1 año liderando equipos'
  });

  const decision = await decide({ text: 'Ibagué servicios generales', vacancies: [liderIbague] });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'alternative_requires_prequalification');
  assert.equal(decision.replyKind, 'ALTERNATIVE_PREQUALIFICATION_PROMPT');
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.botResumeMode, `${ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE}:vac-lider-ibague-flow`);
  assert.match(decision.reply, /cuentas con ese perfil/i);
});

test('vacancyFirstGate no dice que no hay vacantes en la ciudad si existe alternativa activa abierta', async () => {
  const cargueBogota = vacancy({ id: 'vac-cargue-open' });
  const decision = await decide({ text: 'Bogotá servicio general', vacancies: [cargueBogota] });

  assert.equal(decision.reason, 'open_alternative_available');
  assert.equal(decision.replyKind, 'ALTERNATIVE_VACANCY_OFFER');
  assert.ok(!decision.reply.includes('no tengo vacantes activas en Bogota'));
});

test('vacancyFirstGate prefiltra alternativa especializada antes de asignar', async () => {
  const liderIbague = vacancy({
    id: 'vac-lider-ibague-pre',
    title: 'Lider de Operaciones Ibagué',
    role: 'Lider de Operaciones',
    roleDescription: 'Liderar y administrar equipos de trabajo.',
    city: 'Ibague',
    operation: ibagueOperation,
    requirements: 'Tecnico o tecnologo con experiencia liderando personal operativo.',
    experienceRequired: 'YES',
    experienceTimeText: '1 año liderando equipos'
  });

  const decision = await decide({ text: 'Ibagué servicios generales', vacancies: [liderIbague] });

  assert.equal(decision.reason, 'alternative_requires_prequalification');
  assert.equal(decision.replyKind, 'ALTERNATIVE_PREQUALIFICATION_PROMPT');
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
});

test('aceptacion posterior de alternativa abierta entra a recoleccion de datos sin repetir la vacante', async () => {
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

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ALTERNATIVE_VACANCY_ACCEPTED');
  assert.equal(decision.replyKind, 'ACTIVE_VACANCY_DATA_PROMPT');
  assert.equal(decision.vacancyId, 'vac-cargue-accepted');
  assert.equal(decision.candidateUpdates.vacancyId, 'vac-cargue-accepted');
  assert.equal(decision.candidateUpdates.currentStep, 'COLLECTING_DATA');
  assert.doesNotMatch(decision.reply, /la vacante que tengo para ti/i);
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
