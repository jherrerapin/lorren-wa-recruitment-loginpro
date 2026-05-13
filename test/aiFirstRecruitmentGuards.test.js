import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep, Gender } from '@prisma/client';
import { analyzeAttachment } from '../src/services/attachmentAnalyzer.js';
import { act } from '../src/services/conversationEngine.js';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';
import { buildVacancyOptionsReply, buildUnavailableVacancyInfoReply } from '../src/services/naturalReply.js';
import { sanitizeOutboundReply } from '../src/services/replySafety.js';
import { getCandidateReadiness } from '../src/services/readinessGuard.js';

const bogotaOperation = { city: { name: 'Bogota' }, name: 'Bogota' };
const activeBogota = (overrides = {}) => ({
  id: 'vac-1',
  title: 'Auxiliar de Cargue Bogota',
  role: 'Auxiliar de cargue',
  city: 'Bogota',
  operation: bogotaOperation,
  isActive: true,
  acceptingApplications: true,
  schedulingEnabled: true,
  ...overrides
});

function candidate(overrides = {}) {
  return {
    id: 'cand-1',
    vacancyId: 'vac-1',
    currentStep: ConversationStep.ASK_CV,
    fullName: 'Carlos Perez',
    documentType: 'CC',
    documentNumber: '1000',
    age: 28,
    locality: 'Suba',
    medicalRestrictions: 'Sin restricciones medicas',
    transportMode: 'Bus',
    gender: Gender.MALE,
    cvStorageKey: 'cv/cand-1.pdf',
    cvMimeType: 'application/pdf',
    ...overrides
  };
}

function prismaMock() {
  const updates = [];
  let bookingCreated = false;
  return {
    updates,
    get bookingCreated() { return bookingCreated; },
    candidate: {
      update: async (args) => { updates.push(args); return { id: args.where.id, ...args.data }; }
    },
    interviewBooking: {
      findFirst: async () => null,
      create: async () => { bookingCreated = true; return {}; },
      updateMany: async () => ({ count: 0 })
    }
  };
}

const nextSlot = { slot: { id: 'slot-1' }, date: new Date('2026-06-01T15:00:00.000Z'), windowOk: true };

test('A: pregunta por vacantes en ciudad lista solo opciones reales y no pide HV', () => {
  const reply = buildVacancyOptionsReply({
    city: 'Bogota',
    vacancyOptions: [
      activeBogota({ title: 'Auxiliar de Cargue Bogota' }),
      activeBogota({ id: 'vac-2', title: 'Auxiliar de Bodega Bogota' }),
      activeBogota({ id: 'vac-3', title: 'Mensajero Ibague', city: 'Ibague', operation: { city: { name: 'Ibague' } }, isActive: false })
    ]
  });

  assert.match(reply, /Auxiliar de Cargue Bogota/);
  assert.match(reply, /Auxiliar de Bodega Bogota/);
  assert.doesNotMatch(reply, /Mensajero Ibague/);
  assert.doesNotMatch(reply, /hoja de vida|HV|PDF|DOCX/i);
  assert.doesNotMatch(reply, /no tengo visible/i);
});

test('B y F: información de vacante no inventa condiciones ni prestaciones sin dato registrado', () => {
  const noConditions = activeBogota({ conditions: null, requirements: 'Ser mayor de edad' });
  const reply = buildUnavailableVacancyInfoReply(noConditions);
  assert.match(reply, /no lo tengo registrado/i);
  assert.match(reply, /Ser mayor de edad/);
  assert.doesNotMatch(reply, /prestaciones de ley|contrato directo|pagos quincenales/i);

  const unsafe = sanitizeOutboundReply({ reply: 'Sí, tiene prestaciones de ley y pagos quincenales.', vacancy: noConditions });
  assert.equal(unsafe.blocked, true);
  assert.doesNotMatch(unsafe.reply, /Sí, tiene prestaciones de ley/i);
});

test('C: IA intenta DONE con documentType faltante y backend bloquea cierre', async () => {
  const prisma = prismaMock();
  const result = await act({
    prisma,
    candidate: candidate({ documentType: null, currentStep: ConversationStep.CONFIRMING_DATA }),
    vacancy: activeBogota(),
    nextSlot,
    actions: [{ type: 'nothing' }],
    nextStep: ConversationStep.DONE
  });

  assert.equal(result.readiness.readyForDone, false);
  assert.match(result.blockedActions.at(-1).reason, /done_blocked/);
  assert.equal(prisma.updates.some((u) => u.data.currentStep === ConversationStep.DONE), false);
  assert.equal(prisma.updates.at(-1).data.currentStep, ConversationStep.COLLECTING_DATA);
});

test('D: IA intenta offer_interview sin HV y backend bloquea agenda', async () => {
  const prisma = prismaMock();
  const result = await act({
    prisma,
    candidate: candidate({ cvStorageKey: null, cvMimeType: null, cvOriginalName: null }),
    vacancy: activeBogota(),
    nextSlot,
    actions: [{ type: 'offer_interview' }],
    nextStep: ConversationStep.SCHEDULING
  });

  assert.equal(prisma.bookingCreated, false);
  assert.match(result.blockedActions[0].reason, /missing_cv/);
  assert.equal(prisma.updates.some((u) => u.data.currentStep === ConversationStep.SCHEDULING), false);
});

test('E: HV imagen no cuenta como CV válido y seguridad pide PDF/DOCX', async () => {
  const analysis = await analyzeAttachment({ buffer: Buffer.from('fake'), mimeType: 'image/jpeg', filename: 'hv.jpg' });
  const readiness = getCandidateReadiness(candidate({ cvStorageKey: 'cv/hv.jpg', cvMimeType: 'image/jpeg' }), activeBogota());
  const safe = sanitizeOutboundReply({ reply: 'Puedes enviarme la hoja de vida en foto clara.' });

  assert.equal(analysis.classification, 'CV_IMAGE_ONLY');
  assert.equal(readiness.hasValidCv, false);
  assert.equal(safe.blocked, true);
  assert.match(safe.reply, /PDF o Word\/DOCX/i);
});

test('G: cortesía “Sii señora claro” no marca género femenino ni agenda', () => {
  const result = sanitizeCandidateFieldsForConversation({
    fields: { gender: 'FEMALE' },
    evidence: { gender: { snippet: 'señora', confidence: 0.95, source: 'engine' } },
    text: 'Sii señora claro',
    context: { currentStep: ConversationStep.SCHEDULING },
    turnType: null
  });

  assert.equal(result.fields.gender, undefined);
  assert.equal(result.rejectedFields.find((item) => item.field === 'gender').reason, 'courtesy_treatment_is_not_candidate_gender');
});

test('guard rail: confirm_booking con documentType faltante, candidata femenina o sin slot queda bloqueado', async () => {
  for (const [label, candidatePatch, slot, expected] of [
    ['documentType', { documentType: null }, nextSlot, /missing_fields:documentType/],
    ['female', { gender: Gender.FEMALE }, nextSlot, /female_candidate/],
    ['slot', {}, null, /missing_valid_slot/]
  ]) {
    const prisma = prismaMock();
    const result = await act({
      prisma,
      candidate: candidate(candidatePatch),
      vacancy: activeBogota(),
      nextSlot: slot,
      actions: [{ type: 'confirm_booking' }],
      nextStep: ConversationStep.SCHEDULED
    });
    assert.equal(prisma.bookingCreated, false, label);
    assert.match(result.blockedActions.map((item) => item.reason).join('|'), expected, label);
    assert.equal(prisma.updates.some((u) => u.data.currentStep === ConversationStep.SCHEDULED), false, label);
  }
});
