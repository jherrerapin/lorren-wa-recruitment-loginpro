import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  activateWorkerPortalSession,
  resolveWorkerPortalSession
} from '../src/modules/dispatch-attendance/application/activateWorkerPortalSession.js';
import {
  WORKER_PORTAL_SESSION_COOKIE_NAME,
  WORKER_PORTAL_SESSION_COOKIE_PATH,
  buildWorkerPortalSessionCookie,
  buildWorkerPortalSessionExpiry,
  generateWorkerPortalSessionToken,
  hashWorkerPortalSessionToken,
  normalizeWorkerPortalSessionToken
} from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';

const NOW = new Date('2026-07-22T17:00:00.000Z');
const ACTIVATION_TOKEN = Buffer.alloc(32, 1).toString('base64url');
const SESSION_BYTES = Buffer.alloc(32, 9);
const SESSION_TOKEN = SESSION_BYTES.toString('base64url');
const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const INSTALLATION_PEPPER = 'p'.repeat(48);

function sessionResult(expiresAt) {
  return {
    workerId: 'worker-1',
    deviceId: 'device-1',
    sessionId: 'session-1',
    activatedAt: NOW,
    expiresAt
  };
}

test('genera 32 bytes y un token Base64URL de 43 caracteres', () => {
  let requestedBytes = null;
  const token = generateWorkerPortalSessionToken((size) => {
    requestedBytes = size;
    return SESSION_BYTES;
  });

  assert.equal(requestedBytes, 32);
  assert.equal(token, SESSION_TOKEN);
  assert.equal(token.length, 43);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
});

test('normaliza y hashea el token sin cambiar su contenido', () => {
  assert.equal(normalizeWorkerPortalSessionToken(` ${SESSION_TOKEN} `), SESSION_TOKEN);
  assert.equal(
    hashWorkerPortalSessionToken(SESSION_TOKEN),
    createHash('sha256').update(SESSION_TOKEN, 'utf8').digest('hex')
  );
});

test('rechaza tokens, fuentes aleatorias y TTL invalidos', () => {
  assert.throws(() => normalizeWorkerPortalSessionToken('corto'), /worker_portal_session_token_invalid/);
  assert.throws(() => generateWorkerPortalSessionToken(() => Buffer.alloc(16)), /worker_portal_session_entropy_invalid/);
  assert.throws(() => buildWorkerPortalSessionExpiry(NOW, 14), /worker_portal_session_ttl_invalid/);
  assert.throws(() => buildWorkerPortalSessionExpiry(NOW, 30 * 24 * 60 + 1), /worker_portal_session_ttl_invalid/);
});

test('define cookie segura, HttpOnly y restringida al portal', () => {
  const expiresAt = buildWorkerPortalSessionExpiry(NOW, 60);
  const cookie = buildWorkerPortalSessionCookie(expiresAt, NOW);

  assert.equal(cookie.name, WORKER_PORTAL_SESSION_COOKIE_NAME);
  assert.equal(cookie.name.startsWith('__Secure-'), true);
  assert.deepEqual(cookie.options, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: WORKER_PORTAL_SESSION_COOKIE_PATH,
    maxAge: 60 * 60 * 1000
  });
  assert.equal(Object.hasOwn(cookie.options, 'domain'), false);
});

