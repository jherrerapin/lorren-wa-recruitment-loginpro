import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import {
  createWorkerPortalSessionHandoffRouter,
  createWorkerPortalSessionHandoffToken,
  readWorkerPortalSessionHandoffToken
} from '../src/routes/workerPortalSessionHandoff.js';
import {
  WORKER_PORTAL_SESSION_COOKIE_NAME,
  hashWorkerPortalSessionToken
} from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import { WORKER_PORTAL_INSTALLATION_COOKIE_NAME } from '../src/routes/workerPortalCore.js';

const SECRET = 'handoff-secret-for-tests-'.padEnd(64, 'x');
const CURRENT_SESSION_TOKEN = Buffer.alloc(32, 4).toString('base64url');
const NEXT_SESSION_TOKEN = Buffer.alloc(32, 9).toString('base64url');
const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = new Date('2026-08-01T17:30:00.000Z');
const SESSION = {
  workerId: 'worker-1',
  deviceId: 'device-1',
  sessionId: 'session-1',
  expiresAt: new Date('2026-08-08T17:30:00.000Z')
};

function deterministicRandomBytes(size) {
  return Buffer.alloc(size, size === 32 ? 9 : 7);
}

async function startServer(router) {
  const app = express();
  app.use('/operaciones/portal/sesion-transferencia', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`
  };
}

test('el pase cifrado conserva la sesión y vence rápidamente', () => {
  const token = createWorkerPortalSessionHandoffToken({
    rawSessionToken: CURRENT_SESSION_TOKEN,
    sessionId: SESSION.sessionId,
    installationId: INSTALLATION_ID,
    now: NOW,
    ttlMs: 90_000,
    secret: SECRET,
    randomBytesFn: deterministicRandomBytes
  });

  assert.doesNotMatch(token, new RegExp(CURRENT_SESSION_TOKEN));
  assert.doesNotMatch(token, new RegExp(INSTALLATION_ID));

  const payload = readWorkerPortalSessionHandoffToken({
    token,
    now: new Date(NOW.getTime() + 30_000),
    secret: SECRET
  });
  assert.equal(payload.rawSessionToken, CURRENT_SESSION_TOKEN);
  assert.equal(payload.sessionId, SESSION.sessionId);
  assert.equal(payload.installationId, INSTALLATION_ID);

  assert.throws(
    () => readWorkerPortalSessionHandoffToken({
      token,
      now: new Date(NOW.getTime() + 90_001),
      secret: SECRET
    }),
    /worker_portal_handoff_token_expired/
  );
});

test('un pase alterado no puede descifrarse', () => {
  const token = createWorkerPortalSessionHandoffToken({
    rawSessionToken: CURRENT_SESSION_TOKEN,
    sessionId: SESSION.sessionId,
    installationId: INSTALLATION_ID,
    now: NOW,
    secret: SECRET,
    randomBytesFn: deterministicRandomBytes
  });
  const replacement = token.endsWith('A') ? 'B' : 'A';
  const tampered = `${token.slice(0, -1)}${replacement}`;
  assert.throws(
    () => readWorkerPortalSessionHandoffToken({ token: tampered, now: NOW, secret: SECRET }),
    /worker_portal_handoff_token_invalid/
  );
});

test('WhatsApp entrega a Chrome una cookie nueva y el pase solo se usa una vez', async (t) => {
  let rotationAvailable = true;
  let rotationInput = null;
  const router = createWorkerPortalSessionHandoffRouter({}, {
    repository: {},
    secret: SECRET,
    nowFn: () => new Date(NOW),
    randomBytesFn: deterministicRandomBytes,
    resolveSessionFn: async ({ rawSessionToken }) => (
      rawSessionToken === CURRENT_SESSION_TOKEN ? SESSION : null
    ),
    rotateSessionTokenFn: async (input) => {
      rotationInput = input;
      if (!rotationAvailable) return false;
      rotationAvailable = false;
      return true;
    }
  });

  const { server, origin } = await startServer(router);
  t.after(() => server.close());

  const cookie = [
    `${WORKER_PORTAL_SESSION_COOKIE_NAME}=${CURRENT_SESSION_TOKEN}`,
    `${WORKER_PORTAL_INSTALLATION_COOKIE_NAME}=${INSTALLATION_ID}`
  ].join('; ');
  const created = await fetch(`${origin}/operaciones/portal/sesion-transferencia/crear`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'worker-portal',
      Cookie: cookie
    },
    body: '{}'
  });
  assert.equal(created.status, 200);
  const createdPayload = await created.json();
  assert.equal(createdPayload.ok, true);
  assert.equal(typeof createdPayload.handoffToken, 'string');

  const continueUrl = new URL(`${origin}/operaciones/portal/sesion-transferencia/continuar`);
  continueUrl.searchParams.set('transferencia', createdPayload.handoffToken);
  const continued = await fetch(continueUrl, { redirect: 'manual' });
  assert.equal(continued.status, 302);
  assert.equal(continued.headers.get('location'), '/operaciones/portal?instalarPortal=1');

  const setCookie = continued.headers.get('set-cookie') || '';
  assert.match(setCookie, new RegExp(`${WORKER_PORTAL_SESSION_COOKIE_NAME}=${NEXT_SESSION_TOKEN}`));
  assert.match(setCookie, new RegExp(`${WORKER_PORTAL_INSTALLATION_COOKIE_NAME}=${INSTALLATION_ID}`));
  assert.equal(rotationInput.sessionId, SESSION.sessionId);
  assert.equal(rotationInput.currentSessionTokenHash, hashWorkerPortalSessionToken(CURRENT_SESSION_TOKEN));
  assert.equal(rotationInput.nextSessionTokenHash, hashWorkerPortalSessionToken(NEXT_SESSION_TOKEN));

  const replay = await fetch(continueUrl, { redirect: 'manual' });
  assert.equal(replay.status, 401);
  assert.match(await replay.text(), /Este enlace ya fue utilizado/);
});
