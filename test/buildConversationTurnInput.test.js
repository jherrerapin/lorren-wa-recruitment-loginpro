import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWebhookPayload } from '../src/infrastructure/transport/metaAdapter.js';
import { calculateConversationDecision } from '../src/core/engine/calculateConversationDecision.js';
import {
  buildConversationTurnInput,
  ConversationTurnInputBuildError
} from '../src/core/middlewares/buildConversationTurnInput.js';

function inbound(overrides = {}) {
  return {
    messageId: 'wamid.input-1',
    from: '573001112233',
    timestamp: '2026-09-23T12:00:00.000Z',
    type: 'text',
    text: 'Me llamo Ana',
    payload: null,
    ...overrides
  };
}

function unresolvedCandidate(overrides = {}) {
  return baseCandidate({
    vacancyId: null,
    vacancy: null,
    recruitmentCity: null,
    recruitmentRole: null,
    ...overrides
  });
}

test('tráfico orgánico nuevo pregunta ciudad y vacante sin consultar campañas', async () => {
  const input = await buildConversationTurnInput(inbound(), dependencies({
    candidate: unresolvedCandidate()
  }));
  assert.equal(input.vacancy, null);
  assert.equal(input.attribution.source, 'ORGANIC');
  assert.deepEqual(input.pending.fields, ['recruitmentCity', 'recruitmentRole', 'vacancyId']);
  const decision = await calculateConversationDecision(input);
  assert.deepEqual(decision.reply, { directive: 'ASK_CITY_AND_VACANCY' });
});

test('ciudad recibida en un turno queda como hecho canónico y deja pendiente solo el cargo/vacante', async () => {
  const input = await buildConversationTurnInput(inbound({
    text: 'Estoy en Bogotá',
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      detectedFields: { cityHint: 'Bogotá' }
    }
  }), dependencies({ candidate: unresolvedCandidate() }));

  assert.equal(input.candidate.facts.recruitmentCity, 'Bogotá');
  assert.equal(input.interpretation.fields.recruitmentCity, 'Bogotá');
  assert.deepEqual(input.pending.fields, ['recruitmentRole', 'vacancyId']);
  assert.deepEqual((await calculateConversationDecision(input)).reply, {
    directive: 'ASK_VACANCY_FOR_CITY',
    parameters: { city: 'Bogotá' }
  });
});

test('cargo recibido primero queda como hecho canónico y deja pendiente ciudad/vacante', async () => {
  const input = await buildConversationTurnInput(inbound({
    text: 'Auxiliar de cargue y descargue',
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      detectedFields: { roleHint: 'Auxiliar de cargue y descargue' }
    }
  }), dependencies({ candidate: unresolvedCandidate() }));

  assert.equal(input.candidate.facts.recruitmentRole, 'Auxiliar de cargue y descargue');
  assert.equal(input.interpretation.fields.recruitmentRole, 'Auxiliar de cargue y descargue');
  assert.deepEqual(input.pending.fields, ['recruitmentCity', 'vacancyId']);
  assert.deepEqual((await calculateConversationDecision(input)).reply, {
    directive: 'ASK_CITY_FOR_ROLE',
    parameters: { role: 'Auxiliar de cargue y descargue' }
  });
});

test('tráfico orgánico enriquecido por NLU entra al núcleo con la vacante resuelta', async () => {
  const vacancy = baseCandidate().vacancy;
  const input = await buildConversationTurnInput(inbound({
    resolvedVacancy: vacancy,
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      extractedFields: { vacancyId: vacancy.id },
      detectedFields: { roleHint: 'bodega', cityHint: 'Bogotá' }
    }
  }), dependencies({ candidate: unresolvedCandidate() }));

  assert.equal(input.attribution.source, 'ORGANIC');
  assert.equal(input.vacancy.id, vacancy.id);
  assert.equal(input.vacancy.requiredDocuments, 'Hoja de vida física y cédula original');
  assert.equal(input.candidate.facts.vacancyId, vacancy.id);
  assert.equal(input.candidate.facts.vacancyCity, 'Bogotá');
  assert.equal(input.candidate.facts.recruitmentCity, 'Bogotá');
  assert.equal(input.candidate.facts.recruitmentRole, vacancy.role);
  assert.equal(input.interpretation.extractedFields.vacancyId, vacancy.id);
});

