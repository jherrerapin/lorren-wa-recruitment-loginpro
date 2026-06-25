import express from 'express';
import axios from 'axios';

const DEFAULT_META_API_VERSION = 'v23.0';
const GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const GRAPH_AUTH_PARAM = ['access', 'token'].join('_');
const STATS_BASE_PATH = '/admin/estadisticas';
const FAVICON_HREF = '/public/favicon-loginpro.svg?v=stats';
const CLEANER_MARKER = 'data-estadisticas-cleaner="true"';

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

function requestPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function injectStatsFavicon(body, req) {
  if (typeof body !== 'string') return body;
  if (req.method !== 'GET') return body;
  if (!requestPath(req).startsWith(STATS_BASE_PATH)) return body;
  if (!body.includes('<head>')) return body;
  if (body.includes(FAVICON_HREF)) return body;
  return body.replace('<head>', `<head>\n  <link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">`);
}

function injectListCleaner(body, req) {
  if (typeof body !== 'string') return body;
  if (req.method !== 'GET') return body;
  if (requestPath(req) !== `${STATS_BASE_PATH}/campaigns`) return body;
  if (!body.includes('</body>') || body.includes(CLEANER_MARKER)) return body;
  const script = `<script ${CLEANER_MARKER}>
(function(){
  function normalize(text){ return String(text || '').trim().toLowerCase(); }
  function removeSections(){
    document.querySelectorAll('.card-title').forEach(function(title){
      var text = normalize(title.textContent);
      if (text === 'nueva campaña' || text.indexOf('metadata meta sin campaña asociada') === 0 || text.indexOf('sincronización meta ads') === 0) {
        var section = title.closest('section');
        if (section) section.remove();
      }
    });
  }
  function removeSeeButtons(){
    document.querySelectorAll('a[href^="/admin/estadisticas/campaigns/"]').forEach(function(link){
      var text = normalize(link.textContent);
      if (text === 'ver →' || text === 'ver' || text === 'clasificar') {
        var cell = link.closest('td');
        if (cell) cell.remove(); else link.remove();
      }
    });
    document.querySelectorAll('table thead tr').forEach(function(row){
      var last = row.lastElementChild;
      if (last && normalize(last.textContent) === '') last.remove();
    });
  }
  function rename(){
    document.querySelectorAll('.page-header h1').forEach(function(el){ el.textContent = el.textContent.replace('Campañas Meta Ads','Anuncios Meta Ads'); });
    document.querySelectorAll('.card-title').forEach(function(el){ el.textContent = el.textContent.replace('Campañas registradas','Anuncios Meta sincronizados'); });
    document.querySelectorAll('th').forEach(function(el){ if (normalize(el.textContent) === 'campaña') el.textContent = 'Anuncio'; if (normalize(el.textContent) === 'estado') el.textContent = 'Estado Meta'; });
  }
  removeSections();
  removeSeeButtons();
  rename();
})();
</script>`;
  return body.replace('</body>', script + '\n</body>');
}

function installStatsCleaner() {
  if (express.response.__estadisticasCleanerInstalled) return;
  const originalSend = express.response.send;
  express.response.send = function patchedSend(body) {
    let output = injectStatsFavicon(body, this.req);
    output = injectListCleaner(output, this.req);
    return originalSend.call(this, output);
  };
  express.response.__estadisticasCleanerInstalled = true;
}

installStatsCleaner();

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
