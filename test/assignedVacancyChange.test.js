import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVacancyFirstGate,
  VACANCY_CHANGE_OFFER_MODE,
  VacancyFirstGateAction
} from '../src/services/vacancyFirstGate.js';

function operation(id, city) {
  return { id, name: `Operación ${city}`, city: { id: `city-${id}`, name: city } };
}

function vacancy(overrides = {}) {
  return {
    id: 'vac-neiva-aux',
    title: 'Auxiliar de cargue y descargue Neiva',
    role: 'Auxiliar de cargue y descargue',
    city: 'Neiva',
    operation: operation('neiva', 'Neiva'),
    isActive: true,
    acceptingApplications: true,
    ...overrides
  };
}

const currentVacancy = vacancy();
const targetVacancy = vacancy({
  id: 'vac-medellin-lider',
  title: 'Líder de operación Medellín',
  role: 'Líder de operación',
  city: 'Medellin',
  operation: operation('medellin', 'Medellin')
});
const otherMedellinVacancy = vacancy({
  id: 'vac-medellin-aux',
  title: 'Auxiliar de cargue y descargue Medellín',
  city: 'Medellin',
  operation: operation('medellin-aux', 'Medellin')
});

function prismaFor(vacancies = [currentVacancy, targetVacancy, otherMedellinVacancy]) {
  return {
    vacancy: {
      async findMany() {
        return vacancies;
      },
      async findUnique({ where }) {
        return vacancies.find((item) => item.id === where.id) || null;
      }
    }
  };
}

function decide({
  text,
  candidatePatch = {},
  current = currentVacancy,
  vacancies = [currentVacancy, targetVacancy, otherMedellinVacancy],
  hints = {}
}) {
  const candidate = {
    id: 'candidate-assigned-change',
    status: 'EN_PROCESO',
    currentStep: 'COLLECTING_DATA',
    vacancyId: currentVacancy.id,
    botResumeMode: null,
    reminderScheduledFor: null,
    reminderState: 'SKIPPED',
    ...candidatePatch
  };
  return resolveVacancyFirstGate({
    prisma: prismaFor(vacancies),
    candidate,
    currentVacancy: current,
    inboundText: text,
    currentStep: candidate.currentStep,
    recentMessages: [],
    vacancyHints: {
      activeVacancies: vacancies.filter((item) => item.isActive && item.acceptingApplications),
      allVacancies: vacancies,
      ...hints
    }
  });
}

test('ofrece otra vacante sin reemplazar la asociación actual', async () => {
  const decision = await decide({ text: 'Quiero cambiar a líder de operación en Medellín' });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_OFFERED');
  assert.equal(decision.vacancyId, targetVacancy.id);
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.botResumeMode, `${VACANCY_CHANGE_OFFER_MODE}:${targetVacancy.id}`);
  assert.match(decision.reply, /no cambiará todavía/i);
  assert.match(decision.reply, /confírmame/i);
});

test('aceptación explícita cambia a la vacante ofrecida', async () => {
  const decision = await decide({
    text: 'Sí, confirmo que quiero cambiar',
    candidatePatch: {
      currentStep: 'GREETING_SENT',
      botResumeMode: `${VACANCY_CHANGE_OFFER_MODE}:${targetVacancy.id}`
    }
  });

  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_ACCEPTED');
  assert.equal(decision.candidateUpdates.vacancyId, targetVacancy.id);
  assert.equal(decision.candidateUpdates.currentStep, 'COLLECTING_DATA');
  assert.equal(decision.candidateUpdates.botResumeMode, null);
});

test('rechazo conserva la vacante original y limpia el modo', async () => {
  const decision = await decide({
    text: 'No gracias, mantengamos la anterior',
    candidatePatch: {
      currentStep: 'GREETING_SENT',
      botResumeMode: `${VACANCY_CHANGE_OFFER_MODE}:${targetVacancy.id}`
    }
  });

  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_DECLINED');
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.botResumeMode, null);
  assert.match(decision.reply, /mantengo tu proceso/i);
});

test('si la vacante ofrecida deja de estar disponible conserva la original', async () => {
  const unavailableTarget = { ...targetVacancy, isActive: false, acceptingApplications: false };
  const decision = await decide({
    text: 'Sí, confirmo',
    candidatePatch: {
      currentStep: 'GREETING_SENT',
      botResumeMode: `${VACANCY_CHANGE_OFFER_MODE}:${targetVacancy.id}`
    },
    vacancies: [currentVacancy, unavailableTarget]
  });

  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_NOT_AVAILABLE');
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.botResumeMode, null);
});

test('pregunta sobre la oferta conserva el modo y no cambia vacancyId', async () => {
  const decision = await decide({
    text: '¿Cuáles son los requisitos de esa vacante?',
    candidatePatch: {
      currentStep: 'GREETING_SENT',
      botResumeMode: `${VACANCY_CHANGE_OFFER_MODE}:${targetVacancy.id}`
    }
  });

  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_INFO_REQUEST');
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.botResumeMode, `${VACANCY_CHANGE_OFFER_MODE}:${targetVacancy.id}`);
  assert.match(decision.reply, /confírmamelo/i);
});

test('solicitud parcial no reutiliza metadata ni la vacante anterior', async () => {
  const decision = await decide({
    text: 'Quiero otra vacante en Medellín',
    hints: {
      trustedVacancyId: currentVacancy.id,
      trustedVacancy: currentVacancy
    }
  });

  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_NEEDS_TARGET');
  assert.equal(decision.candidateUpdates, undefined);
  assert.equal(decision.resolution.city, 'Medellin');
  assert.equal(decision.resolution.roleHint, null);
  assert.match(decision.reply, /cargo exacto/i);
});

test('mencionar la misma vacante no crea una oferta de cambio', async () => {
  const decision = await decide({ text: 'Quiero cambiar a auxiliar de cargue y descargue en Neiva' });

  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_SAME_VACANCY');
  assert.equal(decision.candidateUpdates, undefined);
  assert.equal(decision.vacancyId, currentVacancy.id);
});

test('un candidato agendado no modifica su vacante desde esta compuerta', async () => {
  const decision = await decide({
    text: 'Quiero cambiar a líder de operación en Medellín',
    candidatePatch: { currentStep: 'SCHEDULED' }
  });

  assert.equal(decision.action, VacancyFirstGateAction.ALLOW_ENGINE);
  assert.equal(decision.reason, 'ACTIVE_VACANCY_ALREADY_RESOLVED');
  assert.equal(decision.candidateUpdates, undefined);
});
