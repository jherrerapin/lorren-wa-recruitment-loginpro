import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import {
  handleSupervisorInbound,
  notifySupervisorAttachment
} from '../src/services/adminSupervisor.js';
import { shouldResumeAutomationOnInbound } from '../src/services/botAutomationPolicy.js';

function withAudioEscalationMocks(fn) {
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
          return {
            data: {
              output: [{
                content: [{
                  parsed: {
                    action: 'ANSWER_CANDIDATE',
                    candidateInstruction: userPayload.adminMessage || '',
                    reason: 'instruccion_del_supervisor_para_el_candidato',
                    confidence: 1
                  }
                }]
              }]
            }
          };
        }

        if (schemaName === 'supervisor_candidate_reply') {
          return {
            data: {
              output: [{
                content: [{
                  parsed: {
                    reply: 'Perfecto, puedes continuar con el proceso normalmente.',
                    reason: 'redaccion_natural_de_la_instruccion_humana'
                  }
                }]
              }]
            }
          };
        }
      }

      return originalPost(url, payload, config);
    };

    try {
      await fn(whatsappMock);
    } finally {
      axios.post = originalPost;
      delete process.env.ADMIN_WHATSAPP_NUMBER;
      delete process.env.OPENAI_API_KEY;
      delete process.env.META_PHONE_NUMBER_ID;
      delete process.env.META_ACCESS_TOKEN;
    }
  };
}

test('audio queda en espera humana, no se transcribe y solo responde al candidato después del DEV', withAudioEscalationMocks(async (whatsappMock) => {
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-audio-review',
      phone: '573209998877',
      fullName: 'María Audio',
      currentStep: 'COLLECTING_DATA'
    }, {
      id: 'admin-candidate',
      phone: '3052982551',
      fullName: 'Administrador del sistema'
    }]
  });

  const candidate = await prisma.candidate.findUnique({ where: { id: 'cand-audio-review' } });

  await notifySupervisorAttachment(prisma, candidate, {
    mediaType: 'audio',
    media: { id: 'audio-review-1', mime_type: 'audio/ogg' },
    caption: 'audio/ogg'
  });

  const pausedCandidate = await prisma.candidate.findUnique({ where: { id: 'cand-audio-review' } });
  assert.equal(pausedCandidate.botPaused, true);
  assert.equal(pausedCandidate.botPausedBy, 'audio_human_review');
  assert.equal(pausedCandidate.botPauseReason, 'Audio recibido pendiente de revisión humana');
  assert.equal(pausedCandidate.botResumeMode, 'manual_pause_until_admin_resume');
  assert.equal(shouldResumeAutomationOnInbound(pausedCandidate), false);

  const pendingRequest = prisma.state.messages.find((message) => (
    message.rawPayload?.source === 'admin_manual_review_request'
    && message.rawPayload?.candidateId === 'cand-audio-review'
  ));
  assert.ok(pendingRequest);
  assert.equal(pendingRequest.rawPayload.manualReviewType, 'audio');
  assert.equal(pendingRequest.rawPayload.mediaId, 'audio-review-1');
  assert.equal(pendingRequest.rawPayload.audioRequiresHumanListening, true);
  assert.equal(pendingRequest.rawPayload.transcriptionUsed, false);
  assert.equal(pendingRequest.rawPayload.resolved, false);

  assert.equal(whatsappMock.sentMessages.some((message) => message.to === '573209998877'), false);
  assert.equal(whatsappMock.sentMessages.some((message) => (
    message.to === '3052982551'
    && message.payload?.type === 'audio'
    && message.payload?.audio?.id === 'audio-review-1'
  )), true);

  const result = await handleSupervisorInbound(prisma, {
    id: 'wamid-admin-audio-review',
    from: '3052982551',
    type: 'text',
    text: { body: 'Dile que puede continuar con el proceso normalmente.' }
  });

  assert.equal(result.action, 'answered_candidate');
  assert.equal(whatsappMock.sentMessages.some((message) => (
    message.to === '573209998877'
    && message.body === 'Perfecto, puedes continuar con el proceso normalmente.'
  )), true);

  const resumedCandidate = await prisma.candidate.findUnique({ where: { id: 'cand-audio-review' } });
  assert.equal(resumedCandidate.botPaused, false);
  assert.equal(resumedCandidate.botPausedAt, null);
  assert.equal(resumedCandidate.botPausedBy, null);
  assert.equal(resumedCandidate.botPauseReason, null);
  assert.equal(resumedCandidate.botResumeMode, null);

  const resolvedRequest = prisma.state.messages.find((message) => message.id === pendingRequest.id);
  assert.equal(resolvedRequest.rawPayload.resolved, true);
  assert.equal(resolvedRequest.rawPayload.resolvedBy, 'admin_supervisor_answer_delivered');
}));
