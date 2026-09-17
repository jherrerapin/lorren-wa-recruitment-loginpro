import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERVIEW_COORDINATION_HANDOFF_REPLY_POLICY,
  interviewCoordinationHandoffMiddleware,
  isInterviewCoordinationQuestion,
  resolveInterviewCoordinationOutreachContext
} from '../src/services/botAutomationPolicy.js';
import { completeCandidateNoInterestTransition } from '../src/services/candidateStateService.js';
import { cancelActiveInterviewBookings } from '../src/services/interviewBookingStateService.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createHarness({ existingInbound = null, candidateOverrides = {}, activeBooking = null } = {}) {
  const candidate = {
    id: 'candidate-handoff-test',
    phone: '573001234567',
    fullName: 'Persona Prueba',
    status: 'CONTACTADO',
    currentStep: 'DONE',
    vacancyId: 'vacancy-test',
    botPaused: true,
    botPausedAt: new Date('2026-08-25T14:00:00.000Z'),
    botPausedBy: null,
    botPauseReason: 'Citacion de entrevista entregada; coordinacion externa',
    botResumeMode: 'interview_coordination_handoff',
    reminderScheduledFor: null,
    reminderState: 'CANCELLED',
    lastInboundAt: new Date('2026-08-25T13:00:00.000Z'),
    lastOutboundAt: new Date('2026-08-25T14:00:00.000Z'),
    ...candidateOverrides
  };
  const messages = [{
    id: 'outbound-citation-test',
    candidateId: candidate.id,
    direction: 'OUTBOUND',
    messageType: 'TEXT',
    body: [
      'Hola Persona Prueba, tienes una citación para Vacante Prueba.',
      'Te esperamos el 27 de agosto de 2026 a las 8:00 a. m. en Dirección Prueba.',
      'Si necesitas coordinar algo, escríbenos al +57 300 765 4321.'
    ].join('\n'),
    rawPayload: {
      source: 'admin_interview_template',
      delivery: { state: 'SENT', transport: 'TEMPLATE' }
    },
    respondedAt: null,
    createdAt: new Date('2026-08-25T14:00:00.000Z')
  }];
  if (existingInbound) messages.push(clone(existingInbound));

  let sequence = messages.length;
  const calls = {
    sends: [],
    candidateUpdates: [],
    bookingUpdates: [],
    next: 0
  };

  const prisma = {
    async $transaction(callback) {
      return callback(prisma);
    },
    candidate: {
      async findUnique({ where }) {
        if (where?.phone === candidate.phone || where?.id === candidate.id) return clone(candidate);
        return null;
      },
      async update({ where, data }) {
        assert.equal(where.id, candidate.id);
        calls.candidateUpdates.push(clone(data));
        Object.assign(candidate, clone(data));
        return clone(candidate);
      },
      async updateMany({ where, data }) {
        if (where.id !== candidate.id) return { count: 0 };
        const matchesSnapshot = Object.entries(where)
          .filter(([field]) => field !== 'id')
          .every(([field, expected]) => {
            const actual = candidate[field];
            if (actual instanceof Date || expected instanceof Date) {
              return new Date(actual).getTime() === new Date(expected).getTime();
            }
            return actual === expected;
          });
        if (!matchesSnapshot) return { count: 0 };
        calls.candidateUpdates.push(clone(data));
        Object.assign(candidate, clone(data));
        return { count: 1 };
      }
    },
    interviewBooking: {
      async updateMany({ where, data }) {
        if (!activeBooking || activeBooking.candidateId !== where.candidateId) return { count: 0 };
        if (!where.status.in.includes(activeBooking.status)) return { count: 0 };
        calls.bookingUpdates.push(clone(data));
        Object.assign(activeBooking, clone(data));
        return { count: 1 };
      }
    },
    vacancy: {
      async findUnique({ where }) {
        if (where.id !== candidate.vacancyId) return null;
        return {
          id: candidate.vacancyId,
          title: 'Vacante Prueba',
          role: 'Cargo Prueba',
          city: 'Ciudad Prueba',
          operationAddress: 'Zona Operativa Prueba',
          interviewAddress: 'Dirección Prueba',
          requirements: 'Requisito Prueba',
          conditions: 'Condición Prueba',
          requiredDocuments: 'Documento Prueba',
          operation: { city: { name: 'Ciudad Prueba' } }
        };
      }
    },
    message: {
      async createMany({ data }) {
        const row = clone(data[0]);
        if (row.waMessageId && messages.some((message) => message.waMessageId === row.waMessageId)) {
          return { count: 0 };
        }
        messages.push({
          id: `message-${++sequence}`,
          createdAt: new Date('2026-08-25T14:05:00.000Z'),
          respondedAt: null,
          ...row
        });
        return { count: 1 };
      },
      async findFirst({ where }) {
        const found = messages.find((message) => (
          message.candidateId === where.candidateId
          && message.direction === where.direction
          && message.waMessageId === where.waMessageId
        ));
        return found ? clone(found) : null;
      },
      async findMany({ where, orderBy, take }) {
        let rows = messages.filter((message) => message.candidateId === where.candidateId);
        if (orderBy?.createdAt === 'desc') {
          rows = rows.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
        }
        if (take) rows = rows.slice(0, take);
        return clone(rows);
      },
      async create({ data }) {
        const row = {
          id: `message-${++sequence}`,
          createdAt: new Date('2026-08-25T14:05:02.000Z'),
          respondedAt: null,
          waMessageId: null,
          ...clone(data)
        };
        messages.push(row);
        return clone(row);
      },
      async updateMany({ where, data }) {
        const ids = new Set(where?.id?.in || []);
        let count = 0;
        for (const message of messages) {
          if (!ids.has(message.id)) continue;
          Object.assign(message, clone(data));
          count += 1;
        }
        return { count };
      }
    }
  };

  return {
    prisma,
    candidate,
    messages,
    calls,
    sendText: async (phone, body) => {
      calls.sends.push({ phone, body });
      return { messages: [{ id: 'wamid.reply.test' }] };
    },
    deliverAutomaticOutboundText: async (prismaClient, input, dependencies) => {
      await dependencies.beforeSend();
      const response = await dependencies.sendText(input.to, input.body);
      const sentAt = new Date('2026-08-25T14:05:04.000Z');
      await prismaClient.message.create({
        data: {
          candidateId: input.candidateId,
          direction: 'OUTBOUND',
          messageType: 'TEXT',
          body: input.body,
          rawPayload: {
            ...input.rawPayload,
            delivery: { state: 'SENT', sentAt: sentAt.toISOString() }
          },
          waMessageId: response.messages[0].id
        }
      });
      await prismaClient.candidate.update({
        where: { id: input.candidateId },
        data: { lastOutboundAt: sentAt }
      });
      return { sent: true, suppressed: false };
    },
    next: (error) => {
      assert.equal(error, undefined);
      calls.next += 1;
    }
  };
}

