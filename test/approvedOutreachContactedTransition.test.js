import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildApprovedInterviewTemplateDelivery,
  fetchMonitorMessages,
  finalizeApprovedInterviewOutreachHandoff,
  INTERVIEW_COORDINATION_HANDOFF_MODE,
  normalizeCoordinatorContactPhone
} from '../src/routes/admin.js';
import {
  buildInterviewOutreachAttendanceScript,
  deriveInterviewOutreachAttendance,
  INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD as DASHBOARD_CONFIRM_PAYLOAD,
  INTERVIEW_ATTENDANCE_DECLINE_PAYLOAD as DASHBOARD_DECLINE_PAYLOAD,
  summarizeInterviewOutreachAttendanceCandidates
} from '../src/services/vacancyDashboardSearchExpansion.js';
import {
  buildWhatsAppTemplatePayload,
  INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD,
  INTERVIEW_ATTENDANCE_DECLINE_PAYLOAD
} from '../src/services/whatsapp.js';
import { sanitizeForRawPayload } from '../src/services/debugTrace.js';
import { shouldResumeAutomationOnInbound } from '../src/services/botAutomationPolicy.js';

const handoffAt = new Date('2026-08-25T14:00:00.000Z');

function inboundMessage({ id = null, title = '', body = '', createdAt }) {
  return {
    body: body || title,
    createdAt: new Date(createdAt),
    rawPayload: id ? {
      interactive: {
        type: 'button_reply',
        button_reply: { id, title }
      }
    } : {}
  };
}

function handoffCandidate(messages = []) {
  return {
    id: 'candidate-attendance-1',
    fullName: 'Persona Prueba',
    phone: '573001234567',
    status: 'CONTACTADO',
    botPaused: true,
    botPausedAt: handoffAt,
    botPausedBy: null,
    botPauseReason: 'Citacion de entrevista entregada; coordinacion externa',
    botResumeMode: INTERVIEW_COORDINATION_HANDOFF_MODE,
    messages
  };
}

test('la plantilla Meta incluye seis variables y dos Quick Replies estables por defecto', () => {
  assert.equal(INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD, DASHBOARD_CONFIRM_PAYLOAD);
  assert.equal(INTERVIEW_ATTENDANCE_DECLINE_PAYLOAD, DASHBOARD_DECLINE_PAYLOAD);

  const payload = buildWhatsAppTemplatePayload('573001234567', {
    name: 'citacion_entrevista_loginpro',
    languageCode: 'es_CO',
    bodyParameters: [
      'Persona Prueba',
      'Vacante Prueba',
      '27 de agosto de 2026',
      '8:00 a. m.',
      'Dirección Prueba',
      '+57 300 765 4321'
    ]
  });

  assert.equal(payload.type, 'template');
  assert.equal(payload.template.components[0].type, 'body');
  assert.equal(payload.template.components[0].parameters.length, 6);
  assert.deepEqual(payload.template.components.slice(1), [
    {
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [{ type: 'payload', payload: INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD }]
    },
    {
      type: 'button',
      sub_type: 'quick_reply',
      index: '1',
      parameters: [{ type: 'payload', payload: INTERVIEW_ATTENDANCE_DECLINE_PAYLOAD }]
    }
  ]);
});

test('el sanitizer conserva id y título del botón sin copiar payloads ajenos', () => {
  const sanitized = sanitizeForRawPayload({
    id: 'wamid.button.test',
    from: '573001234567',
    timestamp: '1787670000',
    type: 'interactive',
    interactive: {
      type: 'button_reply',
      button_reply: {
        id: INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD,
        title: 'Confirmo asistencia',
        tracking: 'no-debe-persistirse'
      },
      private_metadata: 'no-debe-persistirse'
    }
  });

  assert.deepEqual(sanitized.interactive, {
    type: 'button_reply',
    button_reply: {
      id: INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD,
      title: 'Confirmo asistencia'
    },
    list_reply: undefined
  });
  assert.doesNotMatch(JSON.stringify(sanitized), /tracking|private_metadata/);
});

test('sin respuesta posterior al handoff la citación queda pendiente', () => {
  const result = deriveInterviewOutreachAttendance(handoffCandidate([
    inboundMessage({
      id: INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD,
      title: 'Confirmo asistencia',
      createdAt: '2026-08-25T13:59:00.000Z'
    })
  ]));

  assert.deepEqual(result, { status: 'PENDIENTE', respondedAt: null, source: null });
});

test('el Quick Reply positivo posterior al handoff confirma asistencia', () => {
  const confirmedAt = '2026-08-25T14:05:00.000Z';
  const result = deriveInterviewOutreachAttendance(handoffCandidate([
    inboundMessage({
      id: INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD,
      title: 'Confirmo asistencia',
      createdAt: confirmedAt
    })
  ]));

  assert.equal(result.status, 'CONFIRMADO');
  assert.equal(result.source, 'BUTTON');
  assert.equal(new Date(result.respondedAt).toISOString(), confirmedAt);
});

