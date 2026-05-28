import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAttachment } from '../src/services/attachmentAnalyzer.js';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';
import { buildVacancyOptionsReply, buildUnavailableVacancyInfoReply } from '../src/services/naturalReply.js';
import { sanitizeOutboundReply } from '../src/services/replySafety.js';
import { getCandidateReadiness, hasValidCv } from '../src/services/readinessGuard.js';
import { evaluateSchedulingGuard } from '../src/services/schedulingGuard.js';
import { resolveVacancyFromText } from '../src/services/vacancyResolver.js';

const ConversationStep = {
  ASK_CV: 'ASK_CV',
  CONFIRMING_DATA: 'CONFIRMING_DATA',
  COLLECTING_DATA: 'COLLECTING_DATA',
  SCHEDULING: 'SCHEDULING',
  SCHEDULED: 'SCHEDULED',
};
const Gender = { MALE: 'MALE', FEMALE: 'FEMALE' };

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

const nextSlot = { slot: { id: 'slot-1' }, date: new Date('2026-06-01T15:00:00.000Z'), windowOk: true };

test('A: pregunta por vacantes en ciudad no lista catalogo ni pide HV', () => {
  const reply = buildVacancyOptionsReply({
    city: 'Bogota',
    vacancyOptions: [
      activeBogota({ title: 'Auxiliar de Cargue Bogota' }),
      activeBogota({ id: 'vac-2', title: 'Auxiliar de Bodega Bogota' }),
      activeBogota({ id: 'vac-3', title: 'Mensajero Ibague', role: 'Mensajero', city: 'Ibague', operation: { city: { name: 'Ibague' } }, isActive: true })
    ]
  });

  assert.match(reply, /cargo|vacante|referencia/i);
  assert.doesNotMatch(reply, /publicidad|foto|imagen/i);
  assert.doesNotMatch(reply, /Auxiliar de Cargue Bogota/);
  assert.doesNotMatch(reply, /Auxiliar de Bodega Bogota/);
  assert.doesNotMatch(reply, /Mensajero Ibague/);
  assert.doesNotMatch(reply, /cu[aá]l de esas|opciones activas|tengo disponible/i);
  assert.doesNotMatch(reply, /hoja de vida|HV|PDF|DOCX/i);
});

test('A2: resolver usa funciones de la vacante como evidencia sin inventar cargo literal', async () => {
  const maquilaVacancy = activeBogota({
    id: 'vac-maquila',
    title: 'Auxiliar Operativo Ibague',
    role: 'Auxiliar operativo',
    city: 'Ibague',
    operation: { city: { name: 'Ibague' }, name: 'Operacion Ibague' },
    roleDescription: 'Apoyo en maquila, empaque y alistamiento de producto terminado.'
  });
  const coordinatorVacancy = activeBogota({
    id: 'vac-coord',
    title: 'Coordinador Logistico Ibague',
    role: 'Coordinador logistico',
    city: 'Ibague',
    operation: { city: { name: 'Ibague' }, name: 'Operacion Ibague' },
    roleDescription: 'Coordinacion de rutas y supervision de personal operativo.'
  });

  const resolution = await resolveVacancyFromText(null, 'Es para maquila en Ibague', {
    allVacancies: [maquilaVacancy, coordinatorVacancy],
    activeVacancies: [maquilaVacancy, coordinatorVacancy]
  });

  assert.equal(resolution.resolved, true);
  assert.equal(resolution.vacancy.id, 'vac-maquila');
  assert.equal(resolution.roleHint, 'maquila');
});

test('A3: cargo inexistente no se toma como vacante real', async () => {
  const resolution = await resolveVacancyFromText(null, 'Estoy interesado en vigilante en Ibague', {
    allVacancies: [activeBogota({
      id: 'vac-aux',
      title: 'Auxiliar Operativo Ibague',
      role: 'Auxiliar operativo',
      city: 'Ibague',
      operation: { city: { name: 'Ibague' }, name: 'Operacion Ibague' },
      roleDescription: 'Apoyo en cargue, descargue y empaque.'
    })],
    activeVacancies: [activeBogota({
      id: 'vac-aux',
      title: 'Auxiliar Operativo Ibague',
      role: 'Auxiliar operativo',
      city: 'Ibague',
      operation: { city: { name: 'Ibague' }, name: 'Operacion Ibague' },
      roleDescription: 'Apoyo en cargue, descargue y empaque.'
    })]
  });

  assert.equal(resolution.resolved, false);
  assert.notEqual(resolution.reason, 'matched_active_vacancy');
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

test('C: readiness bloquea DONE con documentType faltante', () => {
  const readiness = getCandidateReadiness(
    candidate({ documentType: null, currentStep: ConversationStep.CONFIRMING_DATA }),
    activeBogota()
  );

  assert.equal(readiness.readyForDone, false);
  assert.match(readiness.blockedReasons.join('|'), /missing_core_fields:documentType/);
});

test('D: schedulingGuard bloquea offer_interview sin HV', () => {
  const guard = evaluateSchedulingGuard({
    candidate: candidate({ cvStorageKey: null, cvMimeType: null, cvOriginalName: null }),
    vacancy: activeBogota(),
    nextSlot,
    actionType: 'offer_interview'
  });

  assert.equal(guard.allowed, false);
  assert.match(guard.reasons.join('|'), /missing_cv/);
});


test('HV .doc o storage sin MIME/nombre PDF/DOCX no cuenta como CV válido', () => {
  assert.equal(hasValidCv(candidate({ cvMimeType: 'application/msword', cvOriginalName: 'hoja-vida.doc' })), false);
  assert.equal(hasValidCv(candidate({ cvStorageKey: 'cv/cand-1', cvMimeType: null, cvOriginalName: null })), false);
  assert.equal(hasValidCv(candidate({ cvStorageKey: null, cvData: null, cvMimeType: 'application/pdf', cvOriginalName: 'hoja-vida.pdf' })), false);
  assert.equal(hasValidCv(candidate({ cvStorageKey: 'cv/cand-1.bin', cvMimeType: 'application/octet-stream', cvOriginalName: 'hoja-vida.docx' })), true);
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


test('confirm_booking sin acceptedOfferedSlot explícito queda bloqueado aunque lo sugiera la IA', () => {
  const guard = evaluateSchedulingGuard({
    candidate: candidate(),
    vacancy: activeBogota(),
    nextSlot,
    actionType: 'confirm_booking'
  });

  assert.equal(guard.allowed, false);
  assert.match(guard.reasons.join('|'), /candidate_did_not_accept_offered_slot/);
});

test('guard rail: confirm_booking con documentType faltante, candidata femenina o sin slot queda bloqueado', () => {
  for (const [label, candidatePatch, slot, expected] of [
    ['documentType', { documentType: null }, nextSlot, /missing_fields:documentType/],
    ['female', { gender: Gender.FEMALE }, nextSlot, /female_candidate/],
    ['slot', {}, null, /missing_valid_slot/]
  ]) {
    const guard = evaluateSchedulingGuard({
      candidate: candidate(candidatePatch),
      vacancy: activeBogota(),
      nextSlot: slot,
      actionType: 'confirm_booking',
      acceptedOfferedSlot: true
    });
    assert.equal(guard.allowed, false, label);
    assert.match(guard.reasons.join('|'), expected, label);
  }
});