function questionMessage() {
  return {
    id: 'wamid.question.test',
    from: '573001234567',
    type: 'text',
    text: { body: '¿Dónde debo presentarme para la entrevista?' }
  };
}

test('replay seudonimizado: responde la duda del handoff, remite al gestor y conserva la pausa', async () => {
  const harness = createHarness();
  const middleware = interviewCoordinationHandoffMiddleware(harness.prisma, {
    extractMessages: () => [questionMessage()],
    sendText: harness.sendText,
    buildContextualReply: async (context) => ({
      text: context.fallbackText,
      fallbackUsed: true,
      reason: 'test_fallback',
      model: null
    })
  });

  await middleware({ body: {} }, {}, harness.next);

  assert.equal(harness.calls.next, 1);
  assert.equal(harness.calls.sends.length, 1);
  assert.equal(harness.calls.sends[0].phone, '573001234567');
  assert.match(harness.calls.sends[0].body, /Dirección Prueba/);
  assert.match(harness.calls.sends[0].body, /\+57 300 765 4321/);
  assert.match(harness.calls.sends[0].body, /persona que gestionó tu citación/i);

  assert.equal(harness.candidate.status, 'CONTACTADO');
  assert.equal(harness.candidate.currentStep, 'DONE');
  assert.equal(harness.candidate.botPaused, true);
  assert.equal(harness.candidate.botResumeMode, 'interview_coordination_handoff');
  assert.equal(harness.candidate.reminderState, 'CANCELLED');
  assert.equal(harness.candidate.reminderScheduledFor, null);
  assert.ok(harness.calls.candidateUpdates.every((update) => !Object.hasOwn(update, 'botPaused')));
  assert.ok(harness.calls.candidateUpdates.every((update) => !Object.hasOwn(update, 'currentStep')));
  assert.ok(harness.calls.candidateUpdates.every((update) => !Object.hasOwn(update, 'status')));

  const inbound = harness.messages.find((message) => message.waMessageId === 'wamid.question.test');
  assert.ok(inbound?.respondedAt);
  const reply = harness.messages.find((message) => message.rawPayload?.source === INTERVIEW_COORDINATION_HANDOFF_REPLY_POLICY.source);
  assert.ok(reply);
  assert.equal(reply.rawPayload.handoffPreserved, true);
  assert.equal(reply.direction, 'OUTBOUND');
});

