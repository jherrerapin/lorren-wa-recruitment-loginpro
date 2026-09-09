import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DATA_CONSENT_BUTTONS,
  DATA_CONSENT_VERSION,
  buildDataConsentPromptReply
} from '../src/services/dataConsentGate.js';
import {
  buildConsentResendIdempotencyKey,
  buildDevConsentResendForm,
  canShowDevConsentResend,
  injectDevConsentResendAction,
  resendDataConsentFromDev
} from '../src/routes/devConsentResend.js';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const NONCE = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_NONCE = '123e4567-e89b-42d3-a456-426614174001';

function candidate(overrides = {}) {
  return {
    id: 'candidate-1',
    phone: '573001112233',
    dataConsentStatus: 'PENDING',
    ...overrides
  };
}

function prismaHarness(candidateValue = candidate(), inboundAt = new Date(NOW.getTime() - 60_000)) {
  return {
    candidate: {
      findUnique: async () => candidateValue ? structuredClone(candidateValue) : null
    },
    message: {
      findFirst: async () => inboundAt ? { createdAt: new Date(inboundAt) } : null
    }
  };
}

test('botón DEV aparece solo para consentimiento PENDING y respeta ventana de 24h', () => {
  assert.equal(canShowDevConsentResend(candidate()), true);
  assert.equal(canShowDevConsentResend(candidate({ dataConsentStatus: 'ACCEPTED' })), false);
  assert.equal(canShowDevConsentResend(candidate({ dataConsentStatus: 'REVOKED' })), false);

  const enabled = buildDevConsentResendForm({
    candidate: candidate(),
    outboundWindow: { isOpen: true },
    nonce: NONCE
  });
  assert.match(enabled, /Reenviar autorización/);
  assert.match(enabled, new RegExp(NONCE));
  assert.doesNotMatch(enabled, /disabled/);

  const disabled = buildDevConsentResendForm({
    candidate: candidate(),
    outboundWindow: { isOpen: false },
    nonce: NONCE
  });
  assert.match(disabled, /disabled title="Ventana de 24h cerrada"/);

  assert.equal(buildDevConsentResendForm({
    candidate: candidate({ dataConsentStatus: 'ACCEPTED' }),
    outboundWindow: { isOpen: true },
    nonce: NONCE
  }), '');
});

test('acción se inyecta dentro del historial del chat y no altera vistas sin marcador', () => {
  const html = '<div class="card"><h2>Historial de conversación</h2><div class="messages-list"></div></div>';
  const injected = injectDevConsentResendAction(html, {
    candidate: candidate(),
    outboundWindow: { isOpen: true },
    nonce: NONCE
  });
  assert.match(injected, /Historial de conversación<\/h2>[\s\S]*Reenviar autorización/);
  assert.equal(injectDevConsentResendAction('<main>otra vista</main>', {
    candidate: candidate(), outboundWindow: { isOpen: true }, nonce: NONCE
  }), '<main>otra vista</main>');
});

test('idempotencia usa candidato + versión + nonce: mismo render repite clave y nueva página permite otra', () => {
  const first = buildConsentResendIdempotencyKey('candidate-1', NONCE);
  const same = buildConsentResendIdempotencyKey('candidate-1', NONCE);
  const nextRender = buildConsentResendIdempotencyKey('candidate-1', OTHER_NONCE);
  assert.equal(first, same);
  assert.notEqual(first, nextRender);
  assert.match(first, new RegExp(DATA_CONSENT_VERSION));
});

test('reenvío usa exactamente el prompt y botones canónicos como INTERACTIVE sin mutar candidato', async () => {
  const observed = { deliverCalls: 0, sendCalls: 0 };
  const prisma = prismaHarness();
  const result = await resendDataConsentFromDev(prisma, {
    candidateId: 'candidate-1',
    nonce: NONCE
  }, {
    now: () => new Date(NOW),
    deliver: async (_prisma, input, dependencies) => {
      observed.deliverCalls += 1;
      observed.input = structuredClone(input);
      observed.sendResult = await dependencies.sendText(input.to, input.body);
      return { sent: true, suppressed: false, messageId: 'outbound-1' };
    },
    sendButtons: async (to, body, buttons) => {
      observed.sendCalls += 1;
      observed.provider = { to, body, buttons: structuredClone(buttons) };
      return { messages: [{ id: 'wamid-1' }] };
    }
  });

  assert.equal(result.sent, true);
  assert.equal(observed.deliverCalls, 1);
  assert.equal(observed.sendCalls, 1);
  assert.equal(observed.input.messageType, 'INTERACTIVE');
  assert.equal(observed.input.body, buildDataConsentPromptReply());
  assert.deepEqual(observed.provider.buttons, DATA_CONSENT_BUTTONS);
  assert.equal(observed.input.rawPayload.source, 'admin_resend_data_consent');
  assert.equal(observed.input.rawPayload.manualIntervention, false);
  assert.equal(observed.input.rawPayload.consentVersion, DATA_CONSENT_VERSION);
});

test('ACCEPTED, REVOKED y ventana vencida bloquean el reenvío antes del delivery', async () => {
  let deliveries = 0;
  const deps = {
    now: () => new Date(NOW),
    deliver: async () => { deliveries += 1; return { sent: true }; },
    sendButtons: async () => ({ messages: [{ id: 'wamid' }] })
  };

  for (const status of ['ACCEPTED', 'REVOKED']) {
    await assert.rejects(
      resendDataConsentFromDev(prismaHarness(candidate({ dataConsentStatus: status })), {
        candidateId: 'candidate-1', nonce: NONCE
      }, deps),
      (error) => error?.code === 'dev_consent_resend_not_pending'
    );
  }

  await assert.rejects(
    resendDataConsentFromDev(
      prismaHarness(candidate(), new Date(NOW.getTime() - (24 * 60 * 60 * 1000) - 1)),
      { candidateId: 'candidate-1', nonce: NONCE },
      deps
    ),
    (error) => error?.code === 'dev_consent_resend_window_closed'
  );
  assert.equal(deliveries, 0);
});

test('bootstrap registra la extensión DEV sin modificar el router monolítico ni el contrato de consentimiento', () => {
  const bootstrap = readFileSync(new URL('../src/bootstrap.js', import.meta.url), 'utf8');
  const registrar = readFileSync(new URL('../src/registerDevConsentResend.js', import.meta.url), 'utf8');
  assert.match(bootstrap, /registerDevConsentResend\.js/);
  assert.match(registrar, /devConsentResendUiMiddleware/);
  assert.match(registrar, /devConsentResendRouter\(prisma\)/);
  assert.doesNotMatch(registrar, /dataConsentStatus\s*=/);
});
