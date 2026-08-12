import test from 'node:test';
import assert from 'node:assert/strict';
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
