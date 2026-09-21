import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveVacancyFirstGate, VacancyFirstGateAction } from '../src/services/vacancyFirstGate.js';
import { isAffirmativeVacancyConfirmation, APPLICATION_INTEREST_PENDING_MODE, DATA_CONSENT_PENDING_MODE } from '../src/services/dataConsentGate.js';
import {
  isApplicationFollowUpQuestion,
  processText
} from '../src/routes/webhook.js';
import { resolveCampaignForReferral } from '../src/services/campaignAttribution.js';
import { getMultilineWindowMs, selectAdjacentTurnMessages } from '../src/services/multiline.js';
import { createDebugTrace } from '../src/services/debugTrace.js';
import { runConversationCase } from './helpers/conversationHarness.js';
import { baseOperations, baseVacancies } from './fixtures/conversationCases.js';

// Regresiones derivadas de conversaciones reales de pauta observadas el 8 de agosto de 2026.
const vacancy = {
  id: 'vac-neiva-leader',
  title: 'Líder de Operación',
  role: 'Líder de Operación',
  city: 'Neiva',
  roleDescription: 'Liderar y administrar equipos de trabajo',
  operationAddress: 'Sector Las Brisas, cerca a la terminal de Neiva',
  requirements: 'Técnico o tecnólogo en Logística y mínimo un año de experiencia',
  conditions: 'Salario a convenir, turnos rotativos y prestaciones de ley',
  isActive: true,
  acceptingApplications: true,
  schedulingEnabled: false,
  operation: { id: 'op-neiva', name: 'Operación Neiva', city: { id: 'city-neiva', name: 'Neiva' } }
};

function candidate(overrides = {}) {
  return {
    id: 'cand-production',
    status: 'NUEVO',
    currentStep: 'GREETING_SENT',
    vacancyId: null,
    botResumeMode: null,
    dataConsentStatus: 'PENDING',
    ...overrides
  };
}

function replayCandidate(overrides = {}) {
  return {
    ...candidate(),
    phone: '573000000900',
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
    cvMimeType: null,
    reminderState: 'NONE',
    reminderScheduledFor: null,
    botPaused: false,
    botPausedAt: null,
    botPauseReason: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    ...overrides
  };
}

test('producción: vacante resuelta entrega información antes de preguntar interés', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate(),
    currentVacancy: null,
    inboundText: 'Neiva líder de operaciones',
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST');
  assert.match(decision.reply, /Liderar y administrar equipos/i);
  assert.match(decision.reply, /Sector Las Brisas/i);
  assert.match(decision.reply, /Técnico o tecnólogo/i);
  assert.match(decision.reply, /Salario a convenir/i);
  assert.match(decision.reply, /te interesa continuar/i);
});

test('producción: Esa si se reconoce como confirmación natural de la vacante', () => {
  assert.equal(isAffirmativeVacancyConfirmation('Esa si'), true);
  assert.equal(isAffirmativeVacancyConfirmation('Esta sí'), true);
  assert.equal(isAffirmativeVacancyConfirmation('Sí, esa es'), true);
});

test('defensa: confirmar vacante jamás pide datos antes del consentimiento', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate({ vacancyId: vacancy.id, botResumeMode: APPLICATION_INTEREST_PENDING_MODE }),
    currentVacancy: vacancy,
    inboundText: 'Esa si',
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.reason, 'ACTIVE_VACANCY_CONFIRMED_AWAIT_CONSENT');
  assert.match(decision.reply, /autorización|autorizas/i);
  assert.doesNotMatch(decision.reply, /compárteme.*documento|compárteme.*edad/i);
  assert.match(String(decision.candidateUpdates.botResumeMode), new RegExp(`^${DATA_CONSENT_PENDING_MODE}`));
});

test('producción: DONE entiende quiero saber sobre mi proceso', () => {
  assert.equal(isApplicationFollowUpQuestion('¡Hola! Quiero saber sobre mi proceso'), true);
  assert.equal(isApplicationFollowUpQuestion('¿Cómo va mi proceso?'), true);
  assert.equal(isApplicationFollowUpQuestion('Quisiera saber de mi postulación'), true);
});

