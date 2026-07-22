import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVacancyResolutionText,
  resolveVacancyFirstGate,
  VacancyFirstGateAction
} from '../src/services/vacancyFirstGate.js';

function operation(id, city) {
  return { id, name: `Operación ${city}`, city: { id: `city-${id}`, name: city } };
}

const neivaAuxiliary = {
  id: 'vac-neiva-auxiliar',
  title: 'Auxiliar de cargue y descargue Neiva',
  role: 'Auxiliar de cargue y descargue',
  city: 'Neiva',
  operation: operation('neiva', 'Neiva'),
  isActive: true,
  acceptingApplications: true
};

const medellinLeader = {
  id: 'vac-medellin-lider',
  title: 'Líder de operación Medellín',
  role: 'Líder de operación',
  city: 'Medellin',
  operation: operation('medellin-lider', 'Medellin'),
  isActive: true,
  acceptingApplications: true
};

const medellinAuxiliary = {
  id: 'vac-medellin-auxiliar',
  title: 'Auxiliar de cargue y descargue Medellín',
  role: 'Auxiliar de cargue y descargue',
  city: 'Medellin',
  operation: operation('medellin-auxiliar', 'Medellin'),
  isActive: true,
  acceptingApplications: true
};

const allVacancies = [neivaAuxiliary, medellinLeader, medellinAuxiliary];
const candidate = {
  id: 'candidate-vacancy-correction',
  status: 'NUEVO',
  currentStep: 'GREETING_SENT',
  vacancyId: null,
  botResumeMode: null
};
const initialHistory = [
  { direction: 'INBOUND', body: 'Estoy en Neiva y busco auxiliar de cargue y descargue' },
  { direction: 'OUTBOUND', body: 'Confírmame por favor ciudad y cargo.' }
];

function gateInput(inboundText, recentMessages = initialHistory) {
  return {
    prisma: null,
    candidate,
    currentVacancy: null,
    inboundText,
    currentStep: 'GREETING_SENT',
    recentMessages,
    vacancyHints: {
      activeVacancies: allVacancies,
      allVacancies
    }
  };
}

test('una corrección completa usa solo la ciudad y cargo actuales', async () => {
  const inboundText = 'No, en realidad es Medellín, líder de operación';
  assert.equal(buildVacancyResolutionText(inboundText, initialHistory), inboundText);

  const decision = await resolveVacancyFirstGate(gateInput(inboundText));

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.reason, 'ACTIVE_VACANCY_RESOLVED');
  assert.equal(decision.vacancyId, medellinLeader.id);
  assert.equal(decision.resolution.city, 'Medellin');
  assert.doesNotMatch(decision.resolution.roleHint || '', /auxiliar|cargue|descargue/i);
});

test('una corrección parcial no reutiliza el cargo histórico', async () => {
  const inboundText = 'No, en realidad es Medellín';
  assert.equal(buildVacancyResolutionText(inboundText, initialHistory), inboundText);

  const decision = await resolveVacancyFirstGate(gateInput(inboundText));

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'CITY_WITH_ACTIVE_VACANCIES_ROLE_AMBIGUOUS');
  assert.equal(decision.resolution.city, 'Medellin');
  assert.equal(decision.resolution.roleHint, null);
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
});

test('sin corrección conserva la continuidad de ciudad y cargo entre turnos', async () => {
  const recentMessages = [
    { direction: 'INBOUND', body: 'Estoy en Medellín' },
    { direction: 'OUTBOUND', body: '¿Para qué cargo estás interesado?' }
  ];
  const inboundText = 'Líder de operación';
  assert.match(buildVacancyResolutionText(inboundText, recentMessages), /Medellín[\s\S]*Líder de operación/i);

  const decision = await resolveVacancyFirstGate(gateInput(inboundText, recentMessages));

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.vacancyId, medellinLeader.id);
});
