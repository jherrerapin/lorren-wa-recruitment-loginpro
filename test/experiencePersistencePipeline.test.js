import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidateFields, parseNaturalData } from '../src/services/candidateData.js';
import { captureConsentedProfileData } from '../src/services/consentProfileCapture.js';
import { conversationUnderstanding } from '../src/services/conversationUnderstanding.js';
import { getCandidateReadiness } from '../src/services/readinessGuard.js';

const EXPERIENCE_VACANCY = Object.freeze({
  id: 'vacancy-experience-test',
  experienceRequired: 'YES',
  experienceTimeText: '1 año o más'
});

const COMPLETE_BASE_CANDIDATE = Object.freeze({
  vacancyId: EXPERIENCE_VACANCY.id,
  fullName: 'Persona Ejemplo',
  documentType: 'CC',
  documentNumber: '10000000',
  age: 30,
  neighborhood: 'Barrio Ejemplo',
  medicalRestrictions: 'Sin restricciones médicas',
  transportMode: 'Moto'
});

const EXPERIENCE_PENDING_FIELDS = Object.freeze([
  'experiencia (si o no)',
  'tiempo de experiencia (1 año o más)',
  'en qué tiene experiencia'
]);

function experienceAiResult(text) {
  return {
    status: 'ok',
    intent: 'provide_data',
    parsedFields: {
      experienceInfo: 'Sí',
      experienceSummary: text
    },
    extraction: {
      turnType: 'DATA',
      fieldEvidence: {
        experienceInfo: { snippet: text, confidence: 0.99, source: 'openai' },
        experienceSummary: { snippet: text, confidence: 0.99, source: 'openai' }
      }
    },
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  };
}

test('el parser local conserva experiencia natural con flexiones laborales', () => {
  for (const text of [
    'He trabajado como coordinador operativo liderando equipos de logística y transporte.',
    'Experiencia en operaciones logísticas y coordinación de equipos.',
    'Coordinación de operaciones logísticas durante la jornada.'
  ]) {
    const normalized = normalizeCandidateFields(parseNaturalData(text));
    assert.equal(normalized.experienceInfo, 'Sí', text);
    assert.equal(normalized.experienceSummary, text, text);
  }
});

test('una pregunta concreta en el mismo turno no borra la experiencia declarada', () => {
  const parsed = normalizeCandidateFields(parseNaturalData(
    'Tengo experiencia en logística y coordinación de equipos. ¿Cuál es el horario de la vacante?'
  ));

  assert.equal(parsed.experienceInfo, 'Sí');
  assert.equal(parsed.experienceSummary, 'Tengo experiencia en logística y coordinación de equipos.');
});

test('el parser local no convierte una pregunta de requisitos en experiencia del candidato', () => {
  const parsed = normalizeCandidateFields(parseNaturalData('¿Qué experiencia logística requiere la vacante?'));

  assert.equal(parsed.experienceInfo, undefined);
  assert.equal(parsed.experienceSummary, undefined);
});

test('una frase de búsqueda de cargo no se convierte en experiencia del candidato', () => {
  const parsed = normalizeCandidateFields(parseNaturalData('Desde Bogotá para trabajo de bodega'));

  assert.equal(parsed.experienceInfo, undefined);
  assert.equal(parsed.experienceSummary, undefined);
});

test('una pregunta de experiencia junto al consentimiento no se persiste como perfil laboral', async () => {
  const candidate = {
    id: 'candidate-synthetic-experience-question',
    dataConsentStatus: 'ACCEPTED',
    experienceInfo: null,
    experienceSummary: null
  };
  let writeAttempted = false;
  const prisma = {
    candidate: {
      updateMany: async () => {
        writeAttempted = true;
        return { count: 1 };
      },
      findUnique: async () => candidate
    }
  };

  const result = await captureConsentedProfileData({
    prisma,
    candidate,
    vacancy: { city: 'Neiva' },
    currentText: 'Autorizo el tratamiento de mis datos. ¿Qué experiencia logística requiere la vacante?'
  });

  assert.equal(writeAttempted, false);
  assert.equal(result.reason, 'no_new_profile_data');
  assert.deepEqual(result.capturedFields, []);
});

test('la experiencia explícita atraviesa interpretación y sanitización sin volver a quedar pendiente', async () => {
  const text = 'He trabajado como coordinador operativo liderando equipos de logística y transporte.';

  const result = await conversationUnderstanding(text, {
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: EXPERIENCE_PENDING_FIELDS
    },
    aiResult: experienceAiResult(text)
  });

  assert.equal(result.candidateFields.experienceInfo, 'Sí');
  assert.equal(result.candidateFields.experienceSummary, text);

  const readiness = getCandidateReadiness({
    ...COMPLETE_BASE_CANDIDATE,
    ...result.candidateFields,
    experienceTime: '3 años'
  }, EXPERIENCE_VACANCY, { requireCv: false });

  assert.equal(readiness.missingFields.includes('experienceSummary'), false);
  assert.deepEqual(readiness.missingFields, []);
});

test('una respuesta descriptiva interpretada conserva el resumen laboral', async () => {
  const text = 'Experiencia en operaciones logísticas y coordinación de equipos.';
  const result = await conversationUnderstanding(text, {
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: EXPERIENCE_PENDING_FIELDS
    },
    aiResult: experienceAiResult(text)
  });

  assert.equal(result.candidateFields.experienceInfo, 'Sí');
  assert.equal(result.candidateFields.experienceSummary, text);
});

test('una pregunta sobre requisitos de experiencia no se persiste como experiencia del candidato', async () => {
  const result = await conversationUnderstanding('¿Qué experiencia logística requiere la vacante?', {
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: EXPERIENCE_PENDING_FIELDS
    }
  });

  assert.equal(result.candidateFields.experienceSummary, undefined);
});

test('un no genérico no se convierte en experiencia cuando la última pregunta era de otro campo', async () => {
  const result = await conversationUnderstanding('no', {
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: ['barrio', 'experiencia (si o no)', 'en qué tiene experiencia'],
      lastBotQuestion: '¿En qué barrio vives?'
    },
    aiResult: {
      status: 'disabled',
      intent: 'unknown',
      parsedFields: {},
      extraction: { turnType: 'CONFIRMATION', fieldEvidence: {} },
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    },
    runtime: {
      localParsedData: {},
      engineFields: {},
      engineUsage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      fallbackIntent: 'continue_application',
      enrichFields: (fields) => fields
    }
  });

  assert.equal(result.turnInterpretation.fields.experienceInfo, undefined);
});
