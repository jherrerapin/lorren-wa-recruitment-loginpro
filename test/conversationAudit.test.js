import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeConversationSession,
  buildConversationAuditReport,
  loadConversationAuditReport,
  redactConversationText,
  segmentConversationMessages
} from '../src/services/conversationAudit.js';

const baseCandidate = {
  id: 'candidate-1',
  fullName: 'Carlos Perez',
  phone: '3203998106',
  documentNumber: '1234567890',
  currentStep: 'COLLECTING_DATA',
  status: 'NUEVO',
  gender: 'MALE',
  botPaused: false,
  botPauseReason: null,
  cvStorageKey: null,
  cvOriginalName: null,
  vacancy: {
    title: 'Auxiliar de cargue y descargue',
    city: 'Bogotá',
    requirements: 'Mayor de edad.',
    conditions: 'Turnos rotativos.',
    operationAddress: 'Montevideo',
    requiredDocuments: 'Cédula original.',
    schedulingEnabled: false,
    acceptingApplications: true,
    isActive: true
  },
  interviewBookings: []
};

function message(id, minutes, direction, body, rawPayload = {}, overrides = {}) {
  return {
    id,
    candidateId: 'candidate-1',
    direction,
    messageType: 'TEXT',
    body,
    rawPayload,
    createdAt: new Date(Date.UTC(2026, 7, 1, 12, minutes)),
    candidate: baseCandidate,
    ...overrides
  };
}

test('segmenta por candidato y por brecha de 24 horas', () => {
  const first = message('1', 0, 'INBOUND', 'Hola');
  const second = message('2', 1, 'OUTBOUND', 'Hola');
  const third = { ...message('3', 2, 'INBOUND', 'Otra vez'), createdAt: new Date(Date.UTC(2026, 7, 2, 13, 2)) };
  assert.equal(segmentConversationMessages([third, second, first]).length, 2);
});

test('detecta respuesta encima de humano, repetición, pregunta ignorada y fuga técnica', () => {
  const rows = [
    message('1', 0, 'INBOUND', '¿Cuánto pagan?'),
    message('2', 1, 'OUTBOUND', 'Compárteme tu número de documento y tu edad.'),
    message('3', 2, 'OUTBOUND', 'Un reclutador revisará tu caso.', { actor: 'RECRUITER', source: 'admin_outbound', manualIntervention: true }),
    message('4', 3, 'OUTBOUND', 'Modelo usado gpt-5.6, necesito tu documento.'),
    message('5', 4, 'OUTBOUND', 'Modelo usado gpt-5.6, necesito tu documento.'),
    message('6', 5, 'OUTBOUND', 'Modelo usado gpt-5.6, necesito tu documento.')
  ];
  const result = analyzeConversationSession(rows, { now: new Date(Date.UTC(2026, 7, 1, 13, 0)) });
  const codes = new Set(result.issues.map((issue) => issue.code));
  assert.ok(codes.has('QUESTION_NOT_ANSWERED'));
  assert.ok(codes.has('BOT_OVER_HUMAN'));
  assert.ok(codes.has('TECHNICAL_LEAK'));
  assert.ok(codes.has('DUPLICATE_REPLY'));
  assert.ok(codes.has('LOOP_PATTERN'));
  assert.equal(result.risk.label, 'RIESGO_ALTO');
});

test('detecta solicitud repetida después de evidencia del candidato', () => {
  const rows = [
    message('1', 0, 'INBOUND', 'Vivo en Kennedy y me transporto en moto.'),
    message('2', 1, 'OUTBOUND', 'Por favor indícame tu localidad y tu medio de transporte.')
  ];
  const result = analyzeConversationSession(rows, { now: new Date(Date.UTC(2026, 7, 1, 13, 0)) });
  assert.ok(result.issues.some((issue) => issue.code === 'REPEATED_DATA_REQUEST'));
});

test('redacta nombre, teléfono, documento y correo', () => {
  const output = redactConversationText('Carlos Perez 3203998106 1234567890 carlos@test.com', baseCandidate);
  assert.doesNotMatch(output, /Carlos|Perez|3203998106|1234567890|carlos@test.com/i);
});