test('replay #901: una negativa final durante el handoff se cierra y recibe respuesta', async () => {
  const harness = createHarness();
  const middleware = interviewCoordinationHandoffMiddleware(harness.prisma, {
    extractMessages: () => [{
      id: 'wamid.optout.test',
      from: '573001234567',
      type: 'text',
      text: { body: 'No deseo continuar' }
    }],
    sendText: harness.sendText,
    completeCandidateNoInterestTransition,
    cancelActiveInterviewBookings,
    deliverAutomaticOutboundText: harness.deliverAutomaticOutboundText
  });

  await middleware({ body: {} }, {}, harness.next);

  assert.equal(harness.calls.next, 1);
  assert.equal(harness.calls.sends.length, 1);
  assert.match(harness.calls.sends[0].body, /cerramos tu participación/i);
  assert.equal(harness.candidate.currentStep, 'DONE');
  assert.equal(harness.candidate.botPaused, true);
  assert.equal(harness.candidate.botResumeMode, 'interview_coordination_handoff');
  assert.equal(harness.candidate.reminderState, 'SKIPPED');
  assert.equal(harness.candidate.reminderScheduledFor, null);

  const inbound = harness.messages.find((message) => message.waMessageId === 'wamid.optout.test');
  assert.ok(inbound?.respondedAt);
  const reply = harness.messages.find((message) => message.rawPayload?.source === 'interview_coordination_handoff_opt_out');
  assert.equal(reply?.rawPayload?.decision, 'close_after_explicit_opt_out');
});

test('replay #901: el retiro cancela una reserva activa mediante su autoridad canónica', async () => {
  const activeBooking = {
    id: 'booking-active-test',
    candidateId: 'candidate-handoff-test',
    status: 'CONFIRMED',
    reminderWindowClosed: false
  };
  const harness = createHarness({ activeBooking });
  const middleware = interviewCoordinationHandoffMiddleware(harness.prisma, {
    extractMessages: () => [{
      id: 'wamid.optout.with.booking.test',
      from: '573001234567',
      type: 'text',
      text: { body: 'No deseo continuar' }
    }],
    sendText: harness.sendText,
    completeCandidateNoInterestTransition,
    cancelActiveInterviewBookings,
    deliverAutomaticOutboundText: harness.deliverAutomaticOutboundText
  });

  await middleware({ body: {} }, {}, harness.next);

  assert.equal(activeBooking.status, 'CANCELLED');
  assert.equal(activeBooking.reminderWindowClosed, true);
  assert.equal(harness.calls.bookingUpdates.length, 1);
});