test('una vacante persistida vuelve a cruzar la frontera del core en turnos posteriores', async () => {
  const candidate = baseCandidate();
  const input = await buildConversationTurnInput(inbound({ text: '¿Cuál es el horario?' }), dependencies({ candidate }));

  assert.equal(input.vacancy.id, candidate.vacancy.id);
  assert.equal(input.vacancy.city, 'Bogotá');
  assert.equal(input.candidate.facts.vacancyId, candidate.vacancy.id);
});

test('referral normalizado resuelve el ad_id mediante Campaign.code y consolida contexto', async () => {
  const vacancy = baseCandidate().vacancy;
  const message = parseWebhookPayload({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{
      id: 'wamid.ad', from: '573001112233', type: 'text', text: { body: 'Hola' },
      referral: { ad_id: '12345', headline: 'Anuncio', unsafe: { value: true } }
    }] } }] }]
  });
  assert.deepEqual(message.referral, { ad_id: '12345', headline: 'Anuncio' });
  const deps = dependencies({ candidate: unresolvedCandidate() });
  deps.prisma.campaign = { async findMany() {
    return [{ id: 'campaign-1', code: '12345', vacancy }];
  } };
  const input = await buildConversationTurnInput(message, deps);
  assert.equal(input.attribution.source, 'META_ADS');
  assert.equal(input.vacancy.id, vacancy.id);
  assert.equal(input.candidate.facts.vacancyRole, vacancy.role);
  assert.equal(input.candidate.facts.recruitmentCity, vacancy.city);
  assert.equal(input.candidate.facts.recruitmentRole, vacancy.role);
});

test('anuncio desconocido no asigna una vacante por coincidencia accidental de titular', async () => {
  const deps = dependencies({ candidate: unresolvedCandidate() });
  deps.prisma.campaign = { async findMany() { return []; } };
  const input = await buildConversationTurnInput(inbound({
    referral: { ad_id: 'unknown', headline: 'Auxiliar de bodega' }
  }), deps);
  assert.equal(input.attribution.source, 'META_ADS');
  assert.equal(input.vacancy, null);
  assert.deepEqual(
    (await calculateConversationDecision(input)).reply,
    { directive: 'ASK_CITY_AND_VACANCY' }
  );
});

test('titular exacto y único resuelve vacante cuando no hay ID publicitario', async () => {
  const vacancy = baseCandidate().vacancy;
  const deps = dependencies({ candidate: unresolvedCandidate() });
  deps.prisma.campaign = { async findMany() { return []; } };
  deps.prisma.vacancy = { async findMany() { return [vacancy]; } };
  const input = await buildConversationTurnInput(inbound({ referral: { headline: vacancy.title } }), deps);
  assert.equal(input.vacancy.id, vacancy.id);
});

function baseCandidate(overrides = {}) {
  return {
    id: 'candidate-1',
    phone: '573001112233',
    vacancyId: 'vacancy-1',
    recruitmentCity: 'Bogotá',
    recruitmentRole: 'Auxiliar de bodega',
    vacancy: {
      id: 'vacancy-1',
      title: 'Auxiliar de bodega',
      role: 'Auxiliar de bodega',
      city: 'Bogotá',
      minAge: 18,
      maxAge: 45,
      experienceRequired: 'YES',
      experienceTimeText: 'mínimo 6 meses',
      requiredDocuments: 'Hoja de vida física y cédula original',
      schedulingEnabled: true,
      isActive: true,
      acceptingApplications: true
    },
    dataConsentStatus: 'PENDING',
    status: 'NUEVO',
    currentStep: 'MENU',
    gender: 'UNKNOWN',
    botPaused: false,
    botResumeMode: null,
    updatedAt: new Date('2026-09-23T11:00:00.000Z'),
    ...overrides
  };
}