test('Meta: IDs objetivos desconocidos no se sustituyen por campaign_name descriptivo', () => {
  const campaigns = [
    { id: 'camp-neiva', code: 'INTERNO-NEIVA', name: 'Líder Operación Neiva Agosto 2026' },
    { id: 'camp-otra', code: 'INTERNO-OTRA', name: 'Otra campaña' }
  ];
  const exact = resolveCampaignForReferral(campaigns, { referral: {
    campaign_id: '120999999999', ad_id: '238999999999', campaign_name: 'Líder Operación Neiva Agosto 2026', ad_name: 'Anuncio cualquiera'
  }});
  assert.equal(exact.campaign, null);
  assert.equal(exact.reason, 'objective_metadata_without_exact_campaign_match');

  const unsafe = resolveCampaignForReferral(campaigns, { referral: {
    campaign_id: '120999999999', ad_id: '238999999999', ad_name: 'Líder Operación Neiva Agosto 2026'
  }});
  assert.equal(unsafe.campaign, null);
  assert.equal(unsafe.reason, 'objective_metadata_without_exact_campaign_match');
});

test('latencia: la ventana lógica de producción se mantiene entre 20 y 30 segundos', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousReasoning = process.env.LORREN_REASONING_WINDOW_MS;
  process.env.NODE_ENV = 'production';
  try {
    delete process.env.LORREN_REASONING_WINDOW_MS;
    assert.equal(getMultilineWindowMs(), 20000);
    process.env.LORREN_REASONING_WINDOW_MS = '8000';
    assert.equal(getMultilineWindowMs(), 20000);
    process.env.LORREN_REASONING_WINDOW_MS = '60000';
    assert.equal(getMultilineWindowMs(), 30000);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousReasoning === undefined) delete process.env.LORREN_REASONING_WINDOW_MS; else process.env.LORREN_REASONING_WINDOW_MS = previousReasoning;
  }
});

test('orgánico: cargo sin referral ni ubicación no autoasigna una vacante', async () => {
  const siberia = {
    ...vacancy,
    id: 'vac-siberia-bodega',
    title: 'Auxiliar Cargue y Descargue Siberia',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: { id: 'op-siberia', name: 'Siberia', city: { id: 'city-bogota', name: 'Bogota' } }
  };
  const neiva = {
    ...vacancy,
    id: 'vac-neiva-bodega',
    title: 'Auxiliar de Bodega Neiva',
    role: 'Auxiliar de bodega'
  };
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate(),
    currentVacancy: null,
    inboundText: 'Para preguntar por el trabajo de auxiliar de bodega',
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: [siberia, neiva], activeVacancies: [siberia, neiva] }
  });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ROLE_WITHOUT_TARGET_LOCATION');
  assert.equal(decision.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.match(decision.reply, /ciudad|zona/i);
  assert.doesNotMatch(decision.reply, /Siberia|Auxiliar de Bodega Neiva/i);
});

test('orgánico: una ciudad objetivo explícita corrige la vacante antes de confirmar interés', async () => {
  const siberia = {
    ...vacancy,
    id: 'vac-siberia-bodega',
    title: 'Auxiliar Cargue y Descargue Siberia',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: { id: 'op-siberia', name: 'Siberia', city: { id: 'city-bogota', name: 'Bogota' } }
  };
  const neiva = {
    ...vacancy,
    id: 'vac-neiva-bodega',
    title: 'Auxiliar de Bodega Neiva',
    role: 'Auxiliar de bodega'
  };
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate({ vacancyId: siberia.id, botResumeMode: APPLICATION_INTEREST_PENDING_MODE }),
    currentVacancy: siberia,
    inboundText: 'Mire la vacante para la ciudad de Neiva',
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: [siberia, neiva], activeVacancies: [siberia, neiva] }
  });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_OFFERED');
  assert.equal(decision.vacancyId, neiva.id);
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.botResumeMode, `vacancy_change_offer:${neiva.id}`);
  assert.match(decision.reply, /Neiva/i);
  assert.doesNotMatch(decision.reply, /autorizas|nombre completo|documento/i);
});

