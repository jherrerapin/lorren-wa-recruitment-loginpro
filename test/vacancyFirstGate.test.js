import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FUTURE_PROFILE_CAPTURE_MODE,
  FUTURE_PROFILE_OFFER_MODE,
  PAUSED_VACANCY_OFFER_MODE,
  VacancyFirstGateAction,
  resolveVacancyFirstGate
} from '../src/services/vacancyFirstGate.js';

const ConversationStep = Object.freeze({
  MENU: 'MENU',
  GREETING_SENT: 'GREETING_SENT',
  COLLECTING_DATA: 'COLLECTING_DATA',
  DONE: 'DONE'
});

const ibagueOperation = { id: 'op-ibague', name: 'Operacion Ibague', city: { id: 'city-ibague', name: 'Ibague' } };
const bogotaOperation = { id: 'op-bogota', name: 'Operacion Bogota', city: { id: 'city-bogota', name: 'Bogota' } };
const neivaOperation = { id: 'op-neiva', name: 'Operacion Neiva', city: { id: 'city-neiva', name: 'Neiva' } };

function vacancy(overrides = {}) {
  return {
    id: 'vac-base',
    title: 'Auxiliar de Cargue y Descargue',
    role: 'Auxiliar de cargue y descargue',
    city: 'Ibague',
    operation: ibagueOperation,
    roleDescription: 'Apoyo operativo en cargue y descargue de mercancia.',
    requirements: 'Disponibilidad para labores operativas.',
    conditions: 'Condiciones registradas por operaciones.',
    isActive: true,
    acceptingApplications: true,
    ...overrides
  };
}

function candidate(overrides = {}) {
  return {
    id: 'cand-test',
    status: 'NUEVO',
    currentStep: ConversationStep.MENU,
    vacancyId: null,
    botResumeMode: null,
    ...overrides
  };
}

async function decide({ text, candidatePatch = {}, vacancies = [], activeVacancies = null, currentVacancy = null, recentMessages = [], attachmentContext = null }) {
  return resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate(candidatePatch),
    currentVacancy,
    inboundText: text,
    currentStep: candidatePatch.currentStep || ConversationStep.MENU,
    recentMessages,
    attachmentContext,
    vacancyHints: {
      allVacancies: vacancies,
      activeVacancies: activeVacancies ?? vacancies.filter((item) => item.isActive && item.acceptingApplications)
    }
  });
}

function assertNoPersonalDataRequest(reply = '') {
  assert.doesNotMatch(reply, /nombre|documento|edad|restric|transporte|hoja de vida|HV/i);
}

function assertNoPublicityOrPhoto(reply = '') {
  assert.doesNotMatch(reply, /publicidad|foto|imagen/i);
}

test('A: MENU + Ibagué + cargo claro resuelve y asigna vacante activa sin bloquear por MENU', async () => {
  const active = vacancy({ id: 'vac-post' });
  const decision = await decide({
    text: 'Buenas noches\n\nEstoy interesado en la vacante de cargue y descargue en la ciudad de Ibagué vivo en El Salado.',
    vacancies: [active]
  });

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.vacancyId, 'vac-post');
  assert.equal(decision.resolution.reason, 'matched_active_vacancy');
});

test('ibague-greeting: etapa inicial con saludo y cargo deja resolver vacante activa', async () => {
  const active = vacancy({ id: 'vac-ibague-greeting' });
  const decision = await decide({
    text: 'Buenas noches, te escribo desde Ibagué para la vacante de cargue y descargue',
    candidatePatch: { currentStep: ConversationStep.GREETING_SENT, stage: 'GREETING' },
    vacancies: [active]
  });

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.vacancyId, 'vac-ibague-greeting');
  assert.equal(decision.resolution.reason, 'matched_active_vacancy');
});

test('B/E: Bogotá ambiguo o bodega sin vacantes activas bloquea captura y ofrece registro futuro opcional', async () => {
  for (const text of [
    'Desde Bogotá tengo experiencia en lo que me pongan a desempeñar',
    'Escribo desde Bogotá para trabajo de bodega'
  ]) {
    const decision = await decide({
      text,
      candidatePatch: { currentStep: ConversationStep.GREETING_SENT },
      vacancies: [vacancy({ id: 'vac-ibague', city: 'Ibague', operation: ibagueOperation })]
    });

    assert.equal(decision.action, VacancyFirstGateAction.REPLY);
    assert.equal(decision.reason, 'CITY_WITHOUT_ACTIVE_VACANCIES');
    assert.equal(decision.candidateUpdates.botResumeMode, FUTURE_PROFILE_OFFER_MODE);
    assert.match(decision.reply, /no tengo vacantes activas|no veo operaciones activas/i);
    assert.match(decision.reply, /perfil registrado|futuras aperturas/i);
    assertNoPersonalDataRequest(decision.reply);
    assertNoPublicityOrPhoto(decision.reply);
  }
});

