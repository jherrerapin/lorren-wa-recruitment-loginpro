import express from 'express';
import axios from 'axios';

const DEFAULT_META_API_VERSION = 'v23.0';
const GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const GRAPH_AUTH_PARAM = ['access', 'token'].join('_');
const STATS_BASE_PATH = '/admin/estadisticas';
const FAVICON_MARKER = 'data-lorren-stats-favicon="true"';

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

function currentPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function isStatsPath(req = {}) {
  return req.method === 'GET' && currentPath(req).startsWith(STATS_BASE_PATH);
}

function removeSectionByTitle(html, title) {
  const titleIndex = html.toLowerCase().indexOf(`<div class="card-title">${title.toLowerCase()}`);
  if (titleIndex < 0) return html;
  const sectionStart = html.lastIndexOf('<section class="card">', titleIndex);
  const sectionEnd = html.indexOf('</section>', titleIndex);
  if (sectionStart < 0 || sectionEnd < 0) return html;
  return html.slice(0, sectionStart) + html.slice(sectionEnd + '</section>'.length);
}

function cleanStatsHtml(html, req) {
  if (typeof html !== 'string' || !isStatsPath(req)) return html;
  let output = html;
  if (!output.includes(FAVICON_MARKER) && output.includes('<head>')) {
    output = output.replace('<head>', `<head>\n  <link ${FAVICON_MARKER} rel="icon" href="/favicon.ico">`);
  }
  if (currentPath(req) !== `${STATS_BASE_PATH}/campaigns`) return output;

  output = output.replace('<div class="alert alert-success">Meta Ads configurado para sincronización. El dashboard usa snapshots guardados para evitar llamadas a Meta en cada carga.</div>', '');
  output = output.replace('<div class="alert alert-info">Meta Ads no configurado. Las métricas internas de Lórren siguen disponibles.</div>', '');
  output = output.replace(/Campañas Meta Ads/g, 'Anuncios Meta Ads');
  output = output.replace(/Campañas registradas/g, 'Anuncios Meta sincronizados');
  output = output.replace(/<th>Campaña<\/th>/g, '<th>Anuncio</th>');
  output = output.replace(/<th>Estado<\/th>/g, '<th>Estado Meta</th>');
  output = output.replace(/Aún no hay campañas\. Crea la primera usando el formulario de abajo\./g, 'Aún no hay anuncios sincronizados desde Meta Ads.');
  output = output.replace(/<div class="alert alert-info" style="margin-bottom:12px;font-weight:400;font-size:12px"><strong>Quality Score<\/strong>:[\s\S]*?<\/div>/, '<div class="alert alert-info" style="margin-bottom:12px;font-weight:400;font-size:12px">Semáforo de rendimiento: compara calidad interna del anuncio según registros completos, HV, aptos y contratados. Se muestra solo cuando hay datos suficientes.</div>');
  output = removeSectionByTitle(output, 'Nueva campaña');
  output = removeSectionByTitle(output, 'Metadata Meta sin campaña asociada');
  output = removeSectionByTitle(output, 'Sincronización Meta Ads');
  return output;
}

function installStatsHtmlCleaner() {
  const responsePrototype = express.response;
  if (responsePrototype.__metaAdsStatsHtmlCleanerInstalled) return;
  const originalSend = responsePrototype.send;
  responsePrototype.send = function sendWithStatsHtmlCleaner(body) {
    return originalSend.call(this, cleanStatsHtml(body, this.req));
  };
  responsePrototype.__metaAdsStatsHtmlCleanerInstalled = true;
}

installStatsHtmlCleaner();

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