test('la última respuesta válida permite cambiar de confirmado a no asiste', () => {
  const result = deriveInterviewOutreachAttendance(handoffCandidate([
    inboundMessage({
      id: INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD,
      title: 'Confirmo asistencia',
      createdAt: '2026-08-25T14:05:00.000Z'
    }),
    inboundMessage({
      id: INTERVIEW_ATTENDANCE_DECLINE_PAYLOAD,
      title: 'No puedo asistir',
      createdAt: '2026-08-25T14:15:00.000Z'
    })
  ]));

  assert.equal(result.status, 'NO_ASISTE');
  assert.equal(result.source, 'BUTTON');
  assert.equal(new Date(result.respondedAt).toISOString(), '2026-08-25T14:15:00.000Z');
});

test('texto explícito posterior al handoff funciona como compatibilidad sin desplazar el payload estable', () => {
  const result = deriveInterviewOutreachAttendance(handoffCandidate([
    inboundMessage({
      body: 'Sí asisto',
      createdAt: '2026-08-25T14:06:00.000Z'
    })
  ]));

  assert.equal(result.status, 'CONFIRMADO');
  assert.equal(result.source, 'TEXT');
});

test('el resumen por vacante conserva confirmados, no asistentes y pendientes con identidad', () => {
  const vacancyId = 'vacancy-attendance-test';
  const candidates = [
    {
      ...handoffCandidate([
        inboundMessage({
          id: INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD,
          title: 'Confirmo asistencia',
          createdAt: '2026-08-25T14:05:00.000Z'
        })
      ]),
      id: 'candidate-confirmed-test',
      vacancyId,
      fullName: 'Persona Confirmada'
    },
    {
      ...handoffCandidate([
        inboundMessage({
          id: INTERVIEW_ATTENDANCE_DECLINE_PAYLOAD,
          title: 'No puedo asistir',
          createdAt: '2026-08-25T14:15:00.000Z'
        })
      ]),
      id: 'candidate-declined-test',
      vacancyId,
      fullName: 'Persona No Asiste'
    },
    {
      ...handoffCandidate([]),
      id: 'candidate-pending-test',
      vacancyId,
      fullName: 'Persona Pendiente'
    },
    {
      ...handoffCandidate([]),
      id: 'candidate-outside-scope-test',
      vacancyId: 'vacancy-not-visible-test',
      fullName: 'Persona Fuera de Alcance'
    }
  ];

  const summaries = summarizeInterviewOutreachAttendanceCandidates(
    candidates,
    new Map([[vacancyId, 'Ciudad Prueba']])
  );
  const summary = summaries[vacancyId];

  assert.equal(Object.keys(summaries).length, 1);
  assert.equal(summary.total, 3);
  assert.equal(summary.confirmedCount, 1);
  assert.equal(summary.declinedCount, 1);
  assert.equal(summary.pendingCount, 1);
  assert.deepEqual(
    summary.responses.map(({ id, attendanceStatus }) => [id, attendanceStatus]),
    [
      ['candidate-declined-test', 'NO_ASISTE'],
      ['candidate-confirmed-test', 'CONFIRMADO'],
      ['candidate-pending-test', 'PENDIENTE']
    ]
  );
});

test('la confirmación operativa no auto-reanuda a Lórren', () => {
  assert.equal(shouldResumeAutomationOnInbound(handoffCandidate()), false);
});

test('la finalización APROBADO a CONTACTADO deja handoff persistente y audita', async () => {
  const calls = { updates: [], audits: [] };
  const client = {
    candidate: {
      async updateMany(args) {
        calls.updates.push(args);
        return { count: 1 };
      }
    },
    candidateAdminEvent: {
      async create(args) {
        calls.audits.push(args);
        return { id: 'audit-test-1' };
      }
    }
  };
  const sentAt = new Date('2026-08-25T14:00:00.000Z');

  const result = await finalizeApprovedInterviewOutreachHandoff(client, {
    candidateId: 'candidate-approved-test',
    actorRole: 'admin',
    sentAt
  });

  assert.deepEqual(result, { count: 1 });
  assert.deepEqual(calls.updates[0].where, {
    id: 'candidate-approved-test',
    status: 'APROBADO',
    botPaused: true,
    botResumeMode: 'manual_resume_dashboard',
    lastOutboundAt: sentAt
  });
  assert.equal(calls.updates[0].data.status, 'CONTACTADO');
  assert.equal(calls.updates[0].data.botResumeMode, INTERVIEW_COORDINATION_HANDOFF_MODE);
  assert.equal(calls.updates[0].data.botPaused, true);
  assert.equal(calls.updates[0].data.botPausedBy, null);
  assert.equal(calls.audits.length, 1);
});