test('orgánico: confirmar el cambio de vacante pendiente conserva consentimiento antes de datos', async () => {
  const siberia = {
    ...vacancy,
    id: 'vac-siberia-bodega',
    title: 'Auxiliar Cargue y Descargue Siberia',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: { id: 'op-siberia', name: 'Siberia', city: { id: 'city-bogota', name: 'Bogota' } }
  };
  const neiva = {
    ...vacancy,
    id: 'vac-neiva-bodega',
    title: 'Auxiliar de Bodega Neiva',
    role: 'Auxiliar de bodega'
  };
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate({ vacancyId: siberia.id, botResumeMode: `vacancy_change_offer:${neiva.id}` }),
    currentVacancy: siberia,
    inboundText: 'Si',
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: [siberia, neiva], activeVacancies: [siberia, neiva] }
  });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_ACCEPTED_AWAIT_CONSENT');
  assert.equal(decision.replyKind, 'DATA_CONSENT_PROMPT');
  assert.equal(decision.candidateUpdates.vacancyId, neiva.id);
  assert.match(String(decision.candidateUpdates.botResumeMode), new RegExp(`^${DATA_CONSENT_PENDING_MODE}`));
  assert.match(decision.reply, /autorizas|autorización/i);
  assert.doesNotMatch(decision.reply, /nombre completo|tipo de documento|edad/i);
});

test('replay #901: texto y HV consecutivos comparten una sola respuesta lógica', () => {
  const texts = [{
    id: 'message-profile-test',
    createdAt: new Date('2026-09-08T18:10:01.000Z'),
    body: 'Nombre y tipo de documento de prueba'
  }];
  const adjacent = selectAdjacentTurnMessages(
    texts,
    new Date('2026-09-08T18:10:09.000Z'),
    20_000
  );

  assert.deepEqual(adjacent.map((message) => message.id), ['message-profile-test']);
});

test('defensa: una HV fuera de la ventana conserva su respuesta independiente', () => {
  const texts = [{
    id: 'message-earlier-test',
    createdAt: new Date('2026-09-08T18:09:30.000Z')
  }];
  const adjacent = selectAdjacentTurnMessages(
    texts,
    new Date('2026-09-08T18:10:09.000Z'),
    20_000
  );

  assert.equal(adjacent.length, 0);
});

test('producción: interés explícito al resolver vacante pasa directamente a consentimiento', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate(),
    currentVacancy: null,
    inboundText: 'Quiero postularme a Líder de Operación en Neiva',
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.reason, 'ACTIVE_VACANCY_RESOLVED_AWAIT_CONSENT');
  assert.equal(decision.replyKind, 'DATA_CONSENT_PROMPT');
  assert.match(decision.reply, /Vacante: Líder de Operación/i);
  assert.match(decision.reply, /Para continuar con tu postulación/i);
  assert.match(decision.reply, /si autorizas a LoginPro a tratar tus datos/i);
  assert.doesNotMatch(decision.reply, /¿Te interesa continuar con esta vacante\?/i);
});

test('defensa: vacancy-first entrega contexto de vacante al filtro de seguridad', () => {
  const source = readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
  assert.match(source, /replyKind: vacancyFirstGateDecision\.replyKind,[\s\S]{0,180}safetyVacancy: currentVacancy \|\| vacancyFirstGateDecision\.vacancy \|\| null/);
});

test('Meta: confirmación con interés explícito prepara consentimiento y no repite interés', () => {
  const source = readFileSync(new URL('../src/services/dataConsentGate.js', import.meta.url), 'utf8');
  assert.match(source, /explicitApplicationInterest = Boolean\(analyzeConversationTurn\(body\)\.interest\)/);
  assert.match(source, /campaign_vacancy_confirmed_interest/);
  assert.match(source, /buildVacancyInfoReply\(vacancy, \{ includeInterestPrompt: false \}\)/);
});

