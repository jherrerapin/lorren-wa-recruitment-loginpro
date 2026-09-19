import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildParitySnapshot,
  runConversationCase
} from './helpers/conversationHarness.js';
import { processText } from '../src/routes/webhook.js';
import { createDebugTrace } from '../src/services/debugTrace.js';
import { looksLikeNoMedicalRestrictionsText } from '../src/services/candidateData.js';
import { baseOperations, baseVacancies } from './fixtures/conversationCases.js';

test('el candidato de lanzamiento reutiliza el harness integral canónico', () => {
  assert.equal(typeof runConversationCase, 'function');
  assert.equal(typeof buildParitySnapshot, 'function');
});

test('replay #901: una negación gramatical imperfecta completa restricciones médicas', async () => {
  const result = await runConversationCase({
    id: 'audit-901-natural-no-medical-restrictions',
    steps: ['Ningún restricción médica'],
    candidate: {
      id: 'candidate-audit-medical',
      phone: '573000000907',
      status: 'NUEVO',
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-post',
      fullName: 'Persona Prueba',
      documentType: 'CC',
      documentNumber: 'TEST-901-0007',
      age: 29,
      gender: 'UNKNOWN',
      neighborhood: 'Zona Prueba',
      locality: null,
      medicalRestrictions: null,
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
        medicalRestrictions: 'Sin restricciones médicas',
        currentStep: 'ASK_CV'
      },
      lastReplyIncludes: ['hoja de vida'],
      lastReplyNotIncludes: ['restricciones medicas']
    }
  }, {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true
  });

  assert.equal(result.debugTraces[0].persisted_fields.includes('medicalRestrictions'), true);
});

test('normaliza concordancia y plural sin convertir una restricción declarada en ausencia', () => {
  for (const text of ['Ningún restricción médica', 'Ninguna restricciones médicas', 'Ninguno restricción médica']) {
    assert.equal(looksLikeNoMedicalRestrictionsText(text), true, text);
  }
  assert.equal(looksLikeNoMedicalRestrictionsText('Tengo una restricción médica'), false);
});
