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

export function getMetaAdsConfig(env = process.env) {
  const credential = String(readEnv(env, ['META', 'ADS', 'ACCESS', 'TOKEN']) || readEnv(env, ['META', 'ACCESS', 'TOKEN']) || '').trim() || null;
  const adAccountId = normalizeAdAccountId(readEnv(env, ['META', 'AD', 'ACCOUNT', 'ID']) || readEnv(env, ['META', 'ADS', 'ACCOUNT', 'ID']));
  const apiVersion = normalizeApiVersion(readEnv(env, ['META', 'API', 'VERSION']) || readEnv(env, ['META', 'GRAPH', 'API', 'VERSION']));
  const missing = [];
  if (!credential) missing.push('META ADS credential');
  if (!adAccountId) missing.push('Meta ad account id');
  return { enabled: missing.length === 0, credential, adAccountId, apiVersion, missing };
}

export function createMetaAdsClient(env = process.env, httpClient = axios) {
  const config = getMetaAdsConfig(env);

  async function graphGet(path, params = {}) {
    if (!config.enabled) {
      const error = new Error('Meta Ads no configurado. Faltan variables de entorno.');
      error.code = 'META_ADS_NOT_CONFIGURED';
      error.missing = config.missing;
      throw error;
    }

    const response = await httpClient.get(buildGraphUrl(config.apiVersion, path), {
      timeout: 30000,
      params: { ...params, [GRAPH_AUTH_PARAM]: config.credential }
    });

    return response.data;
  }

  async function graphGetUrl(url) {
    if (!config.enabled) {
      const error = new Error('Meta Ads no configurado. Faltan variables de entorno.');
      error.code = 'META_ADS_NOT_CONFIGURED';
      error.missing = config.missing;
      throw error;
    }

    const response = await httpClient.get(url, { timeout: 30000 });
    return response.data;
  }

  return { ...config, graphGet, graphGetUrl };
}

export default { createMetaAdsClient, getMetaAdsConfig };