test('replay #901: una corrección afirmativa posterior conserva el handoff activo', async () => {
  const harness = createHarness({
    candidateOverrides: { reminderState: 'SKIPPED' },
    existingInbound: {
      id: 'message-previous-optout',
      candidateId: 'candidate-handoff-test',
      waMessageId: 'wamid.previous.optout',
      direction: 'INBOUND',
      messageType: 'TEXT',
      body: 'No deseo continuar',
      rawPayload: {},
      respondedAt: new Date('2026-08-25T14:04:00.000Z'),
      createdAt: new Date('2026-08-25T14:04:00.000Z')
    }
  });
  const middleware = interviewCoordinationHandoffMiddleware(harness.prisma, {
    extractMessages: () => [{
      id: 'wamid.correction.test',
      from: '573001234567',
      type: 'text',
      text: { body: 'Sí deseo continuar' }
    }],
    sendText: harness.sendText,
    deliverAutomaticOutboundText: harness.deliverAutomaticOutboundText
  });

  await middleware({ body: {} }, {}, harness.next);

  assert.equal(harness.calls.sends.length, 1);
  assert.match(harness.calls.sends[0].body, /registramos que deseas continuar/i);
  assert.match(harness.calls.sends[0].body, /mantener o reprogramar/i);
  assert.match(harness.calls.sends[0].body, /\+57 300 765 4321/);
  assert.equal(harness.candidate.status, 'CONTACTADO');
  assert.equal(harness.candidate.botPaused, true);
  assert.equal(harness.candidate.botResumeMode, 'interview_coordination_handoff');
  assert.equal(harness.candidate.reminderState, 'CANCELLED');
  assert.equal(harness.candidate.reminderScheduledFor, null);

  const inbound = harness.messages.find((message) => message.waMessageId === 'wamid.correction.test');
  assert.ok(inbound?.respondedAt);
  const reply = harness.messages.find((message) => message.rawPayload?.source === 'interview_coordination_handoff_continuation');
  assert.equal(reply?.rawPayload?.decision, 'continue_after_explicit_correction');
});

test('replay #901: retiro y corrección en el mismo turno lógico producen una sola decisión', async () => {
  const harness = createHarness();
  const middleware = interviewCoordinationHandoffMiddleware(harness.prisma, {
    extractMessages: () => [{
      id: 'wamid.same-turn.optout.test',
      from: '573001234567',
      type: 'text',
      text: { body: 'No deseo continuar' }
    }, {
      id: 'wamid.same-turn.correction.test',
      from: '573001234567',
      type: 'text',
      text: { body: 'Sí deseo continuar' }
    }],
    sendText: harness.sendText,
    deliverAutomaticOutboundText: harness.deliverAutomaticOutboundText
  });

  await middleware({ body: {} }, {}, harness.next);

  assert.equal(harness.calls.sends.length, 1);
  assert.match(harness.calls.sends[0].body, /proceso continúa activo/i);
  const handledInbound = harness.messages.filter((message) => (
    ['wamid.same-turn.optout.test', 'wamid.same-turn.correction.test'].includes(message.waMessageId)
  ));
  assert.equal(handledInbound.length, 2);
  assert.ok(handledInbound.every((message) => message.respondedAt));
});

