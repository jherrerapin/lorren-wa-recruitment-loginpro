import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`${label}_source_not_found`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`${label}_source_not_unique`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

const webhookPath = 'src/routes/webhook.js';
const candidateStatePath = 'src/services/candidateStateService.js';
const workflowPath = '.github/workflows/apply-candidate-multiline-authority.yml';
const scriptPath = 'scripts/apply-candidate-multiline-authority.mjs';

let webhook = fs.readFileSync(webhookPath, 'utf8');

webhook = replaceOnce(
  webhook,
  "import { resumeCandidateAutomationOnInbound } from '../services/candidateStateService.js';",
  `import {
  acquireCandidateMultilineBatch,
  resumeCandidateAutomationOnInbound,
  scheduleCandidateMultilineWindow
} from '../services/candidateStateService.js';`,
  'candidate_state_import'
);

webhook = replaceOnce(
  webhook,
  `async function scheduleMultilineWindow(prisma, candidateId, context = {}) {
  const windowMs = getMultilineWindowMs(context);
  const windowUntil = new Date(Date.now() + windowMs);
  const updated = await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      multilineWindowUntil: windowUntil,
      multilineBatchVersion: { increment: 1 }
    },
    select: { multilineBatchVersion: true }
  });

  return { windowMs, batchVersion: updated.multilineBatchVersion };
}`,
  `async function scheduleMultilineWindow(prisma, candidateId, context = {}) {
  const windowMs = getMultilineWindowMs(context);
  return scheduleCandidateMultilineWindow(prisma, {
    candidateId,
    windowMs,
    now: new Date()
  });
}`,
  'schedule_multiline_window'
);

webhook = replaceOnce(
  webhook,
  `async function tryAcquireMultilineProcessing(prisma, candidateId, batchVersion) {
  const acquired = await prisma.candidate.updateMany({
    where: {
      id: candidateId,
      multilineBatchVersion: batchVersion,
      multilineWindowUntil: { lte: new Date() }
    },
    data: {
      multilineWindowUntil: null,
      multilineBatchVersion: { increment: 1 }
    }
  });
  return acquired.count === 1;
}`,
  `async function tryAcquireMultilineProcessing(prisma, candidateId, scheduling = {}) {
  const acquired = await acquireCandidateMultilineBatch(prisma, {
    candidateId,
    expected: { multilineBatchVersion: scheduling.batchVersion },
    now: new Date()
  });
  return acquired.count === 1;
}`,
  'acquire_multiline_batch'
);

webhook = replaceOnce(
  webhook,
  'const stillOwner = await tryAcquireMultilineProcessing(prisma, candidate.id, scheduling.batchVersion);',
  'const stillOwner = await tryAcquireMultilineProcessing(prisma, candidate.id, scheduling);',
  'multiline_acquisition_call'
);

fs.writeFileSync(webhookPath, webhook);

let candidateState = fs.readFileSync(candidateStatePath, 'utf8');
if (candidateState.includes('export async function scheduleCandidateMultilineWindow')) {
  throw new Error('candidate_multiline_authority_already_present');
}

candidateState += `

function requireCandidateMultilineScheduleClient(client) {
  if (typeof client?.candidate?.update !== 'function') {
    throw new TypeError('candidate_multiline_schedule_client_required');
  }
  return client;
}

function requireCandidateMultilineAcquireClient(client) {
  if (typeof client?.candidate?.updateMany !== 'function') {
    throw new TypeError('candidate_multiline_acquire_client_required');
  }
  return client;
}

function requireMultilineWindowMs(value) {
  if (value === null || typeof value === 'boolean' || String(value).trim() === '') {
    throw new TypeError('candidate_multiline_window_ms_invalid');
  }
  const windowMs = Number(value);
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new TypeError('candidate_multiline_window_ms_invalid');
  }
  return windowMs;
}

function requireMultilineBatchVersion(value) {
  if (value === null || typeof value === 'boolean' || String(value).trim() === '') {
    throw new TypeError('candidate_multiline_batch_version_invalid');
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError('candidate_multiline_batch_version_invalid');
  }
  return version;
}

export async function scheduleCandidateMultilineWindow(client, input = {}) {
  const candidateClient = requireCandidateMultilineScheduleClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const windowMs = requireMultilineWindowMs(input.windowMs);
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_multiline_schedule_now');
  const windowUntil = new Date(now.getTime() + windowMs);

  const updated = await candidateClient.candidate.update({
    where: { id: candidateId },
    data: {
      multilineWindowUntil: windowUntil,
      multilineBatchVersion: { increment: 1 }
    },
    select: { multilineBatchVersion: true }
  });
  const batchVersion = requireMultilineBatchVersion(updated?.multilineBatchVersion);

  return { windowMs, windowUntil, batchVersion };
}

export async function acquireCandidateMultilineBatch(client, input = {}) {
  const candidateClient = requireCandidateMultilineAcquireClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const batchVersion = requireMultilineBatchVersion(input.expected?.multilineBatchVersion);
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_multiline_acquire_now');

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      multilineBatchVersion: batchVersion,
      multilineWindowUntil: { lte: now }
    },
    data: {
      multilineWindowUntil: null,
      multilineBatchVersion: { increment: 1 }
    }
  });

  return { count: Number(result?.count || 0) };
}
`;

fs.writeFileSync(candidateStatePath, candidateState);

fs.rmSync(workflowPath, { force: true });
fs.rmSync(scriptPath, { force: true });
