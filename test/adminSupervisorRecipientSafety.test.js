import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import axios from 'axios';
import { createMockPrisma } from './helpers/mockPrisma.js';
import {
  SUPERVISOR_PHONE_ENV,
  ensureSupervisorWindowOpen,
  getSupervisorPhone,
  handleSupervisorInbound,
  isSupervisorPhone,
  notifySupervisorAttachment,
  notifySupervisorManualReview
} from '../src/services/adminSupervisor.js';

const TEST_SUPERVISOR_CONFIG = '+57 300 000 0001';
const TEST_SUPERVISOR_PHONE = '573000000001';
const TEST_CANDIDATE = Object.freeze({
  id: 'TEST-CANDIDATE-ID',
  phone: 'TEST-CANDIDATE-PHONE',
  fullName: 'TEST-CANDIDATE-NAME',
  currentStep: 'ASK_CV'
});

function restoreEnvironment(snapshot) {
  for (const key of [SUPERVISOR_PHONE_ENV, 'FORWARD_MEDIA_TO', 'META_PHONE_NUMBER_ID', 'META_ACCESS_TOKEN']) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function environmentSnapshot() {
  return Object.fromEntries(
    [SUPERVISOR_PHONE_ENV, 'FORWARD_MEDIA_TO', 'META_PHONE_NUMBER_ID', 'META_ACCESS_TOKEN']
      .map((key) => [key, process.env[key]])
  );
}

function forbiddenPrisma() {
  return new Proxy({}, {
    get() {
      throw new Error('TEST-PRISMA-MUST-NOT-BE-CALLED');
    }
  });
}

async function withProviderCounter(run) {
  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, payload, config) => {
    calls.push({ url: String(url), payload, config });
    return { data: { messages: [{ id: 'TEST-PROVIDER-MESSAGE-ID' }] } };
  };
  try {
    await run(calls);
  } finally {
    axios.post = originalPost;
  }
}

test('configuración ausente falla cerrada antes de tocar Prisma o el proveedor', async () => {
  const snapshot = environmentSnapshot();
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  delete process.env[SUPERVISOR_PHONE_ENV];
  process.env.FORWARD_MEDIA_TO = TEST_SUPERVISOR_CONFIG;

  try {
    await withProviderCounter(async (calls) => {
      const manualResult = await notifySupervisorManualReview(forbiddenPrisma(), TEST_CANDIDATE, {
        reason: 'TEST-TECHNICAL-REASON',
        inboundText: 'TEST-INBOUND-MESSAGE'
      });
      const attachmentResult = await notifySupervisorAttachment(forbiddenPrisma(), TEST_CANDIDATE, {
        mediaType: 'document',
        media: { id: 'TEST-MEDIA-ID', filename: 'TEST-CV.pdf', mime_type: 'application/pdf' }
      });
      const windowResult = await ensureSupervisorWindowOpen(forbiddenPrisma());
      const inboundResult = await handleSupervisorInbound(forbiddenPrisma(), {
        id: 'TEST-INBOUND-ID',
        text: { body: 'TEST-SUPERVISOR-MESSAGE' }
      });

      assert.deepEqual(manualResult, { sent: false, reason: 'supervisor_recipient_unavailable' });
      assert.deepEqual(attachmentResult, { sent: false, reason: 'supervisor_recipient_unavailable' });
      assert.equal(windowResult, false);
      assert.deepEqual(inboundResult, { handled: false, action: 'supervisor_recipient_unavailable' });
      assert.equal(calls.length, 0);
    });

    assert.equal(getSupervisorPhone(), null);
    assert.equal(isSupervisorPhone(TEST_SUPERVISOR_PHONE), false);
    assert.ok(errors.length >= 4);
    const serializedErrors = JSON.stringify(errors);
    assert.match(serializedErrors, /ADMIN_SUPERVISOR_RECIPIENT_UNAVAILABLE/);
    assert.doesNotMatch(serializedErrors, /TEST-CANDIDATE/);
    assert.doesNotMatch(serializedErrors, /TEST-INBOUND-MESSAGE/);
    assert.doesNotMatch(serializedErrors, /TEST-MEDIA-ID/);
    assert.doesNotMatch(serializedErrors, /573000000001/);
  } finally {
    console.error = originalError;
    restoreEnvironment(snapshot);
  }
});

test('configuración inválida no genera llamadas al proveedor', async () => {
  const snapshot = environmentSnapshot();
  const originalError = console.error;
  console.error = () => {};
  process.env[SUPERVISOR_PHONE_ENV] = 'TEST-INVALID-RECIPIENT';

  try {
    await withProviderCounter(async (calls) => {
      const result = await notifySupervisorManualReview(forbiddenPrisma(), TEST_CANDIDATE, {
        reason: 'TEST-INVALID-CONFIG',
        inboundText: 'TEST-NOT-SENT'
      });
      assert.deepEqual(result, { sent: false, reason: 'supervisor_recipient_unavailable' });
      assert.equal(calls.length, 0);
    });
    assert.equal(getSupervisorPhone(), null);
    assert.equal(isSupervisorPhone(TEST_SUPERVISOR_PHONE), false);
  } finally {
    console.error = originalError;
    restoreEnvironment(snapshot);
  }
});

test('configuración válida normaliza y envía únicamente al destinatario configurado', async () => {
  const snapshot = environmentSnapshot();
  process.env[SUPERVISOR_PHONE_ENV] = TEST_SUPERVISOR_CONFIG;
  process.env.META_PHONE_NUMBER_ID = 'TEST-META-PHONE-ID';
  process.env.META_ACCESS_TOKEN = 'TEST-META-ACCESS-TOKEN';

  try {
    const prisma = createMockPrisma({ candidates: [TEST_CANDIDATE] });
    await withProviderCounter(async (calls) => {
      const result = await notifySupervisorManualReview(prisma, TEST_CANDIDATE, {
        reason: 'TEST-TECHNICAL-REASON',
        inboundText: 'TEST-INBOUND-MESSAGE'
      });

      assert.deepEqual(result, { sent: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].payload.to, TEST_SUPERVISOR_PHONE);
      assert.equal(getSupervisorPhone(), TEST_SUPERVISOR_PHONE);
      assert.equal(isSupervisorPhone(TEST_SUPERVISOR_CONFIG), true);
    });
  } finally {
    restoreEnvironment(snapshot);
  }
});

test('el runtime y el ejemplo no contienen el fallback telefónico anterior', () => {
  const runtime = readFileSync(new URL('../src/services/adminSupervisor.js', import.meta.url), 'utf8');
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

  assert.doesNotMatch(runtime, /DEFAULT_SUPERVISOR_PHONE/);
  assert.doesNotMatch(runtime, /FORWARD_MEDIA_TO/);
  assert.doesNotMatch(runtime, /3052982551/);
  assert.doesNotMatch(envExample, /3052982551/);
  assert.match(envExample, /^ADMIN_WHATSAPP_NUMBER=$/m);
});
