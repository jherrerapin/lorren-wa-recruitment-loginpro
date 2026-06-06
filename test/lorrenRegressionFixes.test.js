import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import { installOpenAIMock } from './helpers/mockOpenAI.js';
import { buildFutureSlot } from './helpers/mockScheduler.js';
import { analyzeAttachment } from '../src/services/attachmentAnalyzer.js';
import { isCvMimeTypeAllowed } from '../src/services/cvFlow.js';
import { alignCandidateLocationFields, normalizeCandidateFields, parseNaturalData } from '../src/services/candidateData.js';

process.env.NODE_ENV = 'test';
process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
process.env.META_ACCESS_TOKEN = 'meta-access-token';
process.env.USE_CONVERSATION_ENGINE = 'false';
delete process.env.OPENAI_API_KEY;

const { processText, guardReplyWithConversationState } = await import('../src/routes/webhook.js');
const { createDebugTrace } = await import('../src/services/debugTrace.js');

const OP_BOG = {
  id: 'op-bogota',
  name: 'Montevideo',
  city: { id: 'city-bogota', name: 'Bogota' }
};

const BODEGA_VACANCY = {
  id: 'vac-bodega-bogota',
  title: 'Auxiliar Cargue y Descargue Bogota',
  role: 'Auxiliar Cargue y Descargue',
  city: 'Bogota',
  operationId: OP_BOG.id,
  operation: OP_BOG,
  operationAddress: 'Zona industrial de Montevideo',
  interviewAddress: 'Calle 80 # 10-20',
  requirements: 'Mayor de edad y disponibilidad para trabajo operativo',
  conditions: 'Proceso con entrevista',
  roleDescription: 'Apoyo en cargue, descargue y bodega',
  requiredDocuments: 'Hoja de vida Minerva 1003 o impresa, como la tenga, y cédula original',
  acceptingApplications: true,
  isActive: true,
  schedulingEnabled: true,
  updatedAt: new Date('2026-05-29T10:00:00.000Z')
};

function candidate(overrides = {}) {
  return {
    id: 'candidate-1',
    phone: '573001112233',
    status: 'NUEVO',
    currentStep: 'GREETING_SENT',
    vacancyId: null,
    fullName: null,
    documentType: null,
    documentNumber: null,
    age: null,
    gender: 'UNKNOWN',
    locality: null,
    neighborhood: null,
    medicalRestrictions: null,
    transportMode: null,
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null,
    reminderState: 'PENDING',
    reminderScheduledFor: null,
    botPaused: false,
    botPausedAt: null,
    botPauseReason: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    createdAt: new Date('2026-05-29T10:00:00.000Z'),
    ...overrides
  };
}