test('replay #901: resolver la vacante no descarta las entidades del mismo turno', async () => {
  const result = await runConversationCase({
    id: 'audit-901-vacancy-and-profile-same-turn',
    steps: ['Mi nombre es Ana Torres, CC 1234567890, tengo 28 años, vivo en barrio Jordan, me movilizo en bicicleta, sin restricciones médicas. Me interesa auxiliar de cargue y descargue en Ibagué.'],
    candidate: replayCandidate({
      id: 'candidate-audit-901-entities',
      phone: '573000000901',
      currentStep: 'MENU'
    }),
    vacancies: baseVacancies,
    operations: baseOperations,
    expect: {
      candidate: {
        vacancyId: 'vac-post',
        fullName: 'Ana Torres',
        documentType: 'CC',
        documentNumber: '1234567890',
        age: 28,
        neighborhood: 'Jordan',
        transportMode: 'Bicicleta',
        medicalRestrictions: 'Sin restricciones médicas',
        gender: 'UNKNOWN'
      },
      lastReplyIncludes: ['autorizo']
    }
  }, {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true,
    useInboundMessageId: true
  });

  assert.deepEqual(result.debugTraces[0].persisted_fields.sort(), [
    'age',
    'documentNumber',
    'documentType',
    'fullName',
    'medicalRestrictions',
    'neighborhood',
    'transportMode'
  ]);
});

test('replay #901: responde la pregunta y después retoma únicamente los datos pendientes', async () => {
  const result = await runConversationCase({
    id: 'audit-901-question-and-profile-same-turn',
    steps: ['Me llamo Luis Rojas, CC 987654321 y tengo 34 años. ¿Cuál es el horario?'],
    candidate: replayCandidate({
      id: 'candidate-audit-901-question-data',
      phone: '573000000902',
      vacancyId: 'vac-post',
      dataConsentStatus: 'ACCEPTED',
      dataConsentVersion: 'lorren-v2-2026-07-v3'
    }),
    vacancies: baseVacancies,
    operations: baseOperations,
    expect: {
      candidate: {
        fullName: 'Luis Rojas',
        documentType: 'CC',
        documentNumber: '987654321',
        age: 34,
        currentStep: 'COLLECTING_DATA'
      },
      lastReplyIncludes: ['Pago por turno', 'barrio', 'restricciones', 'transporte'],
      lastReplyNotIncludes: ['nombre completo', 'tipo de documento', 'número de documento', 'edad']
    }
  }, {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true
  });

  assert.deepEqual(result.debugTraces[0].persisted_fields.sort(), [
    'age',
    'documentNumber',
    'documentType',
    'fullName'
  ]);
});

test('replay #901: una etiqueta de experiencia dentro del bloque de datos no se trata como pregunta', async () => {
  const result = await runConversationCase({
    id: 'audit-901-structured-experience-label',
    steps: [
      'Me llamo Ana Torres. Cédula de ciudadanía 1234567890. Edad 29 años. Barrio Jordan. No cuento con restricciones médicas. Medio de transporte bicicleta. Experiencia 3 meses certificados. Qué experiencia tengo: cargue y descargue, auxiliar de bodega.'
    ],
    candidate: replayCandidate({
      id: 'candidate-audit-901-structured-label',
      phone: '573000000903',
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-post',
      dataConsentStatus: 'ACCEPTED',
      dataConsentVersion: 'lorren-v2-2026-07-v3',
      experienceSummary: null
    }),
    vacancies: baseVacancies,
    operations: baseOperations,
    expect: {
      candidate: {
        fullName: 'Ana Torres',
        documentType: 'CC',
        documentNumber: '1234567890',
        age: 29,
        neighborhood: 'Jordan',
        medicalRestrictions: 'Sin restricciones médicas',
        transportMode: 'Bicicleta',
        experienceInfo: 'Sí',
        experienceTime: '3 meses'
      },
      lastReplyIncludes: ['confirma estos datos'],
      lastReplyNotIncludes: ['requisitos registrados', 'te cuento sobre']
    }
  }, {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true
  });

  assert.ok(result.debugTraces[0].persisted_fields.includes('experienceSummary'));
});
