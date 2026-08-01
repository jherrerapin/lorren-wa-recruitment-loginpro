import express from 'express';
import cookieParser from 'cookie-parser';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto';
import {
  WORKER_PORTAL_SESSION_COOKIE_NAME,
  buildWorkerPortalSessionCookie,
  generateWorkerPortalSessionToken,
  hashWorkerPortalSessionToken,
  normalizeWorkerPortalSessionToken
} from '../modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import { normalizeInstallationId } from '../modules/dispatch-attendance/domain/deviceActivationPolicy.js';
import { resolveWorkerPortalSession } from '../modules/dispatch-attendance/application/activateWorkerPortalSession.js';
import { createPrismaWorkerPortalSessionRepository } from '../modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js';
import {
  WORKER_PORTAL_INSTALLATION_COOKIE_NAME,
  applyWorkerPortalSecurityHeaders,
  setWorkerPortalInstallationCookie
} from './workerPortalCore.js';

const HANDOFF_VERSION = 'v1';
const HANDOFF_AAD = Buffer.from('lorren-worker-portal-session-handoff-v1', 'utf8');
const HANDOFF_KEY_CONTEXT = 'lorren-worker-portal-session-handoff-key-v1';
const DEFAULT_HANDOFF_TTL_MS = 3 * 60 * 1000;
const MIN_HANDOFF_TTL_MS = 30 * 1000;
const MAX_HANDOFF_TTL_MS = 10 * 60 * 1000;
const MAX_HANDOFF_TOKEN_LENGTH = 2_048;
const WORKER_PORTAL_REQUEST_HEADER = 'worker-portal';
const CONTINUE_PATH = '/operaciones/portal?instalarPortal=1';

function validDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function normalizedText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeSessionId(value) {
  const sessionId = normalizedText(value, 160);
  if (!sessionId) throw new Error('worker_portal_handoff_session_id_invalid');
  return sessionId;
}

function normalizeHandoffTtl(value) {
  const ttl = value === undefined || value === null ? DEFAULT_HANDOFF_TTL_MS : Number(value);
  if (!Number.isInteger(ttl) || ttl < MIN_HANDOFF_TTL_MS || ttl > MAX_HANDOFF_TTL_MS) {
    throw new Error('worker_portal_handoff_ttl_invalid');
  }
  return ttl;
}

function normalizeHandoffToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token || token.length > MAX_HANDOFF_TOKEN_LENGTH) {
    throw new Error('worker_portal_handoff_token_invalid');
  }
  const parts = token.split('.');
  if (
    parts.length !== 4
    || parts[0] !== HANDOFF_VERSION
    || parts.slice(1).some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw new Error('worker_portal_handoff_token_invalid');
  }
  return parts;
}

function resolveHandoffSecret(options = {}) {
  const env = options.env || process.env;
  const secret = options.secret
    ?? env.ATTENDANCE_PORTAL_HANDOFF_SECRET
    ?? env.ATTENDANCE_INSTALLATION_PEPPER;
  const normalized = typeof secret === 'string' ? secret.trim() : '';
  if (Buffer.byteLength(normalized, 'utf8') < 32) {
    throw new Error('worker_portal_handoff_secret_required');
  }
  return normalized;
}

function deriveHandoffKey(secret) {
  return createHash('sha256')
    .update(HANDOFF_KEY_CONTEXT, 'utf8')
    .update('\0', 'utf8')
    .update(secret, 'utf8')
    .digest();
}

function requestUserAgent(req) {
  return normalizedText(req.get?.('user-agent'), 500);
}

function requestPlatform(req) {
  return normalizedText(req.get?.('sec-ch-ua-platform'), 120);
}

function requestIp(req) {
  return normalizedText(req.ip, 120);
}

function safeErrorCode(error) {
  const code = typeof error?.message === 'string' ? error.message : 'worker_portal_handoff_error';
  return /^[A-Za-z0-9_]{1,100}$/.test(code) ? code : 'worker_portal_handoff_error';
}

function handoffFailurePage(message) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Portal del Auxiliar · Lórren</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(100%,480px);box-sizing:border-box;background:#fff;border:1px solid #dfe4ea;border-radius:22px;padding:28px;box-shadow:0 18px 42px rgba(23,33,43,.09)}.brand{margin:0 0 14px;color:#176c36;font-size:13px;font-weight:850;letter-spacing:.08em;text-transform:uppercase}h1{margin:0;font-size:30px;line-height:1.12}.status{margin-top:20px;padding:15px;border-radius:14px;background:#fff6df;color:#76520b;font-weight:750;line-height:1.5}</style></head><body><main class="card"><p class="brand">Lórren · Operaciones</p><h1>No fue posible abrir la app</h1><div class="status">${message}</div></main></body></html>`;
}