function dependencies({ candidate = baseCandidate(), messages = [], onCreate } = {}) {
  return {
    prisma: {
      candidate: {
        async findUnique() {
          return candidate;
        },
        async create(args) {
          if (onCreate) return onCreate(args);
          return baseCandidate({ phone: args.data.phone });
        }
      },
      message: {
        async findMany(args) {
          assert.equal(args.take, 20);
          return messages;
        }
      }
    }
  };
}

test('carga candidato, vacante e historial reales en el contrato estricto', async () => {
  const input = await buildConversationTurnInput(inbound({
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      providedFields: { fullName: 'Ana Pérez' }
    }
  }), dependencies({
    messages: [
      {
        direction: 'INBOUND',
        body: 'Me llamo Ana',
        createdAt: new Date('2026-09-23T11:59:00.000Z')
      },
      {
        direction: 'OUTBOUND',
        body: '¿Cuál es tu nombre?',
        createdAt: new Date('2026-09-23T11:58:00.000Z')
      }
    ]
  }));

  assert.equal(input.candidate.id, 'candidate-1');
  assert.equal(input.candidate.facts.phone, '573001112233');
  assert.equal(input.candidate.facts.currentStep, 'MENU');
  assert.equal(input.candidate.facts.recruitmentCity, 'Bogotá');
  assert.equal(input.candidate.facts.recruitmentRole, 'Auxiliar de bodega');
  assert.equal(input.candidate.facts.vacancyRole, 'Auxiliar de bodega');
  assert.equal(input.candidate.facts.vacancyCity, 'Bogotá');
  assert.equal(input.candidate.facts.minAge, 18);
  assert.equal(input.candidate.facts.maxAge, 45);
  assert.equal(input.candidate.facts.experienceRequired, 'YES');
  assert.equal(input.candidate.facts.experienceTime, 'mínimo 6 meses');
  assert.equal(input.candidate.facts.candidateExperienceTime, undefined);
  assert.equal(input.candidate.facts.schedulingEnabled, true);
  assert.equal(input.candidate.facts.locationType, 'localidad');
  assert.deepEqual(input.pending.fields, ['dataConsent']);
  assert.deepEqual(input.history.messages.map(({ role }) => role), ['assistant', 'user']);
  assert.equal(input.history.lastBotQuestion, '¿Cuál es tu nombre?');
  assert.equal(input.history.lastBotReplyIdentity, 'text:¿cuál es tu nombre?');
  assert.equal(input.interpretation.intent, 'PROVIDE_CANDIDATE_DATA');
  assert.deepEqual(input.execution, {
    mayReply: true,
    mayPersistCandidate: true,
    maySendOutbound: true
  });
});

test('recupera la directiva original del último outbound como identidad anti-repetición', async () => {
  const input = await buildConversationTurnInput(inbound(), dependencies({
    candidate: unresolvedCandidate({ recruitmentCity: 'Bogotá' }),
    messages: [{
      direction: 'OUTBOUND',
      body: '¿Qué vacante viste?',
      rawPayload: { directive: 'ASK_VACANCY_FOR_CITY' },
      createdAt: new Date('2026-09-23T11:59:00.000Z')
    }]
  }));

  assert.equal(input.history.lastBotReplyIdentity, 'directive:ASK_VACANCY_FOR_CITY');
});

test('conserva hechos e historial previos junto con la extracción del turno actual', async () => {
  const candidate = baseCandidate({
    dataConsentStatus: 'ACCEPTED',
    fullName: 'Ana Pérez',
    locality: 'Fontibón'
  });
  const input = await buildConversationTurnInput(inbound({
    text: 'Mi documento es 1000123456',
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      providedFields: { documentNumber: '1000123456' }
    }
  }), dependencies({
    candidate,
    messages: [
      { direction: 'OUTBOUND', body: '¿Cuál es tu número de documento?', createdAt: new Date('2026-09-23T11:58:00.000Z') },
      { direction: 'INBOUND', body: 'Vivo en Fontibón', createdAt: new Date('2026-09-23T11:57:00.000Z') }
    ]
  }));

  assert.equal(input.candidate.facts.fullName, 'Ana Pérez');
  assert.equal(input.candidate.facts.locality, 'Fontibón');
  assert.equal(input.history.lastBotQuestion, '¿Cuál es tu número de documento?');
  assert.deepEqual(input.history.messages.map(({ text }) => text), [
    'Vivo en Fontibón',
    '¿Cuál es tu número de documento?'
  ]);
  assert.equal(input.interpretation.providedFields.documentNumber, '1000123456');
  assert.ok(input.pending.fields.includes('documentNumber'));
});

