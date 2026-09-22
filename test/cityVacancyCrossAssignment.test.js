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

test('la última ciudad mencionada prevalece sobre una ciudad anterior del contexto', () => {
  const city = detectCityFromText(
    'Inicialmente escribí Neiva\nAhora el proceso correcto es Medellín',
    ['Neiva', 'Medellin']
  );

  assert.equal(city, 'Medellin');
});

test('Medellin explícito prevalece sobre un cityHint equivocado y no se cruza con Neiva', async () => {
  const resolution = await resolveVacancyFromText(
    null,
    ['Hola para saber si tienen vacantes de empleo en medellín?', 'Medellín', 'Cargue y descargue'].join('\n'),
    {
      cityHint: 'Neiva',
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

test('cityHint sigue siendo util cuando el candidato no escribió una ciudad', async () => {
  const resolution = await resolveVacancyFromText(
    null,
    'Me interesa cargue y descargue',
    {
      cityHint: 'Neiva',
      activeVacancies: [activeNeivaVacancy],
      allVacancies: [activeNeivaVacancy]
    }
  );

  assert.equal(resolution.resolved, true);
  assert.equal(resolution.vacancy.id, activeNeivaVacancy.id);
  assert.equal(resolution.city, 'Neiva');
});

test('matching débil conserva residencia y cargo conocidos en vez de reiniciar ciudad y cargo', async () => {
  const resolution = await resolveVacancyFromText(
    null,
    ['De Neiva Huila', 'Auxiliar de bodega', '.'].join('\n'),
    {
      activeVacancies: [activeNeivaVacancy],
      allVacancies: [activeNeivaVacancy]
    }
  );

  assert.equal(resolution.resolved, false);
  assert.equal(resolution.city, null);
  assert.equal(resolution.residenceLocation, 'Neiva');
  assert.equal(resolution.roleHint, 'auxiliar bodega');
  assert.equal(resolution.reason, 'residence_without_compatible_vacancy');
});

test('la compuerta no vuelve a pedir ciudad y cargo si ya conoce residencia y cargo pero falta desambiguar vacante', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: {
      id: 'cand-neiva-role',
      status: 'NUEVO',
      currentStep: 'GREETING_SENT',
      vacancyId: null,
      botResumeMode: null
    },
    currentVacancy: null,
    inboundText: 'Auxiliar de bodega\n.',
    currentStep: 'GREETING_SENT',
    recentMessages: [
      { direction: 'INBOUND', body: 'De Neiva Huila' },
      {
        direction: 'OUTBOUND',
        body: 'Gracias por contarme desde dónde escribes. Para ubicar bien tu proceso, ¿recuerdas qué cargo viste en el anuncio por el que nos contactaste?',
        rawPayload: {
          source: 'vacancy_first_gate',
          replyKind: 'ASK_VACANCY_ROLE',
          reason: 'RESIDENCE_CAPTURED_VACANCY_NEEDED'
        }
      }
    ],
    vacancyHints: {
      activeVacancies: [activeNeivaVacancy],
      allVacancies: [activeNeivaVacancy]
    }
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'RESIDENCE_AND_ROLE_CAPTURED_TARGET_NEEDED');
  assert.equal(decision.replyKind, 'ASK_VACANCY_TARGET');
  assert.equal(decision.resolution.residenceLocation, 'Neiva');
  assert.equal(decision.resolution.roleHint, 'auxiliar bodega');
  assert.doesNotMatch(decision.reply, /desde qué ciudad|qué cargo viste/i);
  assert.match(decision.reply, /operaci[oó]n|zona|anuncio|lugar/i);
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
      city: 'Neiva',
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