test('carga todos los mensajes del rango sin límite take y genera diagnóstico completo', async () => {
  let observedQuery;
  const rows = [message('1', 0, 'INBOUND', 'Hola'), message('2', 1, 'OUTBOUND', 'Hola, cuéntame en qué ciudad buscas vacante.')];
  const prisma = {
    message: {
      async findMany(query) {
        observedQuery = query;
        return rows;
      }
    }
  };
  const report = await loadConversationAuditReport(prisma, {
    days: 15,
    now: new Date(Date.UTC(2026, 7, 1, 13, 0))
  });
  assert.equal(observedQuery.take, undefined);
  assert.ok(observedQuery.where.createdAt.gte instanceof Date);
  assert.equal(report.summary.messages, 2);
  assert.equal(report.summary.conversations, 1);
  assert.equal(report.methodology.openAiCalls, 0);
});

test('filtra mensajes internos del supervisor', () => {
  const report = buildConversationAuditReport([
    message('1', 0, 'INBOUND', 'Hola'),
    message('2', 1, 'OUTBOUND', 'Interno', { visibility: 'internal' }),
    message('3', 2, 'OUTBOUND', 'Respuesta visible', { source: 'bot_flow' })
  ], { now: new Date(Date.UTC(2026, 7, 1, 13, 0)) });
  assert.equal(report.summary.messages, 2);
  assert.equal(report.conversations[0].transcript.length, 2);
});

test('aplica inconsistencias del estado actual solo a la sesión más reciente del candidato', () => {
  const candidate = {
    id: 'candidate-state',
    currentStep: 'SCHEDULED',
    status: 'REGISTRADO',
    botPaused: false,
    interviewBookings: [],
    vacancy: { title: 'Auxiliar', city: 'Bogotá', schedulingEnabled: true }
  };
  const report = buildConversationAuditReport([
    message('old-in', 0, 'INBOUND', 'Hola', {}, { candidateId: candidate.id, createdAt: new Date('2026-07-01T10:00:00Z'), candidate }),
    message('old-out', 1, 'OUTBOUND', 'Hola, cuéntame en qué ciudad buscas vacante.', {}, { candidateId: candidate.id, createdAt: new Date('2026-07-01T10:01:00Z'), candidate }),
    message('new-in', 0, 'INBOUND', 'Confirmo', {}, { candidateId: candidate.id, createdAt: new Date('2026-07-03T10:00:00Z'), candidate }),
    message('new-out', 1, 'OUTBOUND', 'Voy a revisar el horario disponible.', {}, { candidateId: candidate.id, createdAt: new Date('2026-07-03T10:01:00Z'), candidate })
  ], { now: new Date('2026-07-03T11:00:00Z'), start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-07-04T00:00:00Z'), days: 3 });
  assert.equal(report.conversations.length, 2);
  assert.equal(report.conversations.filter((item) => item.issues.some((issue) => issue.code === 'SCHEDULED_WITHOUT_BOOKING')).length, 1);
});

test('no marca como afirmación sensible una pregunta o solicitud de datos', () => {
  const rows = [
    message('1', 0, 'INBOUND', 'Hola'),
    message('2', 1, 'OUTBOUND', '¿Qué horario prefieres para la entrevista?'),
    message('3', 2, 'OUTBOUND', 'Por favor compárteme tu número de documento.')
  ];
  const result = analyzeConversationSession(rows, { now: new Date(Date.UTC(2026, 7, 1, 13, 0)) });
  assert.equal(result.issues.some((issue) => issue.code === 'UNSUPPORTED_SENSITIVE_CLAIM'), false);
});

test('anonimiza identificadores de mensajes y motivos de pausa', () => {
  const candidate = {
    ...baseCandidate,
    botPaused: true,
    botPauseReason: 'Revisar a Carlos Perez, teléfono 3203998106'
  };
  const result = analyzeConversationSession([
    message('raw-message-id', 0, 'INBOUND', 'Hola', {}, { candidate })
  ], { now: new Date(Date.UTC(2026, 7, 1, 13, 0)) });
  assert.notEqual(result.transcript[0].id, 'raw-message-id');
  assert.doesNotMatch(result.finalState.botPauseReason || '', /Carlos|Perez|3203998106/i);
  assert.doesNotMatch(JSON.stringify(result.issues), /raw-message-id|Carlos Perez|3203998106/i);
});
