import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VacancyFirstGateAction,
  resolveVacancyFirstGate
} from '../src/services/vacancyFirstGate.js';
import { buildVacancyQuestionReply } from '../src/services/dataConsentGate.js';
import { VACANCY_CONSENT_ORDER_REPLAYS } from './conversation-replay/vacancyConsentOrderReplay.js';

function activeVacancy(overrides = {}) {
  return {
    id: 'TEST-VACANCY-NEIVA-BODEGA',
    title: 'Auxiliar de Bodega Neiva',
    role: 'Auxiliar de bodega',
    city: 'Neiva',
    operationAddress: 'Zona industrial de prueba',
    roleDescription: 'Apoyar el alistamiento y movimiento de mercancía.',
    requirements: 'Experiencia relacionada y disponibilidad operativa.',
    conditions: 'Salario y horario registrados para la vacante.',
    requiredDocuments: null,
    isActive: true,
    acceptingApplications: true,
    operation: {
      id: 'TEST-OPERATION-NEIVA',
      name: 'Operación Neiva',
      city: { id: 'TEST-CITY-NEIVA', name: 'Neiva' }
    },
    ...overrides
  };
}

async function executeReplay(replay) {
  const vacancy = activeVacancy();
  return resolveVacancyFirstGate({
    prisma: null,
    candidate: structuredClone(replay.candidate),
    currentVacancy: null,
    inboundText: replay.inboundText,
    currentStep: replay.candidate.currentStep,
    recentMessages: [],
    vacancyHints: {
      allVacancies: [vacancy],
      activeVacancies: [vacancy]
    }
  });
}

function assertIncludes(body, fragments = []) {
  for (const fragment of fragments) assert.match(body, new RegExp(fragment, 'i'));
}

function assertExcludes(body, fragments = []) {
  for (const fragment of fragments) assert.doesNotMatch(body, new RegExp(fragment, 'i'));
}

test('replays: una vacante activa se presenta y pregunta interés antes de datos o consentimiento', async () => {
  for (const replay of VACANCY_CONSENT_ORDER_REPLAYS) {
    const decision = await executeReplay(replay);

    assert.equal(decision.action, VacancyFirstGateAction.REPLY, replay.id);
    assert.equal(decision.reason, replay.expected.reason, replay.id);
    assert.equal(decision.replyKind, replay.expected.replyKind, replay.id);
    assert.equal(decision.vacancyId, 'TEST-VACANCY-NEIVA-BODEGA', replay.id);
    assert.equal(decision.candidateUpdates.vacancyId, decision.vacancyId, replay.id);
    assert.equal(decision.candidateUpdates.currentStep, replay.expected.currentStep, replay.id);
    assert.equal(decision.candidateUpdates.botResumeMode, replay.expected.botResumeMode, replay.id);
    assertIncludes(decision.reply, replay.expected.includes);
    assertExcludes(decision.reply, replay.expected.excludes);
  }
});

test('una vacante resuelta después de consentimiento conserva el flujo post-consent existente', async () => {
  const vacancy = activeVacancy();
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: {
      id: 'TEST-CANDIDATE-CONSENTED-VACANCY',
      phone: 'TEST-PHONE-CONSENTED-VACANCY',
      vacancyId: null,
      dataConsentStatus: 'ACCEPTED',
      currentStep: 'MENU',
      botResumeMode: null
    },
    inboundText: 'Auxiliar de bodega en Neiva',
    currentStep: 'MENU',
    recentMessages: [],
    vacancyHints: {
      allVacancies: [vacancy],
      activeVacancies: [vacancy]
    }
  });

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.vacancyId, vacancy.id);
  assert.equal(decision.reason, 'ACTIVE_VACANCY_RESOLVED');
});


test('replay #901: una pregunta de turnos recibe solo la información configurada', async () => {
  const vacancy = activeVacancy({
    requirements: 'Experiencia mínima. Disponibilidad para turnos rotativos y tiempo extra.',
    conditions: 'Vinculación inmediata. Pagos quincenales.'
  });
  const text = '¿Los turnos son de domingo a domingo o de lunes a sábado?';
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: {
      id: 'TEST-CANDIDATE-TIMING',
      phone: 'TEST-PHONE-TIMING',
      vacancyId: vacancy.id,
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: null
    },
    currentVacancy: vacancy,
    inboundText: text,
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });

  assert.equal(decision.reason, 'ACTIVE_VACANCY_INFORMATION_ANSWER');
  assert.match(decision.reply, /turnos rotativos/i);
  assert.match(decision.reply, /no hay días ni un horario exacto/i);
  assert.doesNotMatch(decision.reply, /funciones del cargo|documentación para el proceso/i);
});

test('las rutas comparten la autoridad temporal y no inventan fecha de inicio', async () => {
  const vacancy = activeVacancy();
  const text = '¿Cuándo empiezo?';
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: {
      id: 'TEST-CANDIDATE-START',
      phone: 'TEST-PHONE-START',
      vacancyId: vacancy.id,
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: null
    },
    currentVacancy: vacancy,
    inboundText: text,
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });

  assert.equal(decision.reply, buildVacancyQuestionReply(vacancy, text));
  assert.match(decision.reply, /no hay una fecha de inicio registrada/i);
});

test('la autoridad temporal conserva días configurados con tilde', () => {
  const reply = buildVacancyQuestionReply(
    activeVacancy({ conditions: 'Jornada de miércoles a sábado, de 8:00 a.m. a 5:00 p.m.' }),
    '¿Qué horario tiene la vacante?'
  );

  assert.match(reply, /miércoles a sábado/i);
  assert.doesNotMatch(reply, /no hay días ni un horario exacto/i);
});