test('C: GREETING_SENT + Bogotá con vacantes activas pero cargo ambiguo pide localidad y cargo sin catálogo', async () => {
  const activeBogota = vacancy({
    id: 'vac-bog-active',
    title: 'Auxiliar de Bodega Bogota',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: bogotaOperation
  });
  const decision = await decide({
    text: 'Desde Bogotá',
    candidatePatch: { currentStep: ConversationStep.GREETING_SENT },
    vacancies: [activeBogota]
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'CITY_WITH_ACTIVE_VACANCIES_ROLE_AMBIGUOUS');
  assert.match(decision.reply, /localidad/i);
  assert.match(decision.reply, /cargo|vacante/i);
  assertNoPersonalDataRequest(decision.reply);
  assertNoPublicityOrPhoto(decision.reply);
});


test('Bogotá auxiliar de bodega conserva cargo detectado y no vuelve a pedir cargo', async () => {
  const morningBogota = vacancy({
    id: 'vac-bog-bodega-am',
    title: 'Auxiliar de Bodega Turno Mañana Bogota',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: bogotaOperation
  });
  const afternoonBogota = vacancy({
    id: 'vac-bog-bodega-pm',
    title: 'Auxiliar de Bodega Turno Tarde Bogota',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: bogotaOperation
  });
  const initialPrompt = 'Con gusto te ayudo. Para revisar una convocatoria real y no asumir una vacante, cuéntame desde qué ciudad nos escribes y qué cargo o vacante buscas.';

  const decision = await decide({
    text: 'Bogotá auxiliar de bodega',
    candidatePatch: { currentStep: ConversationStep.GREETING_SENT },
    recentMessages: [
      { direction: 'INBOUND', body: '¡Hola! Quiero más información.' },
      {
        direction: 'OUTBOUND',
        body: initialPrompt,
        createdAt: new Date(),
        rawPayload: {
          source: 'vacancy_first_gate',
          replyKind: 'ASK_CITY_AND_ROLE',
          reason: 'VACANCY_NOT_RESOLVED'
        }
      }
    ],
    vacancies: [morningBogota, afternoonBogota]
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'CITY_WITH_ACTIVE_VACANCIES_ROLE_AMBIGUOUS');
  assert.equal(decision.resolution.city, 'Bogota');
  assert.equal(decision.resolution.roleHint, 'auxiliar bodega');
  assert.match(decision.reply, /ya tengo la ciudad y el cargo/i);
  assert.match(decision.reply, /localidad/i);
  assert.doesNotMatch(decision.reply, /qué cargo|que cargo|cargo o vacante buscas/i);
});

test('Bogotá posterior no pierde el cargo ya dado en el turno anterior', async () => {
  const morningBogota = vacancy({
    id: 'vac-bog-bodega-am-repeat',
    title: 'Auxiliar de Bodega Turno Mañana Bogota',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: bogotaOperation
  });
  const afternoonBogota = vacancy({
    id: 'vac-bog-bodega-pm-repeat',
    title: 'Auxiliar de Bodega Turno Tarde Bogota',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: bogotaOperation
  });

  const decision = await decide({
    text: 'Bogotá',
    candidatePatch: { currentStep: ConversationStep.GREETING_SENT },
    recentMessages: [
      { direction: 'INBOUND', body: '¡Hola! Quiero más información.' },
      {
        direction: 'OUTBOUND',
        body: 'Con gusto te ayudo. Para revisar una convocatoria real y no asumir una vacante, cuéntame desde qué ciudad nos escribes y qué cargo o vacante buscas.',
        createdAt: new Date(Date.now() - 60_000),
        rawPayload: { source: 'vacancy_first_gate', replyKind: 'ASK_CITY_AND_ROLE', reason: 'VACANCY_NOT_RESOLVED' }
      },
      { direction: 'INBOUND', body: 'Bogotá auxiliar de bodega' }
    ],
    vacancies: [morningBogota, afternoonBogota]
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'CITY_WITH_ACTIVE_VACANCIES_ROLE_AMBIGUOUS');
  assert.equal(decision.resolution.city, 'Bogota');
  assert.equal(decision.resolution.roleHint, 'auxiliar bodega');
  assert.match(decision.reply, /localidad/i);
  assert.doesNotMatch(decision.reply, /qué cargo|que cargo|cargo o vacante buscas/i);
});

test('D: ciudad + cargo resuelven vacante activa en Neiva', async () => {
  const activeNeiva = vacancy({
    id: 'vac-neiva-cargue',
    title: 'Auxiliar de Cargue y Descargue Neiva',
    role: 'Auxiliar de cargue y descargue',
    city: 'Neiva',
    operation: neivaOperation
  });
  const decision = await decide({
    text: 'Estoy en Neiva, para auxiliar de cargue y descargue',
    vacancies: [activeNeiva]
  });

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.vacancyId, 'vac-neiva-cargue');
  assert.equal(decision.resolution.reason, 'matched_active_vacancy');
});

test('F: vacante compatible pausada sin evidencia específica no se asigna y ofrece registro futuro', async () => {
  const paused = vacancy({
    id: 'vac-bog-paused',
    title: 'Auxiliar de Bodega Bogota',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: bogotaOperation,
    acceptingApplications: false
  });
  const decision = await decide({ text: 'Estoy en Bogotá para auxiliar de bodega', vacancies: [paused], activeVacancies: [] });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'CITY_WITHOUT_ACTIVE_VACANCIES');
  assert.equal(decision.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.botResumeMode, FUTURE_PROFILE_OFFER_MODE);
  assert.match(decision.reply, /no tengo vacantes activas|no veo operaciones activas/i);
  assert.match(decision.reply, /futuras aperturas/i);
  assertNoPersonalDataRequest(decision.reply);
  assertNoPublicityOrPhoto(decision.reply);
});

test('G: aceptación posterior de registro futuro activa modo de captura sin prometer entrevista', async () => {
  const paused = vacancy({ id: 'vac-paused', acceptingApplications: false });
  const decision = await decide({
    text: 'Sí, quiero dejar mi hoja de vida registrada',
    candidatePatch: {
      vacancyId: 'vac-paused',
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: PAUSED_VACANCY_OFFER_MODE
    },
    currentVacancy: paused,
    vacancies: [paused],
    activeVacancies: []
  });

  assert.equal(decision.action, VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT);
  assert.equal(decision.candidateUpdates.botResumeMode, 'paused_vacancy_capture');
  assert.equal(decision.candidateUpdates.currentStep, ConversationStep.COLLECTING_DATA);
  assert.doesNotMatch(decision.reply, /entrevista|agend/i);
});

test('H: candidato completo con HV válida sin vacancyId no reabre ciudad/cargo ni pide datos', async () => {
  const completeCandidate = {
    status: 'REGISTRADO',
    currentStep: ConversationStep.DONE,
    fullName: 'Persona de prueba',
    documentType: 'CC',
    documentNumber: '100000',
    age: 30,
    neighborhood: 'Sector prueba',
    medicalRestrictions: 'Sin restricciones',
    transportMode: 'Transporte público',
    cvStorageKey: 'cv/test.pdf',
    cvMimeType: 'application/pdf',
    cvOriginalName: 'hv-test.pdf'
  };
  const decision = await decide({
    text: 'Buenas, quería saber del trabajo',
    candidatePatch: completeCandidate,
    vacancies: []
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'REGISTERED_COMPLETE_WITHOUT_VACANCY');
  assert.match(decision.reply, /registro.*hoja de vida|hoja de vida.*registro/i);
  assert.doesNotMatch(decision.reply, /ciudad|cargo|vacante|nombre|documento|edad/i);
});

test('I: ráfaga de adjuntos suprime respuesta duplicada si ya hubo guía reciente', async () => {
  const decision = await decide({
    text: '',
    attachmentContext: { isAttachment: true, kind: 'image' },
    recentMessages: [{
      direction: 'OUTBOUND',
      body: 'Envíame tu hoja de vida en PDF o Word/DOCX.',
      rawPayload: { situation: 'attachment_resume_photo', replyIntent: 'request_cv_pdf_word' }
    }],
    vacancies: []
  });

  assert.equal(decision.action, VacancyFirstGateAction.SUPPRESS_REPLY);
  assert.equal(decision.reason, 'RECENT_ATTACHMENT_GUIDANCE_ALREADY_SENT');
});

test('registro futuro por ciudad sin vacantes requiere aceptación contextual antes de capturar datos', async () => {
  const decision = await decide({
    text: 'Sí, quiero dejar mi hoja de vida registrada',
    candidatePatch: {
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: FUTURE_PROFILE_OFFER_MODE
    },
    vacancies: []
  });

  assert.equal(decision.action, VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT);
  assert.equal(decision.candidateUpdates.botResumeMode, FUTURE_PROFILE_CAPTURE_MODE);
  assert.equal(decision.candidateUpdates.currentStep, ConversationStep.COLLECTING_DATA);
  assert.doesNotMatch(decision.reply, /entrevista|agend/i);
});

test('Bogotá + auxiliar de bodega no resuelve Siberia inactiva ni persiste vacancyId', async () => {
  const inactiveSiberia = vacancy({
    id: 'vac-siberia-inactive',
    title: 'Auxiliar Cargue y Descargue Siberia',
    role: 'Auxiliar de cargue y descargue',
    city: 'Bogota',
    operation: bogotaOperation,
    operationAddress: 'Siberia',
    isActive: false,
    acceptingApplications: false
  });
  const decision = await decide({
    text: 'De Bogotá\nOuxiliar de bodega',
    candidatePatch: { currentStep: ConversationStep.GREETING_SENT },
    vacancies: [inactiveSiberia],
    activeVacancies: []
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'CITY_WITHOUT_ACTIVE_VACANCIES');
  assert.equal(decision.vacancyId, undefined);
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
});

test('acuse pasivo después de oferta de registro futuro no captura datos ni repite oferta', async () => {
  const decision = await decide({
    text: 'A bueno',
    candidatePatch: {
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: FUTURE_PROFILE_OFFER_MODE
    },
    recentMessages: [{
      direction: 'OUTBOUND',
      body: 'No hay vacantes activas. Puedo dejar tu perfil registrado si confirmas.',
      createdAt: new Date(),
      rawPayload: {
        source: 'vacancy_first_gate',
        replyKind: 'NO_ACTIVE_VACANCIES_FOR_CITY',
        reason: 'CITY_WITHOUT_ACTIVE_VACANCIES'
      }
    }],
    vacancies: []
  });

  assert.equal(decision.action, VacancyFirstGateAction.SUPPRESS_REPLY);
  assert.equal(decision.reason, 'PASSIVE_ACK_AFTER_FUTURE_PROFILE_OFFER');
});

test('sí confirmo después de oferta de registro futuro entra a captura contextual', async () => {
  const decision = await decide({
    text: 'Si confirmó',
    candidatePatch: {
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: FUTURE_PROFILE_OFFER_MODE
    },
    recentMessages: [{
      direction: 'OUTBOUND',
      body: 'No hay vacantes activas. Puedo dejar tu perfil registrado si confirmas.',
      createdAt: new Date(),
      rawPayload: {
        source: 'vacancy_first_gate',
        replyKind: 'NO_ACTIVE_VACANCIES_FOR_CITY',
        reason: 'CITY_WITHOUT_ACTIVE_VACANCIES'
      }
    }],
    vacancies: []
  });

  assert.equal(decision.action, VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT);
  assert.equal(decision.candidateUpdates.botResumeMode, FUTURE_PROFILE_CAPTURE_MODE);
  assert.equal(decision.candidateUpdates.currentStep, ConversationStep.COLLECTING_DATA);
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
});

test('prevención de repetición bloquea mismo replyKind y reason sin información nueva', async () => {
  const decision = await decide({
    text: 'ok',
    candidatePatch: { currentStep: ConversationStep.GREETING_SENT },
    recentMessages: [{
      direction: 'OUTBOUND',
      body: 'Con gusto te ayudo con ciudad y cargo.',
      createdAt: new Date(),
      rawPayload: {
        source: 'vacancy_first_gate',
        replyKind: 'ASK_CITY_AND_ROLE',
        reason: 'VACANCY_NOT_RESOLVED'
      }
    }],
    vacancies: []
  });

  assert.equal(decision.action, VacancyFirstGateAction.SUPPRESS_REPLY);
  assert.equal(decision.reason, 'REPEAT_PREVENTED');
});

test('vacante inactiva explícita en Siberia responde oferta futura sin candidateUpdates.vacancyId', async () => {
  const inactiveSiberia = vacancy({
    id: 'vac-siberia-inactive-explicit',
    title: 'Auxiliar Cargue y Descargue Siberia',
    role: 'Auxiliar de cargue y descargue',
    city: 'Bogota',
    operation: bogotaOperation,
    operationAddress: 'Siberia',
    isActive: false,
    acceptingApplications: false
  });
  const decision = await decide({
    text: 'Estoy para auxiliar de bodega en Siberia',
    candidatePatch: { currentStep: ConversationStep.GREETING_SENT },
    vacancies: [inactiveSiberia],
    activeVacancies: []
  });

  assert.equal(decision.action, VacancyFirstGateAction.INACTIVE_VACANCY_REPLY);
  assert.equal(decision.replyKind, 'INACTIVE_VACANCY_FUTURE_PROFILE_OFFER');
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.equal(decision.vacancyId, undefined);
});
