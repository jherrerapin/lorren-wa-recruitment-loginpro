import axios from 'axios';

const DEFAULT_META_API_VERSION = 'v23.0';
const GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const GRAPH_AUTH_PARAM = ['access', 'token'].join('_');

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

function sanitizeEndpoint(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, GRAPH_API_BASE_URL);
    url.searchParams.delete(GRAPH_AUTH_PARAM);
    return `${url.pathname}${url.search}`;
  } catch {
    return raw.replace(/([?&])access_token=[^&\s]+/gi, '$1access_token=[REDACTED]');
  }
}

export function normalizeMetaGraphError(error, endpoint = null) {
  if (error?.name === 'MetaGraphApiError') return error;

  const meta = error?.response?.data?.error || error?.metaError || null;
  const httpStatus = error?.response?.status || null;
  const metaCode = meta?.code ?? error?.metaCode ?? null;
  const metaSubcode = meta?.error_subcode ?? error?.metaSubcode ?? null;
  const normalized = new Error(meta?.message || error?.message || 'Error consultando Meta Graph API.');

  normalized.name = 'MetaGraphApiError';
  normalized.code = metaCode ?? error?.code ?? (httpStatus ? `HTTP_${httpStatus}` : 'META_GRAPH_ERROR');
  normalized.metaCode = metaCode;
  normalized.metaSubcode = metaSubcode;
  normalized.type = meta?.type || error?.type || null;
  normalized.fbtraceId = meta?.fbtrace_id || error?.fbtraceId || null;
  normalized.httpStatus = httpStatus;
  normalized.endpoint = sanitizeEndpoint(endpoint || error?.endpoint || error?.config?.url);
  return normalized;
}

export function getMetaAdsConfig(env = process.env) {
  // La credencial de Marketing API debe ser independiente del token usado por
  // WhatsApp Cloud API. Reutilizar META_ACCESS_TOKEN puede producir un falso
  // “configurado” con una credencial que no tiene permisos ads_read.
  const credential = String(readEnv(env, ['META', 'ADS', 'ACCESS', 'TOKEN']) || '').trim() || null;
  const adAccountId = normalizeAdAccountId(
    readEnv(env, ['META', 'AD', 'ACCOUNT', 'ID'])
      || readEnv(env, ['META', 'ADS', 'ACCOUNT', 'ID'])
  );
  const apiVersion = normalizeApiVersion(
    readEnv(env, ['META', 'API', 'VERSION'])
      || readEnv(env, ['META', 'GRAPH', 'API', 'VERSION'])
  );
  const missing = [];
  if (!credential) missing.push('META_ADS_ACCESS_TOKEN');
  if (!adAccountId) missing.push('META_AD_ACCOUNT_ID');
  return { enabled: missing.length === 0, credential, adAccountId, apiVersion, missing };
}

export function createMetaAdsClient(env = process.env, httpClient = axios) {
  const config = getMetaAdsConfig(env);

  function assertConfigured() {
    if (config.enabled) return;
    const error = new Error('Meta Ads no configurado. Faltan variables de entorno.');
    error.name = 'MetaAdsNotConfigured';
    error.code = 'META_ADS_NOT_CONFIGURED';
    error.missing = config.missing;
    throw error;
  }

  async function graphGet(path, params = {}) {
    assertConfigured();
    const url = buildGraphUrl(config.apiVersion, path);
    try {
      const response = await httpClient.get(url, {
        timeout: 30000,
        params: { ...params, [GRAPH_AUTH_PARAM]: config.credential }
      });
      return response.data;
    } catch (error) {
      throw normalizeMetaGraphError(error, url);
    }
  }

  async function graphGetUrl(url) {
    assertConfigured();
    try {
      const response = await httpClient.get(url, { timeout: 30000 });
      return response.data;
    } catch (error) {
      throw normalizeMetaGraphError(error, url);
    }
  }

  return { ...config, graphGet, graphGetUrl };
}

export default { createMetaAdsClient, getMetaAdsConfig, normalizeMetaGraphError };
