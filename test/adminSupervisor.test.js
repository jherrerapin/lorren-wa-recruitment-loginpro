import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { MessageDirection } from '@prisma/client';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import { ensureSupervisorWindowOpen, handleSupervisorInbound, notifySupervisorManualReview } from '../src/services/adminSupervisor.js';

function withWhatsappMock(fn) {
  return async () => {
    process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
    process.env.META_ACCESS_TOKEN = 'meta-access-token';
    process.env.ADMIN_WHATSAPP_NUMBER = '3052982551';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const whatsappMock = createWhatsappMock();
    const originalPost = axios.post.bind(axios);
    axios.post = async (url, payload, config) => {
      if (String(url).includes('graph.facebook.com')) {
        return { data: whatsappMock.handleSend(url, payload, config) };
      }
      if (String(url).includes('api.openai.com/v1/responses')) {
        return {
          data: {
            output: [{
              content: [{
                parsed: {
                  reply: 'Claro, el turno disponible es nocturno de domingo a domingo.',
                  reason: 'redaccion_natural_sin_agregar_datos'
                }
              }]
            }]
          }
        };
      }
      return originalPost(url, payload, config);
    };
    try {
      await fn(whatsappMock);
    } finally {
      axios.post = originalPost;
      delete process.env.ADMIN_WHATSAPP_NUMBER;
      delete process.env.OPENAI_API_KEY;
    }
  };
}

test('mantiene ventana de administrador con punto antes de 24 horas', withWhatsappMock(async (whatsappMock) => {
  const prisma = createMockPrisma({
    candidates: [{
      id: 'admin-candidate',
      phone: '3052982551',
      fullName: 'Administrador',
      lastInboundAt: new Date('2026-05-16T00:00:00Z')
    }]
  });

  const sent = await ensureSupervisorWindowOpen(prisma, { now: new Date('2026-05-16T23:10:00Z') });

  assert.equal(sent, true);
  assert.equal(whatsappMock.sentMessages.length, 1);
  assert.equal(whatsappMock.sentMessages[0].to, '3052982551');
  assert.equal(whatsappMock.sentMessages[0].body, '.');
  assert.ok(prisma.state.messages.some((message) => message.rawPayload?.source === 'admin_window_keepalive_dot'));
}));

test('escala duda al administrador, aplica respuesta al candidato y crea aprendizaje', withWhatsappMock(async (whatsappMock) => {
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-1',
      phone: '573001112233',
      fullName: 'Candidato Uno',
      botPaused: false,
      currentStep: 'ASK_CV'
    }]
  });
  const candidate = await prisma.candidate.findUnique({ where: { id: 'cand-1' } });

  await notifySupervisorManualReview(prisma, candidate, {
    reason: 'Duda posterior requiere intervencion manual',
    inboundText: '¿El turno es nocturno?'
  });
  await prisma.candidate.update({ where: { id: 'cand-1' }, data: { botPaused: true } });

  assert.equal(whatsappMock.sentMessages.length, 1);
  assert.equal(whatsappMock.sentMessages[0].to, '3052982551');
  assert.match(whatsappMock.sentMessages[0].body, /¿El turno es nocturno\?/);

  const result = await handleSupervisorInbound(prisma, {
    id: 'wamid-admin-1',
    from: '3052982551',
    type: 'text',
    text: { body: 'Sí, el turno disponible es nocturno de domingo a domingo.' }
  });

  assert.equal(result.action, 'answered_candidate');
  assert.equal(whatsappMock.sentMessages.length, 2);
  assert.equal(whatsappMock.sentMessages[1].to, '573001112233');
  assert.equal(whatsappMock.sentMessages[1].body, 'Claro, el turno disponible es nocturno de domingo a domingo.');

  const updated = await prisma.candidate.findUnique({ where: { id: 'cand-1' } });
  assert.equal(updated.botPaused, false);
  const supervisorAnswer = prisma.state.messages.find((message) => message.direction === MessageDirection.OUTBOUND && message.rawPayload?.source === 'admin_supervisor_answer');
  assert.ok(supervisorAnswer);
  assert.equal(supervisorAnswer.rawPayload.aiFallbackUsed, false);
  assert.equal(supervisorAnswer.rawPayload.originalSupervisorInstruction, 'Sí, el turno disponible es nocturno de domingo a domingo.');
  assert.equal(prisma.state.botKnowledge.length, 1);
  assert.match(prisma.state.botKnowledge[0].content, /Instruccion validada por administrador/);
  assert.match(prisma.state.botKnowledge[0].content, /Respuesta sugerida por Lorren/);
}));
