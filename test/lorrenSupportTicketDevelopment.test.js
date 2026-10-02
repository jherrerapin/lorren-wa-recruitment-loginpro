import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  dispatchLorrenSupportDevelopment,
  lorrenSupportDevelopmentReadiness,
  loadLorrenSupportDevelopmentDispatch
} from '../src/services/lorrenSupportDevelopmentDispatch.js';

function fakePrisma() {
  const events = [];
  return {
    events,
    devAuditEvent: {
      async findFirst({ where }) {
        return [...events].reverse().find((row) => (
          row.entityType === where.entityType
          && row.entityId === where.entityId
          && row.action === where.action
        )) || null;
      },
      async create({ data }) {
        const row = { id: `audit-${events.length + 1}`, createdAt: new Date('2026-10-02T01:00:00.000Z'), ...data };
        events.push(row);
        return row;
      }
    }
  };
}

function ticket() {
  return {
    id: 'ticket-test-1',
    publicCode: 'TCK-TEST0001',
    priority: 'ALTA',
    originalText: 'Mover el botón de despacho a la zona operativa correcta.',
    interpretation: {
      title: 'Reubicar botón de despacho',
      module: 'DESPACHO',
      type: 'MEJORA_UX',
      summary: 'Se solicita reubicar un control existente.',
      expectedBehavior: 'El botón debe aparecer en la ubicación operativa adecuada.',
      confidence: 'ALTA',
      suggestedPriority: 'ALTA'
    },
    developmentRequestedAt: '2026-10-02T00:50:00.000Z',
    developmentRequestedBy: 'dev-prueba'
  };
}

test('readiness exige token y origen de callback pero conserva repositorio canónico por defecto', () => {
  const readiness = lorrenSupportDevelopmentReadiness({});
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing, [
    'LORREN_SUPPORT_GITHUB_TOKEN',
    'LORREN_PUBLIC_ORIGIN/RAILWAY_PUBLIC_DOMAIN'
  ]);
  assert.equal(readiness.repository, 'jherrerapin/lorren-wa-recruitment-loginpro');
  assert.equal(readiness.usageCallbackUrl, null);
});

test('sin configuración aprueba sin fingir que hubo dispatch', async () => {
  const prisma = fakePrisma();
  let posts = 0;
  const result = await dispatchLorrenSupportDevelopment(prisma, ticket(), {
    env: {},
    axiosClient: { post: async () => { posts += 1; } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
  assert.equal(posts, 0);
  assert.equal(prisma.events.length, 0);
});

test('dispatch configurado envía solo el evento aprobado, audita e idempotentiza reintentos', async () => {
  const prisma = fakePrisma();
  const calls = [];
  const options = {
    env: {
      LORREN_SUPPORT_GITHUB_TOKEN: 'token-de-prueba',
      LORREN_SUPPORT_GITHUB_REPOSITORY: 'jherrerapin/lorren-wa-recruitment-loginpro',
      RAILWAY_PUBLIC_DOMAIN: 'lorren.example.up.railway.app'
    },
    actor: { actorUsername: 'dev-prueba', actorRole: 'dev' },
    axiosClient: {
      async post(url, body, config) {
        calls.push({ url, body, config });
        return { status: 204 };
      }
    }
  };

  const first = await dispatchLorrenSupportDevelopment(prisma, ticket(), options);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.match(first.dispatchId, /^[a-f0-9]{24}$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.event_type, 'lorren_support_ticket_approved');
  assert.equal(calls[0].body.client_payload.ticket_id, 'ticket-test-1');
  assert.equal(calls[0].body.client_payload.original_text, ticket().originalText);
  assert.equal(calls[0].body.client_payload.interpretation.title, 'Reubicar botón de despacho');
  assert.equal(
    calls[0].body.client_payload.usage_callback_url,
    'https://lorren.example.up.railway.app/admin/lorren-tickets/internal/development-usage'
  );
  assert.match(calls[0].config.headers.Authorization, /^Bearer /);

  const persisted = await loadLorrenSupportDevelopmentDispatch(prisma, 'ticket-test-1');
  assert.equal(persisted.dispatchId, first.dispatchId);
  assert.equal(persisted.publicCode, 'TCK-TEST0001');

  const second = await dispatchLorrenSupportDevelopment(prisma, ticket(), options);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.dispatchId, first.dispatchId);
  assert.equal(calls.length, 1);
});

test('panel DEV conecta aprobación con dispatch, telemetría y sin confirm nativo ni outbound WhatsApp', () => {
  const route = fs.readFileSync(new URL('../src/routes/lorrenSupportTicketsAdmin.js', import.meta.url), 'utf8');
  assert.match(route, /dispatchLorrenSupportDevelopment\(prisma, ticket/);
  assert.match(route, /loadLorrenAiUsageSummary\(prisma\)/);
  assert.match(route, /internal\/development-usage/);
  assert.match(route, /Consumo IA · corte diario UTC/);
  assert.match(route, /status: 'EN_PROCESO'/);
  assert.doesNotMatch(route, /\bconfirm\s*\(/);
  assert.doesNotMatch(route, /send.*Whatsapp/i);
});

test('workflow usa Codex aislado, reporta uso firmado y solo abre PR draft', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/lorren-support-ticket-development.yml', import.meta.url), 'utf8');
  assert.match(workflow, /repository_dispatch:/);
  assert.match(workflow, /lorren_support_ticket_approved/);
  assert.match(workflow, /uses: openai\/codex-action@v1/);
  assert.match(workflow, /codex-home: \$\{\{ runner\.temp \}\}\/lorren-ticket-codex/);
  assert.match(workflow, /permission-profile: ':workspace'/);
  assert.match(workflow, /Report Codex token usage/);
  assert.match(workflow, /total_token_usage/);
  assert.match(workflow, /x-lorren-usage-signature/);
  assert.match(workflow, /AbortSignal\.timeout\(10000\)/);
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /--draft/);
  assert.match(workflow, /Protected path modified by automated ticket/);
  assert.doesNotMatch(workflow, /gh pr merge/);
  assert.doesNotMatch(workflow, /railway\s+(up|deploy)/i);
  assert.doesNotMatch(workflow, /kubectl\s+(apply|rollout)/i);
});