test('persiste la vacante cuando el candidato ya dio ciudad y cargo en GREETING_SENT', async () => {
  const prisma = createMockPrisma({
    candidates: [candidate()],
    vacancies: [BODEGA_VACANCY],
    operations: [OP_BOG]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    const fresh = await prisma.candidate.findUnique({ where: { id: 'candidate-1' } });
    const debugTrace = createDebugTrace({ phone: fresh.phone, currentStepBefore: fresh.currentStep });
    await processText(prisma, fresh, fresh.phone, 'Hola para auxiliar bodega Bogota', debugTrace, {});

    const updated = await prisma.candidate.findUnique({ where: { id: 'candidate-1' } });
    assert.equal(updated.vacancyId, BODEGA_VACANCY.id);
    assert.doesNotMatch(whatsappMock.sentMessages.at(-1).body, /desde que ciudad|desde qué ciudad/i);
  } finally {
    restoreAxios();
  }
});

test('la confirmación de entrevista no se reemplaza por pedir HV cuando documentos sensibles vienen de la vacante', async () => {
  const prisma = createMockPrisma({
    candidates: [candidate({
      currentStep: 'SCHEDULING',
      vacancyId: BODEGA_VACANCY.id,
      fullName: 'German Eduardo Lopez Lozano',
      documentType: 'CC',
      documentNumber: '2230488',
      age: 45,
      locality: 'Suba',
      medicalRestrictions: 'Sin condiciones medicas',
      transportMode: 'bicicleta',
      cvData: Buffer.from('%PDF-1.1\n'),
      cvOriginalName: 'HVBogota26.pdf',
      cvMimeType: 'application/pdf'
    })],
    vacancies: [BODEGA_VACANCY],
    operations: [OP_BOG],
    interviewSlots: [buildFutureSlot({ vacancyId: BODEGA_VACANCY.id, id: 'slot-1', hoursFromNow: 24 })]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    const fresh = await prisma.candidate.findUnique({ where: { id: 'candidate-1' } });
    const debugTrace = createDebugTrace({ phone: fresh.phone, currentStepBefore: fresh.currentStep });
    await processText(prisma, fresh, fresh.phone, 'Si puedo ir', debugTrace, {});

    const lastReply = whatsappMock.sentMessages.at(-1).body;
    assert.equal(prisma.state.interviewBookings.length, 1);
    assert.match(lastReply, /entrevista|agendada|recibida/i);
    assert.doesNotMatch(lastReply, /No puedo registrarla|env[ií]ame tu hoja de vida como archivo PDF/i);
  } finally {
    restoreAxios();
  }
});

test('acepta hojas de vida .doc además de PDF y DOCX', async () => {
  assert.equal(isCvMimeTypeAllowed('application/msword', 'hv.doc'), true);
  assert.equal(isCvMimeTypeAllowed('application/octet-stream', 'hv.doc'), true);

  const analysis = await analyzeAttachment({
    buffer: Buffer.from('legacy word bytes'),
    mimeType: 'application/msword',
    filename: 'hv.doc'
  });

  assert.equal(analysis.classification, 'CV_VALID');
});


test('guard de estado evita pedir ciudad, vacante o residencia ya registradas', async () => {
  const prisma = createMockPrisma({
    candidates: [candidate({
      vacancyId: BODEGA_VACANCY.id,
      locality: 'Suba',
      documentType: 'CC',
      documentNumber: '2230488',
      age: 45,
      medicalRestrictions: 'Sin condiciones medicas',
      transportMode: 'bicicleta'
    })],
    vacancies: [BODEGA_VACANCY],
    operations: [OP_BOG]
  });

  const guarded = await guardReplyWithConversationState(
    prisma,
    'candidate-1',
    'Gracias por escribir. ¿Desde qué ciudad nos escribes, para qué vacante y en qué localidad estás?',
    { source: 'bot_flow' }
  );

  assert.equal(guarded.blocked, true);
  assert.deepEqual(guarded.blockedReasons, [
    'resolved_vacancy_requested_again',
    'resolved_residence_requested_again'
  ]);
  assert.match(guarded.text, /Ya tengo registrado/i);
  assert.match(guarded.text, /nombre completo/i);
  assert.doesNotMatch(guarded.text, /Desde qué ciudad|para qué vacante|localidad estás/i);
});

test('guard de estado evita pedir HV cuando ya hay hoja de vida válida', async () => {
  const prisma = createMockPrisma({
    candidates: [candidate({
      vacancyId: BODEGA_VACANCY.id,
      fullName: 'German Eduardo Lopez Lozano',
      documentType: 'CC',
      documentNumber: '2230488',
      age: 45,
      locality: 'Suba',
      medicalRestrictions: 'Sin condiciones medicas',
      transportMode: 'bicicleta',
      cvData: Buffer.from('%PDF-1.1\n'),
      cvOriginalName: 'HVBogota26.pdf',
      cvMimeType: 'application/pdf'
    })],
    vacancies: [BODEGA_VACANCY],
    operations: [OP_BOG]
  });

  const guarded = await guardReplyWithConversationState(
    prisma,
    'candidate-1',
    'Para continuar, envíame tu hoja de vida como archivo PDF, DOC o DOCX.',
    { source: 'bot_flow' }
  );

  assert.equal(guarded.blocked, true);
  assert.deepEqual(guarded.blockedReasons, ['resolved_cv_requested_again']);
  assert.match(guarded.text, /hoja de vida/i);
  assert.doesNotMatch(guarded.text, /env[ií]ame tu hoja de vida como archivo/i);
});


test('conserva una localidad explícita de Bogotá aunque no esté en alias estáticos', () => {
  const parsed = parseNaturalData('Localidad de Usaquen');
  const normalized = normalizeCandidateFields(parsed);
  const aligned = alignCandidateLocationFields(normalized, BODEGA_VACANCY, { clearAlternate: false });

  assert.equal(aligned.locality, 'Usaquén');
});

test('registra bloque completo de datos y no vuelve a pedir campos ya dados', async () => {
  const prisma = createMockPrisma({
    candidates: [candidate({
      currentStep: 'COLLECTING_DATA',
      vacancyId: BODEGA_VACANCY.id,
      cvData: Buffer.from('%PDF-1.1\n'),
      cvOriginalName: 'HOJA DE VIDA ACTUALIZADA.pdf',
      cvMimeType: 'application/pdf'
    })],
    vacancies: [BODEGA_VACANCY],
    operations: [OP_BOG],
    interviewSlots: [buildFutureSlot({ vacancyId: BODEGA_VACANCY.id, id: 'slot-datos-completos', hoursFromNow: 24 })]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    const fresh = await prisma.candidate.findUnique({ where: { id: 'candidate-1' } });
    const debugTrace = createDebugTrace({ phone: fresh.phone, currentStepBefore: fresh.currentStep });
    await processText(
      prisma,
      fresh,
      fresh.phone,
      'Oscar Eduardo Londoño Rodríguez\nC.c 1014259322\nEdad 31 años\nLocalidad de Usaquen\nNo tengo restricciones médicas\nY me movilizó en bicicleta',
      debugTrace,
      {}
    );

    const updated = await prisma.candidate.findUnique({ where: { id: 'candidate-1' } });
    const lastReply = whatsappMock.sentMessages.at(-1).body;

    assert.equal(updated.fullName, 'Oscar Eduardo Londoño Rodríguez');
    assert.equal(updated.documentType, 'CC');
    assert.equal(updated.documentNumber, '1014259322');
    assert.equal(updated.age, 31);
    assert.equal(updated.locality, 'Usaquén');
    assert.equal(updated.medicalRestrictions, 'Sin restricciones médicas');
    assert.equal(updated.transportMode, 'Bicicleta');
    assert.doesNotMatch(lastReply, /me queda pendiente|falt(?:a|an).*nombre completo|falt(?:a|an).*tipo de documento|falt(?:a|an).*localidad|falt(?:a|an).*restricciones/i);
  } finally {
    restoreAxios();
  }
});