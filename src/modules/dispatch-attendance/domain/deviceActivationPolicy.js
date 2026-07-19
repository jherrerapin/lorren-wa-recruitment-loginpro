import { createHash, createHmac, randomBytes } from 'node:crypto';

export const PRIMARY_DEVICE_ACTIVATION_PURPOSE = 'PRIMARY_DEVICE_ACTIVATION';
export const ACTIVATION_TOKEN_BYTES = 32;
export const DEFAULT_ACTIVATION_TTL_MINUTES = 30;
export const MIN_ACTIVATION_TTL_MINUTES = 5;
export const MAX_ACTIVATION_TTL_MINUTES = 24 * 60;

const ACTIVATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN_PEPPER_LENGTH = 32;

export function requiredString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${fieldName}_required`);
  return value.trim();
}

export function normalizeActivationTtlMinutes(value = DEFAULT_ACTIVATION_TTL_MINUTES) {
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < MIN_ACTIVATION_TTL_MINUTES || ttl > MAX_ACTIVATION_TTL_MINUTES) {
    throw new Error('activation_ttl_invalid');
  }
  return ttl;
}

export function generateActivationToken(randomBytesFn = randomBytes) {
  const bytes = randomBytesFn(ACTIVATION_TOKEN_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== ACTIVATION_TOKEN_BYTES) {
    throw new Error('activation_random_source_invalid');
  }
  return bytes.toString('base64url');
}

export function normalizeActivationToken(value) {
  const token = requiredString(value, 'activation_token');
  if (!ACTIVATION_TOKEN_PATTERN.test(token)) throw new Error('activation_token_invalid');
  return token;
}

export function hashActivationToken(value) {
  const token = normalizeActivationToken(value);
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function normalizeInstallationId(value) {
  const installationId = requiredString(value, 'installation_id').toLowerCase();
  if (!UUID_V4_PATTERN.test(installationId)) throw new Error('installation_id_invalid');
  return installationId;
}

export function hashInstallationId(value, pepper) {
  const installationId = normalizeInstallationId(value);
  const secret = requiredString(pepper, 'installation_pepper');
  if (secret.length < MIN_PEPPER_LENGTH) throw new Error('installation_pepper_too_short');
  return createHmac('sha256', secret).update(installationId, 'utf8').digest('hex');
}

export function buildActivationExpiry(now, ttlMinutes) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('activation_now_invalid');
  const ttl = normalizeActivationTtlMinutes(ttlMinutes);
  return new Date(now.getTime() + ttl * 60 * 1000);
}
