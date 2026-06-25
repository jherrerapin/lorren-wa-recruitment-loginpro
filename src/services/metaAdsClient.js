import express from 'express';
import axios from 'axios';

const DEFAULT_META_API_VERSION = 'v23.0';
const GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const GRAPH_AUTH_PARAM = ['access', 'token'].join('_');
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

function canInjectSyncButton(req = {}) {
  const isCampaignsPage = req.method === 'GET' && req.path === '/campaigns' && req.baseUrl === '/admin/estadisticas';
  const isDevUser = req.userRole === 'dev' || req.session?.userRole === 'dev';
  return isCampaignsPage && isDevUser;
}

function renderSyncButtonPanel() {
  return `<section class="card" ${SYNC_BUTTON_MARKER}>
    <div class="card-title">Sincronización Meta Ads</div>
    <div class="alert alert-info" style="margin-bottom:12px;font-weight:400;font-size:12px">
      Este botón trae campañas reales de Meta Ads y actualiza las métricas guardadas en Estadísticas. No crea campañas manuales: las sincroniza desde Meta.
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button type="button" class="btn btn-primary" id="metaAdsSyncButton">Sincronizar Meta Ads</button>
      <span id="metaAdsSyncStatus" class="muted text-xs">Usa el rango de fechas aplicado en los filtros; si no hay rango, sincroniza el día actual.</span>
    </div>
    <script>
      (() => {
        const button = document.getElementById('metaAdsSyncButton');
        const status = document.getElementById('metaAdsSyncStatus');
        if (!button || !status) return;
        button.addEventListener('click', async () => {
          const params = new URLSearchParams(window.location.search);
          const body = new URLSearchParams();
          if (params.get('from')) body.set('since', params.get('from'));
          if (params.get('to')) body.set('until', params.get('to'));
          button.disabled = true;
          status.textContent = 'Sincronizando con Meta Ads...';
          try {
            const response = await fetch('/admin/estadisticas/meta/sync', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body
            });
            const result = await response.json();
            if (!response.ok || result.ok === false) {
              const message = result?.error?.message || result?.message || 'No fue posible sincronizar Meta Ads.';
              status.textContent = message;
              button.disabled = false;
              return;
            }
            if (result.enabled === false) {
              status.textContent = result.message || 'Meta Ads no está configurado.';
              button.disabled = false;
              return;
            }
            status.textContent = `Listo: ${result.autoCampaigns || 0} campañas, ${result.campaignSnapshots || 0} métricas de campaña y ${result.adSnapshots || 0} métricas de anuncios sincronizadas.`;
            window.setTimeout(() => window.location.reload(), 1200);
          } catch (error) {
            status.textContent = 'Error sincronizando Meta Ads. Revisa el token, la cuenta publicitaria o los logs de Railway.';
            button.disabled = false;
          }
        });
      })();
    </script>
  </section>`;
}

function injectMetaAdsSyncButton(html, req) {
  if (typeof html !== 'string' || html.includes(SYNC_BUTTON_MARKER) || !canInjectSyncButton(req)) return html;
  const filtersSectionStart = '<section class="card">\n    <div class="card-title">Filtros de análisis</div>';
  if (!html.includes(filtersSectionStart)) return html;
  return html.replace(filtersSectionStart, `${renderSyncButtonPanel()}\n${filtersSectionStart}`);
}

function installMetaAdsSyncButtonInjector() {
  const responsePrototype = express.response;
  if (responsePrototype.__metaAdsSyncButtonInjectorInstalled) return;
  const originalSend = responsePrototype.send;
  responsePrototype.send = function sendWithMetaAdsSyncButton(body) {
    return originalSend.call(this, injectMetaAdsSyncButton(body, this.req));
  };
  responsePrototype.__metaAdsSyncButtonInjectorInstalled = true;
}

installMetaAdsSyncButtonInjector();

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
