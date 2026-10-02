import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadLorrenAiUsageSummary,
  persistLorrenBotUsage,
  recordLorrenTicketDevelopmentUsage,
  signLorrenTicketDevelopmentUsage
} from '../src/services/lorrenAiUsageCounter.js';

function fakePrisma() {
  const auditEvents = [];
  const client = {
    auditEvents,
    cvAnalysisUsage: {
      async findMany() {
        return [
          { inputTokens: 200, cachedInputTokens: 50, outputTokens: 40, reasoningTokens: 10, totalTokens: 240 }
        ];
      }
    },
    devAuditEvent: {
      async findMany({ where }) {
        return auditEvents.filter((row) => row.entityType === where.entityType && row.action === where.action);
      },
      async findFirst({ where }) {
        return auditEvents.find((row) => row.entityType === where.entityType && row.entityId === where.entityId && row.action === where.action) || null;
      },
      async create({ data }) {
        const row = { id: `usage-${auditEvents.length + 1}`, createdAt: new Date('2026-10-02T12:00:00.000Z'), ...data };
        auditEvents.push(row);
        return row;
      }
    }
  };
  client.$transaction = async (callback) => callback(client);
  return client;
}

test('consolida BOT, CV y desarrollo de tickets usando telemetría provider-reported', async () => {
  const prisma = fakePrisma();
  await persistLorrenBotUsage(prisma, {
    source: 'CANDIDATE_EXTRACTION',
    model: 'gpt-5.6-terra',
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }
  });
  await persistLorrenBotUsage(prisma, {
    source: 'CONVERSATION_REPLY',
    model: 'gpt-4o-mini',
    usage: { input_tokens: 70, output_tokens: 20, total_tokens: 90 }
  });
  prisma.auditEvents.push({
    entityType: 'LORREN_AI_USAGE',
    entityId: 'dispatch-1',
    action: 'TICKET_DEVELOPMENT_USAGE',
    createdAt: new Date('2026-10-02T12:00:00.000Z'),
    metadata: {
      inputTokens: 400,
      cachedInputTokens: 100,
      outputTokens: 80,
      reasoningTokens: 20,
      totalTokens: 480
    }
  });

  const summary = await loadLorrenAiUsageSummary(prisma, {
    now: new Date('2026-10-02T15:00:00.000Z'),
    env: { OPENAI_SHARED_DAILY_TOKEN_BUDGET: '2500000' }
  });

  assert.equal(summary.bot.totalTokens, 240);
  assert.equal(summary.bot.events, 2);
  assert.equal(summary.cv.totalTokens, 240);
  assert.equal(summary.cv.cachedInputTokens, 50);
  assert.equal(summary.ticketDevelopment.totalTokens, 480);
  assert.equal(summary.totalTokens, 960);
  assert.equal(summary.remainingTokens, 2_499_040);
  assert.deepEqual(summary.coverage, { bot: true, cv: true, ticketDevelopment: true });
  assert.equal(summary.period.timeZone, 'UTC');
});

test('callback firmado persiste uso de Codex una sola vez y no guarda contenido del ticket', async () => {
  const prisma = fakePrisma();
  const env = { LORREN_SUPPORT_GITHUB_TOKEN: 'token-compartido-de-prueba' };
  const payload = {
    schema_version: 1,
    dispatch_id: 'abc123',
    public_code: 'TCK-TEST0002',
    run_id: '12345',
    input_tokens: 900,
    cached_input_tokens: 700,
    output_tokens: 100,
    reasoning_tokens: 20,
    total_tokens: 1000
  };
  const signature = `sha256=${signLorrenTicketDevelopmentUsage(payload, env.LORREN_SUPPORT_GITHUB_TOKEN)}`;

  const first = await recordLorrenTicketDevelopmentUsage(prisma, { signature, payload, env });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(prisma.auditEvents.length, 1);
  assert.deepEqual(prisma.auditEvents[0].metadata, {
    schemaVersion: 1,
    dispatchId: 'abc123',
    publicCode: 'TCK-TEST0002',
    runId: '12345',
    inputTokens: 900,
    cachedInputTokens: 700,
    outputTokens: 100,
    reasoningTokens: 20,
    totalTokens: 1000
  });

  const second = await recordLorrenTicketDevelopmentUsage(prisma, { signature, payload, env });
  assert.equal(second.duplicate, true);
  assert.equal(prisma.auditEvents.length, 1);
});

test('rechaza callbacks sin firma válida', async () => {
  const prisma = fakePrisma();
  const payload = { dispatch_id: 'abc123', public_code: 'TCK-TEST0003', total_tokens: 100 };
  await assert.rejects(
    recordLorrenTicketDevelopmentUsage(prisma, {
      signature: 'sha256=' + '0'.repeat(64),
      payload,
      env: { LORREN_SUPPORT_GITHUB_TOKEN: 'token-correcto' }
    }),
    /lorren_ai_usage_signature_invalid/
  );
  assert.equal(prisma.auditEvents.length, 0);
});
