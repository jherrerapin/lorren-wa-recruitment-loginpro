import test from 'node:test';
import assert from 'node:assert/strict';
import { processText } from '../src/routes/webhook.js';
import { createDebugTrace } from '../src/services/debugTrace.js';
import { baseOperations, baseVacancies } from './fixtures/conversationCases.js';
import {
  buildParitySnapshot,
  runConversationCase
} from './helpers/conversationHarness.js';

test('el candidato de lanzamiento reutiliza el harness integral canónico', () => {
  assert.equal(typeof runConversationCase, 'function');
  assert.equal(typeof buildParitySnapshot, 'function');
});


test('replay #901: responde seguimiento de postulación y retoma el dato realmente pendiente', async () => {
  const result = await runConversationCase({
    id: 'audit-901-application-followup-pending-name',
    steps: ['¿Cuándo me contactan para el trabajo?'],
    candidate: {
      id: 'candidate-audit-901-status',
      phone: '573000000904',
      status: 'NUEVO',
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-post',
      fullName: null,
      documentType: 'CC',
      documentNumber: '1000000000',
      age: 29,
      gender: 'UNKNOWN',
      neighborhood: 'Jordan',
      locality: null,
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Bicicleta',
      experienceInfo: 'Sí',
      experienceTime: '3 meses',
      experienceSummary: 'Auxiliar de bodega',
      cvData: Buffer.from('pdf'),
      cvOriginalName: 'perfil.pdf',
      cvMimeType: 'application/pdf',
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
        currentStep: 'COLLECTING_DATA',
        fullName: null
      },
      lastReplyIncludes: ['aún no puedo confirmar cuándo', 'nombre completo'],
      lastReplyNotIncludes: ['Funciones del cargo', 'Requisitos', 'Condiciones']
    }
  }, {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true
  });

  assert.equal(result.debugTraces[0].contextual_response_gate.semanticIntent, 'ASK_APPLICATION_STATUS');
  assert.equal(result.debugTraces[0].vacancy_first_gate, undefined);
});