test('usa el género interpretado cuando todavía no está consolidado en el candidato', async () => {
  const input = await buildConversationTurnInput(inbound({
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      detectedFields: { gender: 'FEMALE' }
    }
  }), dependencies());

  assert.equal(input.candidate.facts.gender, 'FEMALE');
});

test('detecta género por lenguaje autorreferido aunque el extractor semántico no lo aporte', async () => {
  const input = await buildConversationTurnInput(inbound({
    text: 'Hola, estoy interesada en la vacante'
  }), dependencies());

  assert.equal(input.candidate.facts.gender, 'FEMALE');
  assert.equal(input.interpretation.detectedFields.gender, 'FEMALE');
});

test('no confunde un tratamiento de cortesía con el género del candidato', async () => {
  const input = await buildConversationTurnInput(inbound({
    text: 'Sí señora, muchas gracias'
  }), dependencies());

  assert.equal(input.candidate.facts.gender, 'UNKNOWN');
  assert.equal(input.interpretation, undefined);
});

test('no infiere una abreviatura aunque exista una pregunta histórica de género', async () => {
  const input = await buildConversationTurnInput(inbound({ text: 'F' }), dependencies({
    messages: [{
      direction: 'OUTBOUND',
      body: '¿Con qué género te identificas?',
      createdAt: new Date('2026-09-23T11:59:00.000Z')
    }]
  }));

  assert.equal(input.candidate.facts.gender, 'UNKNOWN');
  assert.equal(input.interpretation, undefined);
});

test('mapea un evento durable del sistema sin tratarlo como texto del candidato', async () => {
  const input = await buildConversationTurnInput(inbound({
    messageId: 'system:inactivity:candidate-1:cycle-1',
    type: 'system',
    isSystemAction: true,
    intent: 'INACTIVITY_REMINDER',
    text: 'este texto no debe entrar al núcleo'
  }), dependencies());

  assert.equal(input.turn.rawText, '[SYSTEM_EVENT]');
  assert.deepEqual(input.interpretation, { intent: 'INACTIVITY_REMINDER' });
});

test('crea un candidato base cuando el teléfono todavía no existe', async () => {
  let createdWith = null;
  const deps = dependencies({ candidate: null });
  deps.prisma.candidate.create = async (args) => {
    createdWith = args;
    return unresolvedCandidate({
      id: 'candidate-new',
      phone: args.data.phone
    });
  };

  const input = await buildConversationTurnInput(inbound(), deps);

  assert.deepEqual(createdWith, {
    data: { phone: '573001112233' },
    include: { vacancy: true }
  });
  assert.equal(input.candidate.id, 'candidate-new');
  assert.equal(input.candidate.facts.phone, '573001112233');
  assert.deepEqual(input.pending.fields, ['recruitmentCity', 'recruitmentRole', 'vacancyId']);
});

test('tolera una carrera de creación consultando el candidato ganador', async () => {
  let findCalls = 0;
  const winner = baseCandidate({ id: 'candidate-winner' });
  const deps = dependencies();
  deps.prisma.candidate.findUnique = async () => {
    findCalls += 1;
    return findCalls === 1 ? null : winner;
  };
  deps.prisma.candidate.create = async () => {
    const error = new Error('Unique constraint failed');
    error.code = 'P2002';
    throw error;
  };

  const input = await buildConversationTurnInput(inbound(), deps);

  assert.equal(input.candidate.id, 'candidate-winner');
  assert.equal(findCalls, 2);
});

