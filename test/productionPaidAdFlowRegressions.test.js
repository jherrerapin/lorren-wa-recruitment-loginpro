import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveVacancyFirstGate, VacancyFirstGateAction } from '../src/services/vacancyFirstGate.js';
import { isAffirmativeVacancyConfirmation, APPLICATION_INTEREST_PENDING_MODE, DATA_CONSENT_PENDING_MODE } from '../src/services/dataConsentGate.js';
import { isApplicationFollowUpQuestion, processText } from '../src/routes/webhook.js';
import { resolveCampaignForReferral } from '../src/services/campaignAttribution.js';
import { getMultilineWindowMs } from '../src/services/multiline.js';
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

test('Meta: campaign_name exacto puede resolver IDs nuevos sin usar ad_name difuso', () => {
  const campaigns = [
    { id: 'camp-neiva', code: 'INTERNO-NEIVA', name: 'Líder Operación Neiva Agosto 2026' },
    { id: 'camp-otra', code: 'INTERNO-OTRA', name: 'Otra campaña' }
  ];
  const exact = resolveCampaignForReferral(campaigns, { referral: {
    campaign_id: '120999999999', ad_id: '238999999999', campaign_name: 'Líder Operación Neiva Agosto 2026', ad_name: 'Anuncio cualquiera'
  }});
  assert.equal(exact.campaign.id, 'camp-neiva');
  assert.equal(exact.matchMode, 'campaign_name_exact_with_objective_metadata');

  const unsafe = resolveCampaignForReferral(campaigns, { referral: {
    campaign_id: '120999999999', ad_id: '238999999999', ad_name: 'Líder Operación Neiva Agosto 2026'
  }});
  assert.equal(unsafe.campaign, null);
  assert.equal(unsafe.reason, 'objective_metadata_without_exact_campaign_match');
});

test('latencia: configuración heredada de 60s queda limitada a máximo 20s', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousReasoning = process.env.LORREN_REASONING_WINDOW_MS;
  process.env.NODE_ENV = 'production';
  process.env.LORREN_REASONING_WINDOW_MS = '60000';
  try {
    assert.equal(getMultilineWindowMs(), 20000);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousReasoning === undefined) delete process.env.LORREN_REASONING_WINDOW_MS; else process.env.LORREN_REASONING_WINDOW_MS = previousReasoning;
  }
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
  assert.match(decision.reply, /Antes de recibir o guardar datos personales/i);
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
    recognizeCurrentEnginePrompt: true
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


test('replay #901: structured experience label inside data block is not treated as question', async () => {
  const candidate = {
    id: 'candidate-replay-structured-data',
    status: 'IN_PROCESS',
    stage: 'collecting_data',
    full_name: null,
    email: null,
    age: null,
    city: null,
    experience: null,
    transport: null,
    document_number: null,
    cv_url: null,
    selected_vacancy_id: 'vacancy-1',
  };

  const { deps, outboundMessages } = createDeps({
    candidate,
    parsedFields: {
      fullName: 'Nombre Seudónimo',
      email: 'persona@example.invalid',
      age: 31,
      city: 'Ciudad Ejemplo',
      experience: 'Dos años en ventas',
      transport: 'Transporte público',
      documentNumber: 'DOC-SEUDONIMO',
    },
  });
  const { handleIncomingMessage } = createIncomingMessageHandler(deps);

  const result = await handleIncomingMessage({
    channel: 'whatsapp',
    from: '+00000000000',
    text: [
      'Nombre: Nombre Seudónimo',
      'Correo: persona@example.invalid',
      'Edad: 31',
      'Ciudad: Ciudad Ejemplo',
      'Qué experiencia tengo: Dos años en ventas',
      'Transporte: Transporte público',
      'Documento: DOC-SEUDONIMO',
    ].join('\n'),
    messageId: 'msg-replay-structured-data',
  });

  assert.equal(result.ok, true);
  assert.equal(candidate.full_name, 'Nombre Seudónimo');
  assert.equal(candidate.experience, 'Dos años en ventas');
  assert.doesNotMatch(outboundMessages.at(-1)?.text || '', /requisitos de la vacante/i);
});