test('replay #901: una explicación intermedia no oculta el retiro que luego se corrige', async () => {
  const harness = createHarness({
    candidateOverrides: { reminderState: 'SKIPPED' },
    existingInbound: {
      id: 'message-previous-optout',
      candidateId: 'candidate-handoff-test',
      waMessageId: 'wamid.previous.optout',
      direction: 'INBOUND',
      messageType: 'TEXT',
      body: 'No deseo continuar',
      rawPayload: {},
      respondedAt: new Date('2026-08-25T14:03:00.000Z'),
      createdAt: new Date('2026-08-25T14:03:00.000Z')
    }
  });
  harness.messages.push({
    id: 'message-intermediate-explanation',
    candidateId: 'candidate-handoff-test',
    waMessageId: 'wamid.intermediate.explanation',
    direction: 'INBOUND',
    messageType: 'TEXT',
    body: 'Tuve una dificultad personal',
    rawPayload: {},
    respondedAt: null,
    createdAt: new Date('2026-08-25T14:04:00.000Z')
  });
  const middleware = interviewCoordinationHandoffMiddleware(harness.prisma, {
    extractMessages: () => [{
      id: 'wamid.correction.after.explanation.test',
      from: '573001234567',
      type: 'text',
      text: { body: 'Sí deseo continuar' }
    }],
    sendText: harness.sendText,
    deliverAutomaticOutboundText: harness.deliverAutomaticOutboundText
  });

  await middleware({ body: {} }, {}, harness.next);

  assert.equal(harness.calls.sends.length, 1);
  assert.match(harness.calls.sends[0].body, /registramos que deseas continuar/i);
});

test('una confirmación de asistencia no se convierte en reanudación ni respuesta automática', async () => {
  const harness = createHarness();
  const middleware = interviewCoordinationHandoffMiddleware(harness.prisma, {
    extractMessages: () => [{
      id: 'wamid.confirm.test',
      from: '573001234567',
      type: 'text',
      text: { body: 'Confirmo asistencia' }
    }],
    sendText: harness.sendText
  });

  await middleware({ body: {} }, {}, harness.next);

  assert.equal(harness.calls.next, 1);
  assert.equal(harness.calls.sends.length, 0);
  assert.equal(harness.candidate.botPaused, true);
  assert.equal(harness.candidate.botResumeMode, 'interview_coordination_handoff');
  assert.equal(harness.messages.some((message) => message.waMessageId === 'wamid.confirm.test'), false);
});

test('un inbound ya respondido no duplica la respuesta en un retry del webhook', async () => {
  const harness = createHarness({
    existingInbound: {
      id: 'message-existing-inbound',
      candidateId: 'candidate-handoff-test',
      waMessageId: 'wamid.question.test',
      direction: 'INBOUND',
      messageType: 'TEXT',
      body: '¿Dónde debo presentarme para la entrevista?',
      rawPayload: {},
      respondedAt: new Date('2026-08-25T14:05:03.000Z'),
      createdAt: new Date('2026-08-25T14:05:00.000Z')
    }
  });
  const middleware = interviewCoordinationHandoffMiddleware(harness.prisma, {
    extractMessages: () => [questionMessage()],
    sendText: harness.sendText
  });

  await middleware({ body: {} }, {}, harness.next);

  assert.equal(harness.calls.next, 1);
  assert.equal(harness.calls.sends.length, 0);
  assert.equal(harness.candidate.botPaused, true);
});

test('la política reconoce preguntas y recupera el contexto de la citación entregada', () => {
  assert.equal(isInterviewCoordinationQuestion('¿A qué hora debo llegar?'), true);
  assert.equal(isInterviewCoordinationQuestion('Dirección por favor'), true);
  assert.equal(isInterviewCoordinationQuestion('Confirmo asistencia'), false);

  const context = resolveInterviewCoordinationOutreachContext([{
    direction: 'OUTBOUND',
    body: 'Te esperamos el 27 de agosto de 2026 a las 8:00 a. m. en Dirección Prueba.\nContacto: +57 300 765 4321',
    rawPayload: {
      source: 'admin_interview_template',
      delivery: { state: 'SENT' }
    }
  }]);
  assert.equal(context.interviewDate, '27 de agosto de 2026');
  assert.equal(context.interviewTime, '8:00 a. m.');
  assert.equal(context.interviewAddress, 'Dirección Prueba');
  assert.equal(context.coordinatorPhone, '+57 300 765 4321');
});