function renderHandoffFailure(res, status, message) {
  applyWorkerPortalSecurityHeaders(res);
  return res.status(status).type('html').send(handoffFailurePage(message));
}

function redactHandoffUrl(req) {
  const redact = (value) => typeof value === 'string'
    ? value.replace(/([?&]transferencia=)[^&#]*/i, '$1[REDACTED]')
    : value;
  req.originalUrl = redact(req.originalUrl);
  req.url = redact(req.url);
}

export function createWorkerPortalSessionHandoffToken({
  rawSessionToken,
  sessionId,
  installationId,
  now = new Date(),
  ttlMs,
  secret,
  randomBytesFn = randomBytes
}) {
  const issuedAt = validDate(now, 'worker_portal_handoff_now');
  const normalizedSessionToken = normalizeWorkerPortalSessionToken(rawSessionToken);
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedInstallationId = normalizeInstallationId(installationId);
  const ttl = normalizeHandoffTtl(ttlMs);
  if (typeof randomBytesFn !== 'function') throw new Error('worker_portal_handoff_random_bytes_required');

  const iv = randomBytesFn(12);
  if (!Buffer.isBuffer(iv) || iv.length !== 12) {
    throw new Error('worker_portal_handoff_iv_invalid');
  }

  const payload = Buffer.from(JSON.stringify({
    version: 1,
    rawSessionToken: normalizedSessionToken,
    sessionId: normalizedSessionId,
    installationId: normalizedInstallationId,
    issuedAt: issuedAt.getTime(),
    expiresAt: issuedAt.getTime() + ttl
  }), 'utf8');

  const cipher = createCipheriv('aes-256-gcm', deriveHandoffKey(resolveHandoffSecret({ secret })), iv);
  cipher.setAAD(HANDOFF_AAD);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    HANDOFF_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url')
  ].join('.');
}

export function readWorkerPortalSessionHandoffToken({
  token,
  now = new Date(),
  secret
}) {
  const current = validDate(now, 'worker_portal_handoff_now');
  const [, encodedIv, encodedTag, encodedCiphertext] = normalizeHandoffToken(token);
  const iv = Buffer.from(encodedIv, 'base64url');
  const tag = Buffer.from(encodedTag, 'base64url');
  const ciphertext = Buffer.from(encodedCiphertext, 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1) {
    throw new Error('worker_portal_handoff_token_invalid');
  }

  let parsed;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveHandoffKey(resolveHandoffSecret({ secret })),
      iv
    );
    decipher.setAAD(HANDOFF_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('worker_portal_handoff_token_invalid');
  }

  const issuedAt = Number(parsed?.issuedAt);
  const expiresAt = Number(parsed?.expiresAt);
  if (
    parsed?.version !== 1
    || !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= current.getTime()
    || issuedAt > current.getTime() + 60_000
    || expiresAt - issuedAt < MIN_HANDOFF_TTL_MS
    || expiresAt - issuedAt > MAX_HANDOFF_TTL_MS
  ) {
    throw new Error('worker_portal_handoff_token_expired');
  }

  return {
    rawSessionToken: normalizeWorkerPortalSessionToken(parsed.rawSessionToken),
    sessionId: normalizeSessionId(parsed.sessionId),
    installationId: normalizeInstallationId(parsed.installationId),
    issuedAt: new Date(issuedAt),
    expiresAt: new Date(expiresAt)
  };
}

async function rotatePrismaSessionToken(prisma, input) {
  if (!prisma?.dispatchWorkerPortalSession?.updateMany) {
    throw new Error('worker_portal_handoff_prisma_session_required');
  }
  const result = await prisma.dispatchWorkerPortalSession.updateMany({
    where: {
      id: input.sessionId,
      sessionTokenHash: input.currentSessionTokenHash,
      status: 'ACTIVE',
      revokedAt: null,
      expiresAt: { gt: input.now }
    },
    data: {
      sessionTokenHash: input.nextSessionTokenHash,
      lastSeenAt: input.now,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      platform: input.platform
    }
  });
  return result?.count === 1;
}

