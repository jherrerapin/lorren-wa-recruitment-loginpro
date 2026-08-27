import { createHash, randomBytes } from 'node:crypto';

export const WORKER_PORTAL_SESSION_TOKEN_BYTES = 32;
export const WORKER_PORTAL_SESSION_TOKEN_LENGTH = 43;
export const WORKER_PORTAL_SESSION_DEFAULT_TTL_MINUTES = 7 * 24 * 60;
export const WORKER_PORTAL_SESSION_MIN_TTL_MINUTES = 15;
export const WORKER_PORTAL_SESSION_MAX_TTL_MINUTES = 30 * 24 * 60;
export const WORKER_PORTAL_SESSION_CONTINUITY_DAYS = 365;
export const WORKER_PORTAL_SESSION_CONTINUITY_MAX_AGE_MS = WORKER_PORTAL_SESSION_CONTINUITY_DAYS * 24 * 60 * 60 * 1000;
export const WORKER_PORTAL_SESSION_COOKIE_NAME = '__Secure-lorren-attendance';
export const WORKER_PORTAL_SESSION_COOKIE_PATH = '/';

function validDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function normalizeTtlMinutes(value) {
  const ttl = value === undefined || value === null
    ? WORKER_PORTAL_SESSION_DEFAULT_TTL_MINUTES
    : Number(value);

  if (
    !Number.isInteger(ttl)
    || ttl < WORKER_PORTAL_SESSION_MIN_TTL_MINUTES
    || ttl > WORKER_PORTAL_SESSION_MAX_TTL_MINUTES
  ) {
    throw new Error('worker_portal_session_ttl_invalid');
  }

  return ttl;
}

export function generateWorkerPortalSessionToken(randomBytesFn = randomBytes) {
  if (typeof randomBytesFn !== 'function') {
    throw new Error('worker_portal_session_random_bytes_required');
  }

  const entropy = randomBytesFn(WORKER_PORTAL_SESSION_TOKEN_BYTES);
  if (!Buffer.isBuffer(entropy) || entropy.length !== WORKER_PORTAL_SESSION_TOKEN_BYTES) {
    throw new Error('worker_portal_session_entropy_invalid');
  }

  return entropy.toString('base64url');
}

export function normalizeWorkerPortalSessionToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (
    token.length !== WORKER_PORTAL_SESSION_TOKEN_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new Error('worker_portal_session_token_invalid');
  }
  return token;
}

export function hashWorkerPortalSessionToken(value) {
  const token = normalizeWorkerPortalSessionToken(value);
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function buildWorkerPortalSessionExpiry(now = new Date(), ttlMinutes) {
  const issuedAt = validDate(now, 'worker_portal_session_now');
  const ttl = normalizeTtlMinutes(ttlMinutes);
  return new Date(issuedAt.getTime() + ttl * 60 * 1000);
}

export function buildWorkerPortalSessionContinuityExpiry(now = new Date()) {
  const current = validDate(now, 'worker_portal_session_continuity_now');
  return new Date(current.getTime() + WORKER_PORTAL_SESSION_CONTINUITY_MAX_AGE_MS);
}

export function buildWorkerPortalSessionCookie(expiresAt, now = new Date()) {
  const issuedAt = validDate(now, 'worker_portal_session_cookie_now');
  const expiry = validDate(expiresAt, 'worker_portal_session_cookie_expiry');
  const maxAge = expiry.getTime() - issuedAt.getTime();
  if (maxAge <= 0) throw new Error('worker_portal_session_cookie_expired');

  return {
    name: WORKER_PORTAL_SESSION_COOKIE_NAME,
    options: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: WORKER_PORTAL_SESSION_COOKIE_PATH,
      maxAge
    }
  };
}
