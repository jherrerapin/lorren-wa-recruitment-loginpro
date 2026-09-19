import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildParitySnapshot,
  runConversationCase
} from './helpers/conversationHarness.js';
import { processText } from '../src/routes/webhook.js';
import { createDebugTrace } from '../src/services/debugTrace.js';
import {
  alignCandidateLocationFields,
  getCandidateResidenceValue,
  parseNaturalData
} from '../src/services/candidateData.js';
import { baseOperations, baseVacancies } from './fixtures/conversationCases.js';

test('el candidato de lanzamiento reutiliza el harness integral canónico', () => {
  assert.equal(typeof runConversationCase, 'function');
  assert.equal(typeof buildParitySnapshot, 'function');
});

test('replay #901: un municipio explícito completa la residencia de una vacante de Bogotá', async () => {
  const result = await runConversationCase({
    id: 'audit-901-explicit-municipality-residence',
    steps: ['Localidad: Villa Prueba Cundinamarca'],
    candidate: {
      id: 'candidate-audit-municipality',
      phone: '573000000906',
      status: 'NUEVO',
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-sched',
      fullName: 'Persona Prueba',
      documentType: 'CC',
      documentNumber: 'TEST-901-0006',
      age: 29,
      gender: 'UNKNOWN',
      neighborhood: null,
      locality: null,
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Bicicleta',
      experienceInfo: null,
      experienceTime: null,
      experienceSummary: null,
      cvData: null,
      cvOriginalName: null,
      cvMimeType: null,
      reminderState: 'NONE',
      reminderScheduledFor: null,
      botPaused: false,
      botPausedAt: null,
      botPauseReason: null,
      botResumeMode: null,
      dataConsentStatus: 'ACCEPTED',
      dataConsentVersion: 'lorren-v2-2026-07-v3',
      lastInboundAt: null,
      lastOutboundAt: null,
      createdAt: new Date('2026-09-01T12:00:00.000Z')
    },
    vacancies: baseVacancies,
    operations: baseOperations,
    expect: {
      candidate: {
        neighborhood: 'Villa Prueba Cundinamarca',
        locality: null,
        currentStep: 'ASK_CV'
      },
      lastReplyIncludes: ['hoja de vida'],
      lastReplyNotIncludes: ['localidad']
    }
  }, {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true
  });

  assert.equal(result.debugTraces[0].persisted_fields.includes('neighborhood'), true);
});

test('la residencia municipal explícita no depende de una lista cerrada ni acepta un cargo como municipio', () => {
  const vacancy = { city: 'Bogota' };
  for (const text of ['Localidad: Villa Prueba Cundinamarca', 'Villa Prueba Cundinamarca']) {
    const fields = alignCandidateLocationFields(parseNaturalData(text), vacancy);
    assert.equal(getCandidateResidenceValue(fields, vacancy), 'Villa Prueba Cundinamarca', text);
  }

  const invalid = alignCandidateLocationFields(parseNaturalData('Auxiliar Cundinamarca'), vacancy);
  assert.equal(getCandidateResidenceValue(invalid, vacancy), null);
});
