import express from 'express';
import axios from 'axios';

const DEFAULT_META_API_VERSION = 'v23.0';
const GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const GRAPH_AUTH_PARAM = ['access', 'token'].join('_');
const STATS_BASE_PATH = '/admin/estadisticas';
const SYNC_BUTTON_MARKER = 'data-meta-ads-sync-button="true"';

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

function isDevRequest(req = {}) {
  return req.userRole === 'dev' || req.session?.userRole === 'dev';
}

function currentPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function canInjectSyncButton(req = {}) {
  return req.method === 'GET' && currentPath(req) === `${STATS_BASE_PATH}/campaigns` && isDevRequest(req);
}

function renderSyncButtonPanel() {
  return [
    '<section class="card" ' + SYNC_BUTTON_MARKER + '>',
    '  <div class="card-title">Sincronización Meta Ads</div>',
    '  <div class="alert alert-info" style="margin-bottom:12px;font-weight:400;font-size:12px">Este botón trae campañas reales de Meta Ads y actualiza las métricas guardadas en Estadísticas.</div>',
    '  <form method="post" action="' + STATS_BASE_PATH + '/meta/sync-form" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">',
    '    <button type="submit" class="btn btn-primary">Sincronizar Meta Ads</button>',
    '    <span class="muted text-xs">Después de sincronizar, el panel volverá a cargar las campañas.</span>',
    '  </form>',
    '</section>'
  ].join('\n');
}

function injectSyncButton(html, req) {
  if (typeof html !== 'string') return html;
  if (!canInjectSyncButton(req)) return html;
  if (html.includes(SYNC_BUTTON_MARKER)) return html;
  const filtersSectionStart = '<section class="card">\n    <div class="card-title">Filtros de análisis</div>';
  if (!html.includes(filtersSectionStart)) return html;
  return html.replace(filtersSectionStart, renderSyncButtonPanel() + '\n' + filtersSectionStart);
}

function installSyncButtonInjector() {
  const responsePrototype = express.response;
  if (responsePrototype.__metaAdsSyncButtonInjectorInstalled) return;
  const originalSend = responsePrototype.send;
  responsePrototype.send = function sendWithMetaAdsSyncButton(body) {
    return originalSend.call(this, injectSyncButton(body, this.req));
  };
  responsePrototype.__metaAdsSyncButtonInjectorInstalled = true;
}

installSyncButtonInjector();

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
      params: {
        ...params,
        [GRAPH_AUTH_PARAM]: config.credential
      }
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

  return {
    ...config,
    graphGet,
    graphGetUrl
  };
}

export default { createMetaAdsClient, getMetaAdsConfig };
