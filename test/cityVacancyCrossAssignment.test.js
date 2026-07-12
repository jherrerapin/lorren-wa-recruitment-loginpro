import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCityFromText, resolveVacancyFromText } from '../src/services/vacancyResolver.js';
import {
  FUTURE_PROFILE_OFFER_MODE,
  resolveVacancyFirstGate,
  VacancyFirstGateAction
} from '../src/services/vacancyFirstGate.js';

const neivaOperation = {
  id: 'op-neiva',
  name: 'Operacion Neiva',
  city: { id: 'city-neiva', name: 'Neiva' }
};

const activeNeivaVacancy = {
  id: 'vac-neiva-cargue',
  title: 'Auxiliar de Cargue y Descargue Neiva',
  role: 'Auxiliar de cargue y descargue',
  city: 'Neiva',
  operation: neivaOperation,
  operationAddress: 'Sector Las Brisas',
  roleDescription: 'Apoyo en cargue y descargue de mercancia.',
  isActive: true,
  acceptingApplications: true
};

test('detecta Medellin aunque no exista una vacante configurada en esa ciudad', () => {
  const city = detectCityFromText('Hola, busco vacantes de empleo en Medellín', ['Neiva']);
  assert.equal(city, 'Medellin');
});

test('Medellin + cargue y descargue no se cruza con la vacante activa de Neiva', async () => {
  const resolution = await resolveVacancyFromText(
    null,
    ['Hola para saber si tienen vacantes de empleo en medellín?', 'Medellín', 'Cargue y descargue'].join('\n'),
    {
      activeVacancies: [activeNeivaVacancy],
      allVacancies: [activeNeivaVacancy]
    }
  );

  assert.equal(resolution.resolved, false);
  assert.equal(resolution.vacancy, null);
  assert.equal(resolution.city, 'Medellin');
  assert.equal(resolution.roleHint, 'cargue descargue');
  assert.equal(resolution.reason, 'city_without_active_vacancies');
});

test('la compuerta inicial responde sin vacantes en Medellin y no asigna Neiva', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: {
      id: 'cand-medellin',
      status: 'NUEVO',
      currentStep: 'GREETING_SENT',
      vacancyId: null,
      botResumeMode: null
    },
    currentVacancy: null,
    inboundText: 'Cargue y descargue',
    currentStep: 'GREETING_SENT',
    recentMessages: [
      { direction: 'INBOUND', body: 'Hola para saber si tienen vacantes de empleo en medellín?' },
      {
        direction: 'OUTBOUND',
        body: 'Hola, gracias por comunicarte con LoginPro. ¿Desde qué ciudad nos escribes y para qué vacante?',
        rawPayload: {
          source: 'vacancy_first_gate',
          replyKind: 'ASK_CITY_AND_ROLE',
          reason: 'VACANCY_NOT_RESOLVED'
        }
      },
      { direction: 'INBOUND', body: 'Medellín' }
    ],
    vacancyHints: {
      activeVacancies: [activeNeivaVacancy],
      allVacancies: [activeNeivaVacancy]
    }
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'CITY_WITHOUT_ACTIVE_VACANCIES');
  assert.equal(decision.resolution.city, 'Medellin');
  assert.equal(decision.resolution.reason, 'city_without_active_vacancies');
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.botResumeMode, FUTURE_PROFILE_OFFER_MODE);
  assert.match(decision.reply, /no tengo vacantes activas en Medellin/i);
  assert.doesNotMatch(decision.reply, /Neiva/i);
});
