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
import { buildWhatsAppTemplatePayload } from '../src/services/whatsapp.js';
import { shouldResumeAutomationOnInbound } from '../src/services/botAutomationPolicy.js';

function handoffCandidate() {
  return {
    id: 'candidate-handoff-test',
    fullName: 'Persona Prueba',
    phone: '573001234567',
    status: 'CONTACTADO',
    botPaused: true,
    botPausedAt: new Date('2026-08-25T14:00:00.000Z'),
    botPausedBy: null,
    botPauseReason: 'Citacion de entrevista entregada; coordinacion externa',
    botResumeMode: INTERVIEW_COORDINATION_HANDOFF_MODE
  };
}

test('la plantilla Meta usa tres variables de cuerpo y un CTA URL dinámico sin Quick Replies', () => {
  const payload = buildWhatsAppTemplatePayload('573001234567', {
    name: 'citacion_entrevista_loginpro',
    languageCode: 'es_CO',
    bodyParameters: [
      'Persona Prueba',
      'Vacante Prueba',
      'Coordinación Prueba'
    ],
    urlButtonParameters: ['573007654321']
  });

  assert.equal(payload.type, 'template');
  assert.equal(payload.template.components[0].type, 'body');
  assert.deepEqual(
    payload.template.components[0].parameters.map((parameter) => parameter.text),
    ['Persona Prueba', 'Vacante Prueba', 'Coordinación Prueba']
  );
  assert.deepEqual(payload.template.components.slice(1), [
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: '573007654321' }]
    }
  ]);
  assert.doesNotMatch(JSON.stringify(payload), /quick_reply|INTERVIEW_ATTEND_(?:YES|NO)/);
});

test('sin configuración explícita la plantilla no agrega botones de asistencia por defecto', () => {
  const payload = buildWhatsAppTemplatePayload('573001234567', {
    name: 'plantilla_prueba',
    languageCode: 'es_CO',
    bodyParameters: ['Persona Prueba']
  });

  assert.equal(payload.template.components.length, 1);
  assert.equal(payload.template.components[0].type, 'body');
});

test('el handoff de coordinación no auto-reanuda a Lórren', () => {
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

test('la configuración usa actor y teléfono persistidos y construye solo las tres variables del cuerpo', () => {
  const phone = normalizeCoordinatorContactPhone('3007654321');
  assert.deepEqual(phone, {
    apiPhone: '573007654321',
    displayPhone: '+57 300 765 4321'
  });

  const delivery = buildApprovedInterviewTemplateDelivery({
    fullName: 'Persona Prueba',
    vacancy: { title: 'Vacante Prueba' }
  }, {}, {
    ...phone,
    name: 'Coordinación Prueba'
  });

  assert.deepEqual(delivery.parameters, [
    'Persona Prueba',
    'Vacante Prueba',
    'Coordinación Prueba'
  ]);
  assert.equal(delivery.coordinatorPhone, '573007654321');
  assert.match(delivery.body, /Coordinación Prueba/);
  assert.match(delivery.body, /proceso es gratuito/i);
  assert.doesNotMatch(delivery.body, /Te esperamos|Dirección Prueba|8:00|27 de agosto/);
});

test('el dashboard ya no deriva ni dibuja confirmación automática de la citación', () => {
  const source = readFileSync(new URL('../src/services/vacancyDashboardSearchExpansion.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /INTERVIEW_ATTEND_YES|INTERVIEW_ATTEND_NO/);
  assert.doesNotMatch(source, /deriveInterviewOutreachAttendance/);
  assert.doesNotMatch(source, /summarizeInterviewOutreachAttendanceCandidates/);
  assert.doesNotMatch(source, /buildInterviewOutreachAttendanceScript/);
  assert.doesNotMatch(source, /interviewOutreachAttendanceByVacancy/);
});

test('la vista deriva al coordinador y elimina fecha, hora, lugar y Quick Replies', () => {
  const view = readFileSync(new URL('../src/views/outreachApproved.ejs', import.meta.url), 'utf8');
  assert.match(view, /Contactar a coordinador/);
  assert.match(view, /https:\/\/wa\.me\/\{\{1\}\}/);
  assert.match(view, /Gestionante \/ coordinador/);
  assert.doesNotMatch(view, /id="interviewDate"|name="interviewDate"/);
  assert.doesNotMatch(view, /id="interviewTime"|name="interviewTime"/);
  assert.doesNotMatch(view, /id="interviewAddress"|name="interviewAddress"/);
  assert.doesNotMatch(view, /Confirmo asistencia|No puedo asistir|Quick Reply/);
  assert.doesNotMatch(view, /window\.(?:alert|confirm|prompt)\s*\(/);
});

test('el flujo de outreach usa CTA del coordinador, conserva el handoff y no crea bookings', () => {
  const source = readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
  const postStart = source.indexOf("router.post('/outreach/approved/prepare'");
  const nextRoute = source.indexOf("router.get('/bot-knowledge'", postStart);
  assert.ok(postStart >= 0 && nextRoute > postStart);
  const postRoute = source.slice(postStart, nextRoute);

  assert.match(postRoute, /deliverManualOutboundText/);
  assert.match(postRoute, /sendTemplateMessage/);
  assert.match(postRoute, /urlButtonParameters:\s*\[invitation\.coordinatorPhone\]/);
  assert.match(postRoute, /finalizeApprovedInterviewOutreachHandoff/);
  assert.doesNotMatch(postRoute, /interviewBooking\.(?:create|createMany|update|upsert)/);
  assert.doesNotMatch(postRoute, /schedulingEnabled\s*:/);
  assert.doesNotMatch(postRoute, /selectedVacancyIds/);
});