test('activa dispositivo y crea sesion mediante una sola operacion de repositorio', async () => {
  let repositoryInput = null;
  const repository = {
    async claimActivationAuthorizeDeviceAndCreateSession(input) {
      repositoryInput = input;
      return sessionResult(input.sessionExpiresAt);
    }
  };

  const result = await activateWorkerPortalSession({
    repository,
    rawActivationToken: ACTIVATION_TOKEN,
    installationId: INSTALLATION_ID,
    installationPepper: INSTALLATION_PEPPER,
    now: NOW,
    sessionTtlMinutes: 60,
    randomBytesFn: () => SESSION_BYTES,
    userAgent: ' navegador de prueba ',
    platform: ' Android ',
    ipAddress: ' 127.0.0.1 '
  });

  assert.equal(result.rawSessionToken, SESSION_TOKEN);
  assert.equal(result.workerId, 'worker-1');
  assert.equal(result.deviceId, 'device-1');
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.expiresAt.toISOString(), '2026-07-22T18:00:00.000Z');
  assert.equal(result.cookie.options.httpOnly, true);
  assert.equal(result.cookie.options.secure, true);

  assert.equal(repositoryInput.purpose, 'PRIMARY_DEVICE_ACTIVATION');
  assert.equal(
    repositoryInput.activationTokenHash,
    createHash('sha256').update(ACTIVATION_TOKEN, 'utf8').digest('hex')
  );
  assert.equal(
    repositoryInput.installationIdHash,
    createHmac('sha256', INSTALLATION_PEPPER).update(INSTALLATION_ID, 'utf8').digest('hex')
  );
  assert.equal(
    repositoryInput.sessionTokenHash,
    createHash('sha256').update(SESSION_TOKEN, 'utf8').digest('hex')
  );
  assert.equal(repositoryInput.userAgent, 'navegador de prueba');
  assert.equal(repositoryInput.platform, 'Android');
  assert.equal(repositoryInput.ipAddress, '127.0.0.1');

  const persistedPayload = JSON.stringify(repositoryInput);
  assert.equal(persistedPayload.includes(ACTIVATION_TOKEN), false);
  assert.equal(persistedPayload.includes(SESSION_TOKEN), false);
  assert.equal(persistedPayload.includes(INSTALLATION_ID), false);
});

test('rechaza repositorios incompletos y resultados sin identidad de sesion', async () => {
  await assert.rejects(
    () => activateWorkerPortalSession({
      repository: {},
      rawActivationToken: ACTIVATION_TOKEN,
      installationId: INSTALLATION_ID,
      installationPepper: INSTALLATION_PEPPER,
      now: NOW,
      randomBytesFn: () => SESSION_BYTES
    }),
    /worker_portal_session_repository_claimActivationAuthorizeDeviceAndCreateSession_required/
  );

  await assert.rejects(
    () => activateWorkerPortalSession({
      repository: {
        async claimActivationAuthorizeDeviceAndCreateSession() {
          return { workerId: 'worker-1' };
        }
      },
      rawActivationToken: ACTIVATION_TOKEN,
      installationId: INSTALLATION_ID,
      installationPepper: INSTALLATION_PEPPER,
      now: NOW,
      randomBytesFn: () => SESSION_BYTES
    }),
    /worker_portal_session_repository_result_invalid/
  );
});

test('rechaza una sesion devuelta ya vencida', async () => {
  await assert.rejects(
    () => activateWorkerPortalSession({
      repository: {
        async claimActivationAuthorizeDeviceAndCreateSession() {
          return sessionResult(new Date(NOW.getTime() - 1));
        }
      },
      rawActivationToken: ACTIVATION_TOKEN,
      installationId: INSTALLATION_ID,
      installationPepper: INSTALLATION_PEPPER,
      now: NOW,
      randomBytesFn: () => SESSION_BYTES
    }),
    /worker_portal_session_repository_expired/
  );
});

test('resuelve una sesion activa usando solamente el hash', async () => {
  let repositoryInput = null;
  const expiresAt = new Date(NOW.getTime() + 60 * 60 * 1000);
  const repository = {
    async resolveActiveSession(input) {
      repositoryInput = input;
      return sessionResult(expiresAt);
    }
  };

  const result = await resolveWorkerPortalSession({
    repository,
    rawSessionToken: SESSION_TOKEN,
    now: NOW
  });

  assert.deepEqual(result, {
    workerId: 'worker-1',
    deviceId: 'device-1',
    sessionId: 'session-1',
    expiresAt
  });
  assert.equal(repositoryInput.sessionTokenHash, hashWorkerPortalSessionToken(SESSION_TOKEN));
  assert.equal(JSON.stringify(repositoryInput).includes(SESSION_TOKEN), false);
});

test('una sesion ausente o vencida se resuelve como no autenticada', async () => {
  const absent = await resolveWorkerPortalSession({
    repository: { async resolveActiveSession() { return null; } },
    rawSessionToken: SESSION_TOKEN,
    now: NOW
  });
  assert.equal(absent, null);

  const expired = await resolveWorkerPortalSession({
    repository: {
      async resolveActiveSession() {
        return sessionResult(new Date(NOW.getTime() - 1000));
      }
    },
    rawSessionToken: SESSION_TOKEN,
    now: NOW
  });
  assert.equal(expired, null);
});
