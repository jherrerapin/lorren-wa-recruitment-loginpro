import { buildInboundResumeUpdate } from './botAutomationPolicy.js';

function requireCandidateClient(client) {
  if (
    typeof client?.candidate?.updateMany !== 'function'
    || typeof client?.candidate?.findUnique !== 'function'
  ) {
    throw new TypeError('candidate_state_client_required');
  }
  return client;
}

function requireCandidateId(candidateId) {
  const normalized = String(candidateId || '').trim();
  if (!normalized) throw new TypeError('candidate_id_required');
  return normalized;
}

function requireNonEmptyString(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${fieldName}_required`);
  return normalized;
}

function requireValidDate(value, fieldName) {
  if (value === null || typeof value === 'boolean') {
    throw new TypeError(`${fieldName}_invalid`);
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${fieldName}_invalid`);
  return date;
}

function normalizeExpectedPauseSnapshot(expected = {}, { requirePaused = false } = {}) {
  if (typeof expected?.botPaused !== 'boolean') {
    throw new TypeError('candidate_expected_pause_snapshot_required');
  }
  if (requirePaused && expected.botPaused !== true) {
    throw new TypeError('candidate_expected_paused_state_required');
  }

  return {
    botPaused: expected.botPaused,
    botPausedAt: expected.botPausedAt == null
      ? null
      : requireValidDate(expected.botPausedAt, 'candidate_expected_bot_paused_at'),
    botPausedBy: expected.botPausedBy ?? null,
    botPauseReason: expected.botPauseReason ?? null,
    botResumeMode: expected.botResumeMode ?? null
  };
}

async function loadCandidateTransitionMiss(client, candidateId) {
  const candidate = await client.candidate.findUnique({
    where: { id: candidateId }
  });
  return { count: 0, candidate };
}

async function applyConditionalCandidatePauseTransition(client, {
  candidateId,
  expected,
  data
}) {
  const result = await client.candidate.updateMany({
    where: {
      id: candidateId,
      ...expected
    },
    data
  });

  const candidate = await client.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate
  };
}

export async function resumeCandidateAutomationOnInbound(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeExpectedPauseSnapshot(input.expected, { requirePaused: true });
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_resume_now');

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected,
    data: buildInboundResumeUpdate(now)
  });
}

export async function pauseCandidateAutomationFromAdmin(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeExpectedPauseSnapshot(input.expected);
  const actor = requireNonEmptyString(input.actor, 'candidate_pause_actor');
  const reason = requireNonEmptyString(input.reason, 'candidate_pause_reason');
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_pause_now');

  if (expected.botPaused) {
    return loadCandidateTransitionMiss(candidateClient, candidateId);
  }

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected,
    data: {
      botPaused: true,
      botPausedAt: now,
      botPausedBy: actor,
      botPauseReason: reason,
      botResumeMode: 'manual_resume_dashboard',
      reminderScheduledFor: null,
      reminderState: 'CANCELLED'
    }
  });
}

export async function resumeCandidateAutomationFromAdmin(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeExpectedPauseSnapshot(input.expected);

  if (!expected.botPaused) {
    return loadCandidateTransitionMiss(candidateClient, candidateId);
  }

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected,
    data: {
      botPaused: false,
      botPausedAt: null,
      botPausedBy: null,
      botPauseReason: null,
      botResumeMode: 'manual_resume_dashboard',
      reminderScheduledFor: null,
      reminderState: 'CANCELLED'
    }
  });
}
