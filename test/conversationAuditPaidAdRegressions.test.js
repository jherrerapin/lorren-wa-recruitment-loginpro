import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConversationSession } from '../src/services/conversationAudit.js';

function candidate(overrides = {}) {
  return {
    id: 'cand-audit-paid',
    currentStep: 'COLLECTING_DATA',
    status: 'NUEVO',
    botPaused: false,
    dataConsentAcceptedAt: null,
    gender: 'MALE',
    interviewBookings: [],
    vacancy: {
      id: 'vac-neiva',
      title: 'Líder de Operación',
      city: 'Neiva',
      roleDescription: 'Liderar y administrar equipos de trabajo',
      requirements: 'Técnico o tecnólogo en Logística',
      conditions: 'Salario a convenir y turnos rotativos',
      operationAddress: 'Sector Las Brisas',
      schedulingEnabled: false
    },
    ...overrides
  };
}

function message(id, minute, direction, body, rawPayload, cand) {
  return {
    id,
    candidateId: cand.id,
    direction,
    messageType: 'TEXT',
    body,
    rawPayload: rawPayload || {},
    createdAt: new Date(Date.UTC(2026, 7, 8, 13, minute)),
    candidate: cand
  };
}

function codes(result) {
  return new Set(result.issues.map((issue) => issue.code));
}

test('auditor: detecta vacante identificada sin entregar información configurada', () => {
  const cand = candidate({ dataConsentAcceptedAt: new Date(Date.UTC(2026, 7, 8, 13, 0)) });
  const result = analyzeConversationSession([
    message('1', 20, 'INBOUND', 'Neiva líder de operaciones', {}, cand),
    message('2', 21, 'OUTBOUND', 'Encontré la vacante de Líder de Operación en Neiva. ¿Deseas postularte y continuar con este proceso?', {
      source: 'vacancy_first_gate',
      replyKind: 'ACTIVE_VACANCY_INTEREST_PROMPT'
    }, cand)
  ], { now: new Date(Date.UTC(2026, 7, 8, 13, 22)), checkCurrentState: false });
  assert.equal(codes(result).has('VACANCY_INFO_SKIPPED'), true);
});

test('auditor: detecta solicitud de datos anterior al consentimiento aceptado', () => {
  const cand = candidate({ dataConsentAcceptedAt: new Date(Date.UTC(2026, 7, 8, 13, 30)) });
  const result = analyzeConversationSession([
    message('1', 20, 'INBOUND', 'Esa si', {}, cand),
    message('2', 21, 'OUTBOUND', 'Perfecto. Para avanzar, compárteme nombre completo, número de documento y edad.', {
      source: 'vacancy_first_gate',
      replyKind: 'ACTIVE_VACANCY_DATA_PROMPT'
    }, cand)
  ], { now: new Date(Date.UTC(2026, 7, 8, 13, 22)), checkCurrentState: false });
  assert.equal(codes(result).has('CONSENT_SEQUENCE_BROKEN'), true);
});

test('auditor: no marca solicitud de datos posterior al consentimiento', () => {
  const cand = candidate({ dataConsentAcceptedAt: new Date(Date.UTC(2026, 7, 8, 13, 20)) });
  const result = analyzeConversationSession([
    message('1', 21, 'OUTBOUND', 'Para avanzar, compárteme nombre completo, número de documento y edad.', {
      source: 'bot_flow'
    }, cand)
  ], { now: new Date(Date.UTC(2026, 7, 8, 13, 22)), checkCurrentState: false });
  assert.equal(codes(result).has('CONSENT_SEQUENCE_BROKEN'), false);
});

test('auditor: pregunta por empresa seguida de otra pregunta de flujo queda como no respondida', () => {
  const cand = candidate({ dataConsentAcceptedAt: new Date(Date.UTC(2026, 7, 8, 13, 0)) });
  const result = analyzeConversationSession([
    message('1', 20, 'INBOUND', '¿Para qué empresa es la vacante?', {}, cand),
    message('2', 21, 'OUTBOUND', 'Gracias por contarme desde dónde escribes. ¿Para qué vacante o cargo estás interesado?', {
      source: 'vacancy_first_gate'
    }, cand)
  ], { now: new Date(Date.UTC(2026, 7, 8, 13, 22)), checkCurrentState: false });
  assert.equal(codes(result).has('QUESTION_NOT_ANSWERED'), true);
});
