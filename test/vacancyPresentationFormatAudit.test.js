import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConversationSession } from '../src/services/conversationAudit.js';

test('la ficha estructurada de vacante conserva el formato profesional sin falsas alertas', () => {
  const candidate = {
    id: 'candidate-format',
    currentStep: 'GREETING_SENT',
    status: 'NUEVO',
    vacancy: {
      title: 'Líder de Operación', city: 'Neiva',
      roleDescription: 'Liderar y administrar personal operativo',
      requirements: 'Técnico o tecnólogo en logística',
      conditions: 'Turnos rotativos y prestaciones de ley',
      operationAddress: 'Sector Las Brisas', minAge: 23, maxAge: 45,
      experienceRequired: 'YES', experienceTimeText: 'mínimo 6 meses'
    }
  };
  const messages = [{
    id: 'out-1', candidateId: candidate.id, direction: 'OUTBOUND', messageType: 'TEXT',
    createdAt: new Date('2026-08-08T15:00:00Z'),
    body: '*Vacante: Líder de Operación*\n\nCiudad: Neiva\n\nZona de trabajo: Sector Las Brisas\n\n*Funciones*\nLiderar y administrar personal operativo.\n\n*Requisitos*\nTécnico o tecnólogo en logística.\nEdad: 23 a 45 años.\nExperiencia: Mínimo 6 meses.\n\n*Condiciones*\nTurnos rotativos y prestaciones de ley.\n\n¿Te interesa continuar con esta vacante? Si es así, confírmame y seguimos con la postulación.',
    rawPayload: { source: 'vacancy_first_gate', replyKind: 'ACTIVE_VACANCY_INTEREST_PROMPT' },
    candidate
  }];
  const result = analyzeConversationSession(messages, { now: new Date('2026-08-08T15:01:00Z'), checkCurrentState: false });
  const codes = new Set(result.issues.map((issue) => issue.code));
  assert.equal(codes.has('EXCESSIVE_LENGTH'), false);
  assert.equal(codes.has('VACANCY_INFO_SKIPPED'), false);
  assert.equal(codes.has('MARKDOWN_OR_LIST'), false);
});