test('deriva campos pendientes reales cuando el consentimiento ya fue aceptado', async () => {
  const candidate = baseCandidate({
    dataConsentStatus: 'ACCEPTED',
    fullName: 'Ana Pérez',
    documentType: 'CC',
    documentNumber: '1000123456',
    age: 28,
    neighborhood: 'Modelia',
    locality: 'Fontibón',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    experienceInfo: 'Sí',
    experienceTime: '1 año',
    experienceSummary: 'Experiencia en bodega',
    cvOriginalName: 'hv.pdf',
    cvMimeType: 'application/pdf',
    cvStorageKey: 'candidate/hv.pdf'
  });

  const input = await buildConversationTurnInput(inbound(), dependencies({ candidate }));

  assert.deepEqual(input.pending.fields, []);
  assert.equal(input.candidate.facts.consentGranted, true);
  assert.equal(input.candidate.facts.candidateExperienceTime, '1 año');
});

test('un CV procesado en el turno actual deja de estar pendiente sin pre-escritura', async () => {
  const candidate = baseCandidate({
    dataConsentStatus: 'ACCEPTED',
    fullName: 'Ana Pérez',
    documentType: 'CC',
    documentNumber: '1000123456',
    age: 28,
    neighborhood: 'Modelia',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    experienceInfo: 'Sí',
    experienceTime: '1 año',
    experienceSummary: 'Experiencia en bodega'
  });

  const input = await buildConversationTurnInput(inbound({
    type: 'document',
    text: '',
    media: {
      mediaId: 'media-cv-current-turn',
      mimeType: 'application/pdf',
      fileName: 'hv.pdf',
      extractedText: 'Experiencia laboral verificable de prueba.',
      status: 'processed'
    }
  }), dependencies({ candidate }));

  assert.equal(input.attachments.current[0].status, 'processed');
  assert.equal(input.attachments.items[0].isCv, true);
  assert.equal(input.attachments.hasCv, true);
  assert.equal(input.pending.fields.includes('cv'), false);
});

test('un turno mixto conserva texto, datos interpretados y CV procesado en un solo contrato', async () => {
  const candidate = baseCandidate({
    dataConsentStatus: 'ACCEPTED',
    fullName: 'Ana Pérez',
    documentType: 'CC',
    documentNumber: '1000123456',
    age: null,
    neighborhood: 'Modelia',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    experienceInfo: 'Sí',
    experienceTime: '1 año',
    experienceSummary: 'Experiencia en bodega'
  });
  const rawText = 'Tengo 30 años y adjunto mi hoja de vida';
  const input = await buildConversationTurnInput(inbound({
    type: 'document',
    text: rawText,
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      fields: { age: 30 }
    },
    media: {
      mediaId: 'media-mixed-turn',
      mimeType: 'application/pdf',
      fileName: 'hv.pdf',
      extractedText: 'Experiencia laboral verificable.',
      status: 'processed'
    }
  }), dependencies({ candidate }));

  assert.equal(input.turn.rawText, rawText);
  assert.equal(input.turn.messageType, 'document');
  assert.equal(input.interpretation.fields.age, 30);
  assert.equal(input.attachments.hasCv, true);
  assert.equal(input.pending.fields.includes('cv'), false);
});

test('un documento fallido conserva el CV pendiente y no crea evidencia fantasma', async () => {
  const candidate = baseCandidate({ dataConsentStatus: 'ACCEPTED' });
  const input = await buildConversationTurnInput(inbound({
    type: 'document',
    text: 'Adjunto mi hoja de vida',
    media: {
      mediaId: 'media-failed-turn',
      mimeType: 'application/pdf',
      fileName: 'hv.pdf',
      extractedText: null,
      status: 'failed'
    }
  }), dependencies({ candidate }));

  assert.equal(input.attachments.current[0].status, 'failed');
  assert.equal(input.attachments.items[0].isCv, false);
  assert.equal(input.attachments.hasCv, false);
  assert.equal(input.pending.fields.includes('cv'), true);
});

test('lanza un error descriptivo cuando los datos de Prisma rompen el contrato', async () => {
  const invalidCandidate = baseCandidate({ id: null });

  await assert.rejects(
    buildConversationTurnInput(inbound(), dependencies({ candidate: invalidCandidate })),
    (error) => error instanceof ConversationTurnInputBuildError
      && error.issues.some((issue) => issue.path.join('.') === 'candidate.id')
  );
});
