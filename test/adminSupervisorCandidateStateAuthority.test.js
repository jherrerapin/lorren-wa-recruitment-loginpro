import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import axios from 'axios';
import { MessageDirection } from '@prisma/client';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import {
  handleSupervisorInbound,
  notifySupervisorManualReview
} from '../src/services/adminSupervisor.js';

function between(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró el marcador inicial: ${start}`);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `No se encontró el marcador final: ${end}`);
  return content.slice(startIndex, endIndex);
}

function withWhatsappMock(fn) {
  return async () => {
    process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
    process.env.META_ACCESS_TOKEN = 'meta-access-token';
    process.env.ADMIN_WHATSAPP_NUMBER = '3052982551';
    delete process.env.OPENAI_API_KEY;
    const whatsappMock = createWhatsappMock();
    const originalPost = axios.post.bind(axios);
    axios.post = async (url, payload, config) => {
      if (String(url).includes('graph.facebook.com')) {
        return { data: whatsappMock.handleSend(url, payload, config) };
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

const source = fs.readFileSync('src/services/adminSupervisor.js', 'utf8');
const answerDeliveryBlock = between(
  source,
  '  await sendTextMessage(candidate.phone, candidateReply);',
  '  await addSupervisorKnowledge('
);

test('adminSupervisor delega la resolución posterior al envío y conserva fuera los escritores técnicos', () => {
  assert.match(
    source,
    /import \{ completeSupervisorReviewAfterDelivery \} from '\.\/candidateStateService\.js';/
  );
  assert.match(answerDeliveryBlock, /completeSupervisorReviewAfterDelivery\(prisma,\s*\{/);
  assert.doesNotMatch(
    answerDeliveryBlock,
    /prisma\.candidate\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/
  );
  assert.equal((source.match(/prisma\.candidate\.update\s*\(/g) || []).length, 2);
  assert.match(source, /prisma\.candidate\.upsert\s*\(/);
  assert.match(source, /data: \{ lastOutboundAt: now \}/);
  assert.match(source, /data: \{ lastInboundAt: new Date\(\) \}/);
});

test('persiste evidencia antes de mutar Candidate y registra la transición aplicada', withWhatsappMock(async (whatsappMock) => {
  const pausedAt = new Date('2026-07-16T04:00:00.000Z');
  const previousOutboundAt = new Date('2026-07-16T03:40:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'candidate-supervisor-success',
      phone: '573001112233',
      fullName: 'Candidato Supervisor',
      botPaused: true,
      botPausedAt: pausedAt,
      botPausedBy: 'admin-supervisor',
      botPauseReason: 'Intervención humana requerida',
      botResumeMode: 'awaiting_inbound_after_human_intervention',
      lastOutboundAt: previousOutboundAt,
      currentStep: 'ASK_CV'
    }, {
      id: 'admin-candidate',
      phone: '3052982551',
      fullName: 'Administrador del sistema'
    }]
  });
  const candidate = await prisma.candidate.findUnique({ where: { id: 'candidate-supervisor-success' } });
  await notifySupervisorManualReview(prisma, candidate, {
    reason: 'Duda requiere validación',
    inboundText: '¿El turno es nocturno?'
  });

  const order = [];
  const originalMessageCreate = prisma.message.create.bind(prisma.message);
  prisma.message.create = async (args) => {
    if (args?.data?.rawPayload?.source === 'admin_supervisor_answer') order.push('message');
    return originalMessageCreate(args);
  };
  const originalCandidateUpdateMany = prisma.candidate.updateMany.bind(prisma.candidate);
  prisma.candidate.updateMany = async (args) => {
    if (args?.where?.id === candidate.id) order.push('candidate');
    return originalCandidateUpdateMany(args);
  };

  const result = await handleSupervisorInbound(prisma, {
    id: 'wamid-supervisor-success',
    from: '3052982551',
    type: 'text',
    text: { body: 'Sí, el turno disponible es nocturno.' }
  });

  assert.equal(result.action, 'answered_candidate');
  assert.equal(result.candidateStateApplied, true);
  assert.deepEqual(order, ['message', 'candidate']);
  assert.equal(whatsappMock.sentMessages.length, 2);
  assert.equal(whatsappMock.sentMessages[1].to, candidate.phone);

  const updatedCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
  assert.equal(updatedCandidate.botPaused, false);
  assert.equal(updatedCandidate.botPausedAt, null);
  assert.equal(updatedCandidate.botPausedBy, null);
  assert.equal(updatedCandidate.botPauseReason, null);
  assert.equal(updatedCandidate.botResumeMode, null);
  assert.ok(updatedCandidate.lastOutboundAt instanceof Date);
  assert.ok(updatedCandidate.lastOutboundAt.getTime() >= previousOutboundAt.getTime());

  const request = prisma.state.messages.find((message) => message.rawPayload?.source === 'admin_manual_review_request');
  assert.equal(request.rawPayload.resolved, true);
  assert.equal(request.rawPayload.resolvedBy, 'admin_supervisor_answer_delivered');
  assert.equal(request.rawPayload.candidateStateApplied, true);
  assert.equal(request.rawPayload.candidateStateConflict, null);

  const answer = prisma.state.messages.find((message) => (
    message.direction === MessageDirection.OUTBOUND
    && message.rawPayload?.source === 'admin_supervisor_answer'
  ));
  assert.ok(answer);
  assert.ok(answer.rawPayload.deliveredAt);
  assert.equal(answer.rawPayload.requestMessageId, request.id);
}));

test('una pausa concurrente conserva la evidencia, resuelve la solicitud y no se sobrescribe', withWhatsappMock(async (whatsappMock) => {
  const pausedAt = new Date('2026-07-16T04:00:00.000Z');
  const previousOutboundAt = new Date('2026-07-16T03:40:00.000Z');
  const concurrentPausedAt = new Date('2026-07-16T04:09:00.000Z');
  const concurrentOutboundAt = new Date('2026-07-16T04:11:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'candidate-supervisor-conflict',
      phone: '573004445566',
      fullName: 'Candidato en conflicto',
      botPaused: true,
      botPausedAt: pausedAt,
      botPausedBy: 'admin-supervisor',
      botPauseReason: 'Intervención humana requerida',
      botResumeMode: 'awaiting_inbound_after_human_intervention',
      lastOutboundAt: previousOutboundAt,
      currentStep: 'ASK_CV'
    }, {
      id: 'admin-candidate',
      phone: '3052982551',
      fullName: 'Administrador del sistema'
    }]
  });
  const candidate = await prisma.candidate.findUnique({ where: { id: 'candidate-supervisor-conflict' } });
  await notifySupervisorManualReview(prisma, candidate, {
    reason: 'Duda requiere validación',
    inboundText: '¿Qué documento debo llevar?'
  });

  const originalCandidateUpdateMany = prisma.candidate.updateMany.bind(prisma.candidate);
  let conflictInjected = false;
  prisma.candidate.updateMany = async (args) => {
    if (!conflictInjected && args?.where?.id === candidate.id) {
      conflictInjected = true;
      const stored = prisma.state.candidates.find((item) => item.id === candidate.id);
      Object.assign(stored, {
        botPaused: true,
        botPausedAt: concurrentPausedAt,
        botPausedBy: 'otro-admin',
        botPauseReason: 'Intervención concurrente posterior',
        botResumeMode: 'manual_resume_dashboard',
        lastOutboundAt: concurrentOutboundAt
      });
    }
    return originalCandidateUpdateMany(args);
  };

  const result = await handleSupervisorInbound(prisma, {
    id: 'wamid-supervisor-conflict',
    from: '3052982551',
    type: 'text',
    text: { body: 'Debes llevar tu documento original.' }
  });

  assert.equal(result.action, 'answered_candidate');
  assert.equal(result.candidateStateApplied, false);
  assert.equal(whatsappMock.sentMessages.length, 2);
  assert.equal(whatsappMock.sentMessages[1].to, candidate.phone);

  const currentCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
  assert.equal(currentCandidate.botPaused, true);
  assert.equal(currentCandidate.botPausedBy, 'otro-admin');
  assert.equal(currentCandidate.botPauseReason, 'Intervención concurrente posterior');
  assert.equal(currentCandidate.botResumeMode, 'manual_resume_dashboard');
  assert.equal(currentCandidate.lastOutboundAt.getTime(), concurrentOutboundAt.getTime());

  const request = prisma.state.messages.find((message) => message.rawPayload?.source === 'admin_manual_review_request');
  assert.equal(request.rawPayload.resolved, true);
  assert.equal(request.rawPayload.resolvedBy, 'admin_supervisor_answer_delivered');
  assert.equal(request.rawPayload.candidateStateApplied, false);
  assert.equal(
    request.rawPayload.candidateStateConflict.reason,
    'candidate_snapshot_changed_after_supervisor_delivery'
  );
  assert.equal(request.rawPayload.candidateStateConflict.observed.botPausedBy, 'otro-admin');
  assert.equal(
    request.rawPayload.candidateStateConflict.observed.lastOutboundAt,
    concurrentOutboundAt.toISOString()
  );

  const answers = prisma.state.messages.filter((message) => message.rawPayload?.source === 'admin_supervisor_answer');
  assert.equal(answers.length, 1);
}));