export function createWorkerPortalSessionHandoffRouter(prisma, options = {}) {
  const router = express.Router();
  const repositoryFactory = options.repositoryFactory
    || (() => createPrismaWorkerPortalSessionRepository(prisma));
  const resolveSessionFn = options.resolveSessionFn || resolveWorkerPortalSession;
  const rotateSessionTokenFn = options.rotateSessionTokenFn
    || ((input) => rotatePrismaSessionToken(prisma, input));
  const nowFn = options.nowFn || (() => new Date());
  const randomBytesFn = options.randomBytesFn || randomBytes;
  const ttlMs = normalizeHandoffTtl(options.ttlMs);
  let repository = options.repository || null;

  function getRepository() {
    if (!repository) repository = repositoryFactory();
    if (!repository) throw new Error('worker_portal_repository_unavailable');
    return repository;
  }

  router.use(cookieParser());
  router.post('/crear', express.json({ limit: '4kb', strict: true }), async (req, res) => {
    applyWorkerPortalSecurityHeaders(res);
    if (req.get?.('x-requested-with') !== WORKER_PORTAL_REQUEST_HEADER) {
      return res.status(400).json({ ok: false, error: 'worker_portal_handoff_request_invalid' });
    }

    try {
      const now = validDate(nowFn(), 'worker_portal_handoff_now');
      const rawSessionToken = req.cookies?.[WORKER_PORTAL_SESSION_COOKIE_NAME];
      const installationId = req.cookies?.[WORKER_PORTAL_INSTALLATION_COOKIE_NAME];
      if (!rawSessionToken || !installationId) {
        return res.status(401).json({ ok: false, error: 'portal_session_required' });
      }

      const session = await resolveSessionFn({
        repository: getRepository(),
        rawSessionToken,
        now
      });
      if (!session) return res.status(401).json({ ok: false, error: 'portal_session_required' });

      const handoffToken = createWorkerPortalSessionHandoffToken({
        rawSessionToken,
        sessionId: session.sessionId,
        installationId,
        now,
        ttlMs,
        secret: resolveHandoffSecret(options),
        randomBytesFn
      });

      return res.status(200).json({
        ok: true,
        handoffToken,
        expiresInSeconds: Math.floor(ttlMs / 1000)
      });
    } catch (error) {
      console.error('[WORKER_PORTAL_HANDOFF_CREATE_FAILED]', { code: safeErrorCode(error) });
      return res.status(503).json({ ok: false, error: 'worker_portal_handoff_unavailable' });
    }
  });

  router.get('/continuar', async (req, res) => {
    const transferToken = typeof req.query?.transferencia === 'string'
      ? req.query.transferencia
      : '';
    redactHandoffUrl(req);
    applyWorkerPortalSecurityHeaders(res);

    try {
      const now = validDate(nowFn(), 'worker_portal_handoff_now');
      const payload = readWorkerPortalSessionHandoffToken({
        token: transferToken,
        now,
        secret: resolveHandoffSecret(options)
      });

      const session = await resolveSessionFn({
        repository: getRepository(),
        rawSessionToken: payload.rawSessionToken,
        now
      });
      if (!session || session.sessionId !== payload.sessionId) {
        return renderHandoffFailure(
          res,
          401,
          'Regresa a WhatsApp y pulsa nuevamente “Abrir en Chrome y descargar”.'
        );
      }

      const nextRawSessionToken = generateWorkerPortalSessionToken(randomBytesFn);
      const rotated = await rotateSessionTokenFn({
        sessionId: session.sessionId,
        currentSessionTokenHash: hashWorkerPortalSessionToken(payload.rawSessionToken),
        nextSessionTokenHash: hashWorkerPortalSessionToken(nextRawSessionToken),
        now,
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
        platform: requestPlatform(req)
      });
      if (!rotated) {
        return renderHandoffFailure(
          res,
          401,
          'Este enlace ya fue utilizado. Regresa a WhatsApp y vuelve a pulsar el botón de descarga.'
        );
      }

      const cookie = buildWorkerPortalSessionCookie(session.expiresAt, now);
      res.cookie(cookie.name, nextRawSessionToken, cookie.options);
      setWorkerPortalInstallationCookie(res, payload.installationId);
      return res.redirect(302, CONTINUE_PATH);
    } catch (error) {
      const code = safeErrorCode(error);
      const expired = code === 'worker_portal_handoff_token_expired'
        || code === 'worker_portal_handoff_token_invalid';
      if (!expired) console.error('[WORKER_PORTAL_HANDOFF_REDEEM_FAILED]', { code });
      return renderHandoffFailure(
        res,
        expired ? 401 : 503,
        expired
          ? 'El enlace temporal venció o ya no es válido. Regresa a WhatsApp y pulsa nuevamente el botón de descarga.'
          : 'La transferencia de la sesión no está disponible en este momento. Intenta nuevamente.'
      );
    }
  });

  return router;
}
