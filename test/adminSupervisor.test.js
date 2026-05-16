import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { MessageDirection } from '@prisma/client';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import { ensureSupervisorWindowOpen, handleSupervisorInbound, notifySupervisorAttachment, notifySupervisorManualReview } from '../src/services/adminSupervisor.js';

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
        const schemaName = payload?.text?.format?.name;
        if (schemaName === 'supervisor_inbound_decision') {
          const userPayload = JSON.parse(payload.input?.[1]?.content?.[0]?.text || '{}');
          const alreadyAnswered = Boolean(userPayload.conversationState?.manualOutboundAfterRequest);
          return {
            data: {
              output: [{
                content: [{
                  parsed: alreadyAnswered
                    ? { action: 'INTERNAL_ACK', candidateInstruction: '', reason: 'admin_validates_prior_manual_answer', confidence: 0.94 }
                    : { action: 'ANSWER_CANDIDATE', candidateInstruction: userPayload.adminMessage || '', reason: 'admin_provides_candidate_answer', confidence: 0.91 }
                }]
              }]
            }
          };
        }
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
  const manualRequest = prisma.state.messages.find((message) => message.rawPayload?.source === 'admin_manual_review_request');
  const supervisorCandidate = prisma.state.candidates.find((item) => item.phone === '3052982551');
  assert.equal(manualRequest.candidateId, supervisorCandidate.id);
  assert.equal(manualRequest.rawPayload.candidateId, 'cand-1');
  assert.equal(prisma.state.messages.some((message) => message.candidateId === 'cand-1' && message.rawPayload?.source === 'admin_manual_review_request'), false);

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

test('acuse interno contextual del administrador después de intervención manual no se reenvía al candidato', withWhatsappMock(async (whatsappMock) => {
  const requestCreatedAt = new Date('2026-05-16T14:00:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-ack',
      phone: '573204657596',
      fullName: 'Alexander Guzman',
      botPaused: true,
      currentStep: 'SCHEDULED'
    }, {
      id: 'admin-candidate',
      phone: '3052982551',
      fullName: 'Administrador del sistema'
    }],
    messages: [{
      id: 'manual-request-1',
      candidateId: 'cand-ack',
      direction: MessageDirection.OUTBOUND,
      messageType: 'TEXT',
      body: 'Lórren requiere apoyo humano.',
      createdAt: requestCreatedAt,
      rawPayload: {
        target: 'admin_supervisor',
        source: 'admin_manual_review_request',
        inboundText: '¿Solo hay entrevistas a las 10?',
        resolved: false
      }
    }, {
      id: 'manual-outbound-1',
      candidateId: 'cand-ack',
      direction: MessageDirection.OUTBOUND,
      messageType: 'TEXT',
      body: 'Hay más horarios disponibles, ya te confirmamos por este medio.',
      createdAt: new Date('2026-05-16T14:02:00.000Z'),
      rawPayload: {
        actor: 'RECRUITER',
        source: 'admin_outbound',
        sourceCategory: 'MANUAL_AUTHORIZED'
      }
    }]
  });

  const result = await handleSupervisorInbound(prisma, {
    id: 'wamid-admin-perfecto',
    from: '3052982551',
    type: 'text',
    text: { body: 'perfecto' }
  });

  assert.equal(result.action, 'internal_ack_resolved_after_manual_outbound');
  assert.equal(whatsappMock.sentMessages.length, 0);
  const request = await prisma.message.findUnique({ where: { id: 'manual-request-1' } });
  assert.equal(request.rawPayload.resolved, true);
  assert.equal(request.rawPayload.resolvedBy, 'manual_candidate_outbound_confirmed_by_supervisor_context');
  assert.equal(request.rawPayload.supervisorDecision.action, 'INTERNAL_ACK');
  assert.equal(prisma.state.messages.some((message) => message.rawPayload?.source === 'admin_supervisor_answer'), false);
}));

test('notificación de adjunto queda en hilo del administrador y no en chat del candidato', withWhatsappMock(async (whatsappMock) => {
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-attachment',
      phone: '573204657596',
      fullName: 'Alexander Guzman'
    }, {
      id: 'admin-candidate',
      phone: '3052982551',
      fullName: 'Administrador del sistema'
    }]
  });
  const candidate = await prisma.candidate.findUnique({ where: { id: 'cand-attachment' } });

  await notifySupervisorAttachment(prisma, candidate, {
    mediaType: 'document',
    media: { id: 'media-1', filename: 'hv.pdf', mime_type: 'application/pdf' },
    caption: 'hv.pdf'
  });

  assert.equal(whatsappMock.sentMessages[0].to, '3052982551');
  assert.match(whatsappMock.sentMessages[0].body, /Documento recibido de 573204657596 \(Alexander Guzman\)/);
  assert.equal(whatsappMock.sentMessages.some((message) => message.to === '573204657596'), false);
  const notice = prisma.state.messages.find((message) => message.rawPayload?.source === 'admin_attachment_forward_notice');
  assert.equal(notice.candidateId, 'admin-candidate');
  assert.equal(notice.rawPayload.candidateId, 'cand-attachment');
}));
