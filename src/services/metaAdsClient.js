import express from 'express';
import axios from 'axios';

const DEFAULT_META_API_VERSION = 'v23.0';
const GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const GRAPH_AUTH_PARAM = ['access', 'token'].join('_');
const STATS_BASE_PATH = '/admin/estadisticas';
const FAVICON_MARKER = 'data-lorren-stats-favicon="true"';
const SUMMARY_MARKER = 'data-meta-summary-panel="true"';
const SUMMARY_SCRIPT_MARKER = 'data-meta-summary-script="true"';

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

function renderSummaryPanel() {
  return [
    '<section class="card" ' + SUMMARY_MARKER + '>',
    '  <div class="card-title">Indicadores clave de pauta</div>',
    '  <div id="metaSummaryCards" class="grid-auto">',
    '    <div class="kpi"><div class="kpi-value">Cargando...</div><div class="kpi-label">Resumen Meta Ads</div></div>',
    '  </div>',
    '</section>'
  ].join('\n');
}

function renderSummaryScript() {
  return [
    '<script ' + SUMMARY_SCRIPT_MARKER + '>',
    '(function(){',
    'function money(v){if(!v){return "—";}return new Intl.NumberFormat("es-CO",{style:"currency",currency:"COP",maximumFractionDigits:0}).format(v);}',
    'function num(v){return new Intl.NumberFormat("es-CO").format(v||0);}',
    'function card(label,value,sub){return "<div class=\"kpi\"><div class=\"kpi-value\">"+value+"</div><div class=\"kpi-label\">"+label+"</div><div class=\"kpi-rate\">"+(sub||"")+"</div></div>";}',
    'function paint(data){var box=document.getElementById("metaSummaryCards");if(!box||!data||!data.ok){return;}var t=data.totals||{};box.innerHTML=card("Inversión Meta",money(t.spend),data.since+" a "+data.until)+card("Clics a WhatsApp/enlace",num(t.inlineLinkClicks||t.clicks),"Costo: "+money(t.costPerLinkClick))+card("Registros completos",num(t.completedRegistrations),"Costo: "+money(t.costPerCompletedRegistration))+card("HV recibidas",num(t.cvReceived),"Costo: "+money(t.costPerCv))+card("Aptos",num(t.apt),"Costo: "+money(t.costPerApt))+card("Contratados",num(t.hired),"Costo: "+money(t.costPerHired));}',
    'function quickFilter(){var form=document.querySelector("form[action=\"/admin/estadisticas/campaigns\"]");if(!form||document.getElementById("metaQuickFilter")){return;}var wrap=document.createElement("label");wrap.innerHTML="Buscar anuncio, ciudad, vacante o estado <input id=\"metaQuickFilter\" type=\"search\" placeholder=\"Ej: Ibagué, auxiliar, líder...\">";form.insertBefore(wrap,form.firstChild);wrap.querySelector("input").addEventListener("input",function(){var q=this.value.trim().toLowerCase();document.querySelectorAll("table tbody tr").forEach(function(row){row.style.display=!q||row.textContent.toLowerCase().indexOf(q)>-1?"":"none";});});}',
    'quickFilter();fetch("/admin/estadisticas/meta/summary"+window.location.search,{credentials:"include"}).then(function(r){return r.json();}).then(paint).catch(function(){var box=document.getElementById("metaSummaryCards");if(box){box.innerHTML=card("Resumen Meta Ads","No disponible","Revisa logs si persiste");}});',
    '})();',
    '</script>'
  ].join('\n');
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
  if (!output.includes(SUMMARY_MARKER)) {
    const filtersSectionStart = '<section class="card">\n    <div class="card-title">Filtros de análisis</div>';
    if (output.includes(filtersSectionStart)) output = output.replace(filtersSectionStart, renderSummaryPanel() + '\n' + filtersSectionStart);
  }
  if (!output.includes(SUMMARY_SCRIPT_MARKER) && output.includes('</body>')) output = output.replace('</body>', renderSummaryScript() + '\n</body>');
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
