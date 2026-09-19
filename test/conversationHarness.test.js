import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildParitySnapshot,
  runConversationCase
} from './helpers/conversationHarness.js';
import { processText } from '../src/routes/webhook.js';
import { createDebugTrace } from '../src/services/debugTrace.js';
import { normalizeBogotaLocalidad } from '../src/services/geographyNormalization.js';
import { baseOperations, baseVacancies } from './fixtures/conversationCases.js';

test('el candidato de lanzamiento reutiliza el harness integral canónico', () => {
  assert.equal(typeof runConversationCase, 'function');
  assert.equal(typeof buildParitySnapshot, 'function');
});

test('replay #901: una localidad inequívoca dentro de un sector compuesto completa la residencia', async () => {
  const result = await runConversationCase({
    id: 'audit-901-locality-with-sector',
    steps: ['Localidad: Suba Sector Prueba'],
    candidate: {
      id: 'candidate-audit-locality',
      phone: '573000000908',
      status: 'NUEVO',
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-sched',
      fullName: 'Persona Prueba',
      documentType: 'CC',
      documentNumber: 'TEST-901-0008',
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
      candidate: { locality: 'Suba', currentStep: 'ASK_CV' },
      lastReplyIncludes: ['hoja de vida'],
      lastReplyNotIncludes: ['localidad']
    }
  }, {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true
  });

  assert.equal(result.debugTraces[0].persisted_fields.includes('locality'), true);
});

test('la localidad embebida exige una única coincidencia canónica', () => {
  assert.equal(normalizeBogotaLocalidad('Suba Sector Prueba'), 'Suba');
  assert.equal(normalizeBogotaLocalidad('Suba o Engativá'), null);
  assert.equal(normalizeBogotaLocalidad('Bogotá Sector Prueba'), null);
});