test('Monitor excluye candidatos transferidos a coordinación humana', async () => {
  const visible = {
    id: 'message-visible',
    rawPayload: {},
    candidate: { id: 'candidate-visible', botResumeMode: null }
  };
  const handoff = {
    id: 'message-handoff',
    rawPayload: {},
    candidate: { id: 'candidate-handoff', botResumeMode: INTERVIEW_COORDINATION_HANDOFF_MODE }
  };
  const prisma = {
    message: {
      async findMany() {
        return [handoff, visible];
      }
    }
  };

  const result = await fetchMonitorMessages(prisma);
  assert.deepEqual(result, [visible]);
});

test('la configuración usa teléfono colombiano persistido y construye las seis variables', () => {
  const coordinator = normalizeCoordinatorContactPhone('3007654321');
  assert.deepEqual(coordinator, {
    apiPhone: '573007654321',
    displayPhone: '+57 300 765 4321'
  });

  const delivery = buildApprovedInterviewTemplateDelivery({
    fullName: 'Persona Prueba',
    vacancy: { title: 'Vacante Prueba' }
  }, {
    interviewDate: '2026-08-27',
    interviewTime: '08:00',
    interviewAddress: 'Dirección Prueba'
  }, coordinator);

  assert.equal(delivery.parameters.length, 6);
  assert.equal(delivery.parameters[0], 'Persona Prueba');
  assert.equal(delivery.parameters[1], 'Vacante Prueba');
  assert.equal(delivery.parameters[4], 'Dirección Prueba');
  assert.equal(delivery.parameters[5], '+57 300 765 4321');
});

test('el dashboard muestra la respuesta individual de todos los citados sin crear agenda automática', () => {
  const script = buildInterviewOutreachAttendanceScript({
    'vacancy-test': {
      vacancyId: 'vacancy-test',
      total: 3,
      confirmedCount: 1,
      pendingCount: 1,
      declinedCount: 1,
      responses: [
        {
          id: 'candidate-confirmed-test',
          fullName: 'Persona Confirmada',
          phone: '573001234567',
          attendanceStatus: 'CONFIRMADO',
          respondedAt: '2026-08-25T14:05:00.000Z'
        },
        {
          id: 'candidate-declined-test',
          fullName: 'Persona No Asiste',
          phone: '573001234568',
          attendanceStatus: 'NO_ASISTE',
          respondedAt: '2026-08-25T14:15:00.000Z'
        },
        {
          id: 'candidate-pending-test',
          fullName: 'Persona Pendiente',
          phone: '573001234569',
          attendanceStatus: 'PENDIENTE',
          respondedAt: null
        }
      ]
    }
  });

  assert.match(script, /Respuestas de citación/);
  assert.match(script, /no crea agenda automática/);
  assert.match(script, /No asistirán/);
  assert.match(script, /candidate-confirmed-test/);
  assert.match(script, /candidate-declined-test/);
  assert.match(script, /candidate-pending-test/);
  assert.match(script, /Asiste/);
  assert.match(script, /No asiste/);
  assert.match(script, /Pendiente/);
  assert.match(script, /Sin respuesta hasta el momento/);
  assert.doesNotMatch(script, /responses\.slice|confirmados más/);
  assert.doesNotMatch(script, /InterviewBooking|interviewBooking\.create/);

  const body = script.replace(/^\s*<script>\s*/, '').replace(/\s*<\/script>\s*$/, '');
  assert.doesNotThrow(() => new Function(body));
});

test('la consulta de respuestas conserva la autoridad de acceso por usuario y vacante', () => {
  const source = readFileSync(new URL('../src/services/vacancyDashboardSearchExpansion.js', import.meta.url), 'utf8');
  assert.match(source, /buildCandidateAccessWhere\(accessContext\)/);
  assert.match(source, /\{ vacancyId: \{ in: vacancyIds \} \}/);
  assert.match(source, /visibleVacancyIds/);
});

test('la vista explica los dos botones Meta y no usa diálogos nativos', () => {
  const view = readFileSync(new URL('../src/views/outreachApproved.ejs', import.meta.url), 'utf8');
  assert.match(view, /Confirmo asistencia/);
  assert.match(view, /No puedo asistir/);
  assert.match(view, /Quick Reply/);
  assert.match(view, /no crea un <code>InterviewBooking<\/code>/);
  assert.doesNotMatch(view, /window\.(?:alert|confirm|prompt)\s*\(/);
});

test('el flujo de outreach no crea bookings ni activa schedulingEnabled', () => {
  const source = readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
  const postStart = source.indexOf("router.post('/outreach/approved/prepare'");
  const nextRoute = source.indexOf("router.get('/bot-knowledge'", postStart);
  assert.ok(postStart >= 0 && nextRoute > postStart);
  const postRoute = source.slice(postStart, nextRoute);

  assert.match(postRoute, /deliverManualOutboundText/);
  assert.match(postRoute, /sendTemplateMessage/);
  assert.match(postRoute, /finalizeApprovedInterviewOutreachHandoff/);
  assert.doesNotMatch(postRoute, /interviewBooking\.(?:create|createMany|update|upsert)/);
  assert.doesNotMatch(postRoute, /schedulingEnabled\s*:/);
});
