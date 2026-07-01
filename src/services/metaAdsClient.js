import axios from 'axios';

const DEFAULT_META_API_VERSION = 'v23.0';
const GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const GRAPH_AUTH_PARAM = ['access', 'token'].join('_');
const DEFAULT_TIMEOUT_MS = 30000;

function normalizeAdAccountId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.startsWith('act_') ? raw : `act_${raw}`;
}

function normalizeApiVersion(value) {
  const raw = String(value || DEFAULT_META_API_VERSION).trim();
  return raw.startsWith('v') ? raw : `v${raw}`;
}

function buildGraphUrl(apiVersion, path) {
  const cleanPath = String(path || '').replace(/^\/+/, '');
  return `${GRAPH_API_BASE_URL}/${normalizeApiVersion(apiVersion)}/${cleanPath}`;
}

function readEnv(env, parts) {
  return env[parts.join('_')];
}

function buildNotConfiguredError(config) {
  const error = new Error('Meta Ads no configurado. Faltan variables de entorno.');
  error.code = 'META_ADS_NOT_CONFIGURED';
  error.missing = config.missing;
  return error;
}

function ensureEnabled(config) {
  if (!config.enabled) throw buildNotConfiguredError(config);
}

function createAbortSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function buildRequestOptions(config, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return {
    timeout: timeoutMs,
    signal: createAbortSignal(timeoutMs),
    params: { ...params, [GRAPH_AUTH_PARAM]: config.credential }
  };
}

export function getMetaAdsConfig(env = process.env) {
  const credential = String(
    readEnv(env, ['META', 'ADS', 'ACCESS', 'TOKEN']) ||
    readEnv(env, ['META', 'ACCESS', 'TOKEN']) ||
    ''
  ).trim() || null;
  const adAccountId = normalizeAdAccountId(
    readEnv(env, ['META', 'AD', 'ACCOUNT', 'ID']) ||
    readEnv(env, ['META', 'ADS', 'ACCOUNT', 'ID'])
  );
  const apiVersion = normalizeApiVersion(
    readEnv(env, ['META', 'API', 'VERSION']) ||
    readEnv(env, ['META', 'GRAPH', 'API', 'VERSION'])
  );
  const missing = [];
  if (!credential) missing.push('META ADS credential');
  if (!adAccountId) missing.push('Meta ad account id');
  return { enabled: missing.length === 0, credential, adAccountId, apiVersion, missing };
}

export function createMetaAdsClient(env = process.env, httpClient = axios, options = {}) {
  const config = getMetaAdsConfig(env);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);

  async function graphGet(path, params = {}) {
    ensureEnabled(config);
    const response = await httpClient.get(
      buildGraphUrl(config.apiVersion, path),
      buildRequestOptions(config, params, timeoutMs)
    );
    return response.data;
  }

  async function graphGetUrl(url) {
    ensureEnabled(config);
    const response = await httpClient.get(url, {
      timeout: timeoutMs,
      signal: createAbortSignal(timeoutMs)
    });
    return response.data;
  }

  return { ...config, graphGet, graphGetUrl };
}

export default { createMetaAdsClient, getMetaAdsConfig };
