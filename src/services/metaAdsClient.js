import express from 'express';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const DEFAULT_META_API_VERSION = 'v23.0';
const GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const GRAPH_AUTH_PARAM = ['access', 'token'].join('_');
const STATS_BASE_PATH = '/admin/estadisticas';
const FAVICON_MARKER = 'data-lorren-stats-favicon="true"';
const FAVICON_HREF = '/public/favicon-loginpro.svg?v=stats';
const SUMMARY_MARKER = 'data-meta-summary-panel="true"';
const SUMMARY_SCRIPT_MARKER = 'data-meta-summary-script="true"';
const CLASSIFICATION_SCRIPT_MARKER = 'data-meta-classification-script="true"';
const RESPONSIVE_STYLE_MARKER = 'data-meta-responsive-style="true"';

let classificationPrisma = null;

function getClassificationPrisma() {
  if (!classificationPrisma) classificationPrisma = new PrismaClient();
  return classificationPrisma;
}

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

function isCampaignsPath(req = {}) {
  return currentPath(req) === `${STATS_BASE_PATH}/campaigns`;
}

function isCampaignDetailPath(req = {}) {
  return new RegExp(`^${STATS_BASE_PATH}/campaigns/[^/]+$`).test(currentPath(req));
}

function isStatsUser(req = {}) {
  const role = req.userRole || req.session?.userRole;
  return role === 'dev' || role === 'admin';
}

function normalizeText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeCompare(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function removeSectionByTitle(html, title) {
  const titleIndex = html.toLowerCase().indexOf(`<div class="card-title">${title.toLowerCase()}`);
  if (titleIndex < 0) return html;
  const sectionStart = html.lastIndexOf('<section class="card">', titleIndex);
  const sectionEnd = html.indexOf('</section>', titleIndex);
  if (sectionStart < 0 || sectionEnd < 0) return html;
  return html.slice(0, sectionStart) + html.slice(sectionEnd + '</section>'.length);
}

function injectFavicon(html) {
  if (typeof html !== 'string' || !html.includes('<head>')) return html;
  let output = html.replace(/<link[^>]+rel=["']icon["'][^>]*>/gi, '');
  output = output.replace(/<link[^>]+href=["'][^"']*favicon[^"']*["'][^>]*>/gi, '');
  if (output.includes(FAVICON_MARKER)) return output;
  return output.replace('<head>', `<head>\n  <link ${FAVICON_MARKER} rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">`);
}

function renderResponsiveStyle() {
  return `<style ${RESPONSIVE_STYLE_MARKER}>
    .classification-save-status { margin-top: 10px; font-size: 12px; font-weight: 700; color: #0d7a6b; }
    .classification-save-status.error { color: #dc2626; }
    .meta-action-cell { white-space: nowrap; text-align: right; }
    @media (max-width: 1100px) {
      .page { padding: 16px 10px 40px !important; max-width: 100% !important; }
      .navbar { padding: 0 10px !important; overflow-x: auto !important; }
      .navbar a { white-space: nowrap !important; }
      .card { padding: 14px !important; border-radius: 9px !important; }
      .grid-2, .grid-3, .grid-form { grid-template-columns: 1fr !important; }
      .grid-auto { grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)) !important; gap: 8px !important; }
      .kpi { padding: 10px 11px !important; }
      .kpi-value { font-size: 21px !important; line-height: 1.1 !important; word-break: break-word !important; }
      .kpi-label, .kpi-rate { font-size: 10px !important; }
      .btn { width: 100% !important; justify-content: center !important; min-height: 38px !important; }
      .btn-sm { width: auto !important; min-height: 30px !important; }
      .table-wrap { width: 100% !important; overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; }
      table { min-width: 760px !important; font-size: 12px !important; }
      th, td { padding: 8px 7px !important; }
      .funnel { display: grid !important; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)) !important; gap: 8px !important; overflow: visible !important; }
      .funnel-step { border: 1px solid #e2e8f0 !important; border-radius: 8px !important; min-width: 0 !important; }
      .funnel-arrow { display: none !important; }
      .funnel-step-value { font-size: 20px !important; }
      input, select, textarea { min-height: 38px !important; }
      form[method="post"] button[type="submit"] { width: 100% !important; }
    }
  </style>`;
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

function sharedClientHelpers() {
  return `
  function norm(value){ return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''); }
  function optionCity(option){ var text = String(option && option.textContent || '').trim(); var index = text.lastIndexOf('—'); return index >= 0 ? text.slice(index + 1).replace('✓ entrevista','').trim() : ''; }
  function wireCityVacancySync(){
    document.querySelectorAll('select[name="city"]').forEach(function(citySelect){
      var form = citySelect.closest('form') || document;
      var vacancySelect = form.querySelector('select[name="vacancyId"]');
      if (!vacancySelect || vacancySelect.dataset.citySynced === 'true') return;
      vacancySelect.dataset.citySynced = 'true';
      function sync(){
        var selectedCity = norm(citySelect.value);
        Array.prototype.forEach.call(vacancySelect.options, function(option){
          if (!option.value) { option.hidden = false; option.disabled = false; return; }
          var matches = !selectedCity || norm(optionCity(option)) === selectedCity;
          option.hidden = !matches; option.disabled = !matches;
          if (!matches && option.selected) vacancySelect.value = '';
        });
      }
      citySelect.addEventListener('change', sync); sync();
    });
  }
  function forceZeroes(){ document.querySelectorAll('.funnel-step-value').forEach(function(el){ if(!el.textContent.trim()) el.textContent='0'; }); }
  `;
}

function renderStatsUiScript() {
  return `<script ${SUMMARY_SCRIPT_MARKER}>
(function(){
  ${sharedClientHelpers()}
  function money(v){ if(!v){return '—';} return new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(v); }
  function num(v){return new Intl.NumberFormat('es-CO').format(v||0);}
  function card(label,value,sub){return '<div class="kpi"><div class="kpi-value">'+value+'</div><div class="kpi-label">'+label+'</div><div class="kpi-rate">'+(sub||'')+'</div></div>';}
  function paint(data){ var box=document.getElementById('metaSummaryCards'); if(!box||!data||!data.ok){return;} var t=data.totals||{}; box.innerHTML=card('Inversión Meta',money(t.spend),data.since+' a '+data.until)+card('Clics a WhatsApp/enlace',num(t.inlineLinkClicks||t.clicks),'Costo: '+money(t.costPerLinkClick))+card('Registros completos',num(t.completedRegistrations),'Costo: '+money(t.costPerCompletedRegistration))+card('HV recibidas',num(t.cvReceived),'Costo: '+money(t.costPerCv))+card('Aptos',num(t.apt),'Costo: '+money(t.costPerApt))+card('Contratados',num(t.hired),'Costo: '+money(t.costPerHired)); }
  function quickFilter(){
    var form=document.querySelector('form[action="/admin/estadisticas/campaigns"]');
    if(!form||document.getElementById('metaQuickFilter')){return;}
    var wrap=document.createElement('label');
    wrap.innerHTML='Buscar anuncio, ciudad, vacante o estado <input id="metaQuickFilter" type="search" placeholder="Ej: Ibagué, auxiliar, líder...">';
    form.insertBefore(wrap,form.firstChild);
    wrap.querySelector('input').addEventListener('input',function(){
      var q=this.value.trim().toLowerCase();
      document.querySelectorAll('table tbody tr').forEach(function(row){ row.style.display=!q||row.textContent.toLowerCase().indexOf(q)>-1?'':'none'; });
    });
  }
  function simplifyAdTable(){
    document.querySelectorAll('table').forEach(function(table){
      var headers = Array.prototype.map.call(table.querySelectorAll('thead th'), function(th){ return (th.textContent || '').trim().toLowerCase(); });
      if (!headers.includes('agendados') && !headers.includes('confirmados') && !headers.includes('asistieron')) return;
      var removeLabels = ['agendados','confirmados','asistieron'];
      var removeIndexes = headers.map(function(text, index){ return removeLabels.includes(text) ? index : -1; }).filter(function(index){ return index >= 0; }).sort(function(a,b){ return b-a; });
      table.querySelectorAll('tr').forEach(function(row){
        removeIndexes.forEach(function(index){ if (row.cells[index]) row.cells[index].remove(); });
        var last = row.cells[row.cells.length - 1];
        if (last) last.classList.add('meta-action-cell');
      });
    });
  }
  wireCityVacancySync(); quickFilter(); forceZeroes(); simplifyAdTable();
  fetch('/admin/estadisticas/meta/summary'+window.location.search,{credentials:'include'}).then(function(r){return r.json();}).then(paint).catch(function(){var box=document.getElementById('metaSummaryCards');if(box){box.innerHTML=card('Resumen Meta Ads','No disponible','Revisa logs si persiste');}});
})();
</script>`;
}

function renderClassificationScript() {
  return `<script ${CLASSIFICATION_SCRIPT_MARKER}>
(function(){
  ${sharedClientHelpers()}
  document.querySelectorAll('.page-header h1').forEach(function(el){ el.textContent = el.textContent.replace(/^Campaña:/, 'Anuncio:'); });
  document.querySelectorAll('a.btn').forEach(function(el){ var text = (el.textContent || '').trim(); if (text.indexOf('← Campañas') === 0) el.textContent = '← Anuncios'; });
  document.querySelectorAll('.card-title').forEach(function(el){ if ((el.textContent || '').trim() === 'Editar campaña') el.textContent = 'Clasificación interna del anuncio'; });
  forceZeroes();
  var form = document.querySelector('form[action*="/admin/estadisticas/campaigns/"][action$="/edit"]');
  if (form) {
    if (!form.querySelector('[data-classification-help="true"]')) {
      var help = document.createElement('div');
      help.setAttribute('data-classification-help','true');
      help.className = 'alert alert-info';
      help.style.marginBottom = '12px';
      help.textContent = 'Este módulo es informativo. Aquí solo se clasifica el anuncio con ciudad y vacante interna; no se modifican los datos reales de Meta Ads.';
      form.insertBefore(help, form.firstChild);
    }
    ['name','budgetCOP','notes','startsAt','endsAt','isActive'].forEach(function(field){
      form.querySelectorAll('[name="'+field+'"]').forEach(function(input){ var label = input.closest('label'); if (label) label.style.display = 'none'; });
    });
    var button = form.querySelector('button[type="submit"]');
    if (button) { button.textContent = 'Guardar clasificación interna'; button.style.width = '100%'; button.style.justifyContent = 'center'; }
    var status = document.createElement('div');
    status.className = 'classification-save-status';
    status.textContent = '';
    form.appendChild(status);
    form.addEventListener('submit', async function(event){
      event.preventDefault();
      if (button) { button.disabled = true; button.textContent = 'Guardando clasificación...'; }
      status.className = 'classification-save-status';
      status.textContent = 'Guardando ciudad y vacante asociada...';
      try {
        var campaignId = decodeURIComponent((window.location.pathname.match(/\/campaigns\/([^/]+)/) || [])[1] || '');
        var payload = {
          campaignId: campaignId,
          city: (form.querySelector('[name="city"]') || {}).value || '',
          vacancyId: (form.querySelector('[name="vacancyId"]') || {}).value || ''
        };
        var response = await fetch('/admin/estadisticas/meta/classify', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        var result = await response.json().catch(function(){ return {}; });
        if (!response.ok || result.ok === false) throw new Error(result.message || 'save_failed');
        status.textContent = 'Clasificación guardada. Volviendo al listado...';
        window.location.href = '/admin/estadisticas/campaigns?classification=1';
      } catch (error) {
        status.className = 'classification-save-status error';
        status.textContent = 'No fue posible guardar. Revisa logs de Railway o intenta de nuevo.';
        if (button) { button.disabled = false; button.textContent = 'Guardar clasificación interna'; }
      }
    });
  }
  wireCityVacancySync();
})();
</script>`;
}

function cleanStatsHtml(html, req) {
  if (typeof html !== 'string' || !isStatsPath(req)) return html;
  let output = injectFavicon(html);
  if (!output.includes(RESPONSIVE_STYLE_MARKER) && output.includes('</head>')) output = output.replace('</head>', renderResponsiveStyle() + '\n</head>');

  if (isCampaignDetailPath(req)) {
    output = output.replace(/Campaña:/g, 'Anuncio:');
    output = output.replace(/← Campañas/g, '← Anuncios');
    if (!output.includes(CLASSIFICATION_SCRIPT_MARKER) && output.includes('</body>')) output = output.replace('</body>', renderClassificationScript() + '\n</body>');
    return output;
  }

  if (!isCampaignsPath(req)) return output;

  output = output.replace('<div class="alert alert-success">Meta Ads configurado para sincronización. El dashboard usa snapshots guardados para evitar llamadas a Meta en cada carga.</div>', '');
  output = output.replace('<div class="alert alert-info">Meta Ads no configurado. Las métricas internas de Lórren siguen disponibles.</div>', '');
  output = output.replace(/Campañas Meta Ads/g, 'Anuncios Meta Ads');
  output = output.replace(/Campañas registradas/g, 'Anuncios Meta sincronizados');
  output = output.replace(/Embudo de conversión — todas las campañas/g, 'Embudo de conversión — anuncios sincronizados');
  output = output.replace(/<th>Campaña<\/th>/g, '<th>Anuncio</th>');
  output = output.replace(/<th>Estado<\/th>/g, '<th>Estado Meta</th>');
  output = output.replace(/>Ver →<\/a>/g, '>Clasificar</a>');
  output = output.replace(/Aún no hay campañas\. Crea la primera usando el formulario de abajo\./g, 'Aún no hay anuncios sincronizados desde Meta Ads.');
  output = output.replace(/<div class="alert alert-info" style="margin-bottom:12px;font-weight:400;font-size:12px"><strong>Quality Score<\/strong>:[\s\S]*?<\/div>/, '<div class="alert alert-info" style="margin-bottom:12px;font-weight:400;font-size:12px">Semáforo de rendimiento: compara calidad interna del anuncio según registros completos, HV, aptos y contratados. Se muestra solo cuando hay datos suficientes.</div>');
  output = removeSectionByTitle(output, 'Nueva campaña');
  output = removeSectionByTitle(output, 'Metadata Meta sin campaña asociada');
  output = removeSectionByTitle(output, 'Sincronización Meta Ads');
  if (!output.includes(SUMMARY_MARKER)) {
    const filtersSectionStart = '<section class="card">\n    <div class="card-title">Filtros de análisis</div>';
    if (output.includes(filtersSectionStart)) output = output.replace(filtersSectionStart, renderSummaryPanel() + '\n' + filtersSectionStart);
  }
  if (!output.includes(SUMMARY_SCRIPT_MARKER) && output.includes('</body>')) output = output.replace('</body>', renderStatsUiScript() + '\n</body>');
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

function installClassificationEndpoint() {
  const appPrototype = express.application;
  if (appPrototype.__metaAdsClassificationEndpointPatchInstalled) return;
  const originalUse = appPrototype.use;
  appPrototype.use = function useWithMetaAdsClassificationEndpoint(...args) {
    const result = originalUse.apply(this, args);
    const justInstalledSession = args.some((arg) => typeof arg === 'function' && arg.name === 'session');
    if (justInstalledSession && !this.__metaAdsClassificationEndpointInstalled) {
      originalUse.call(
        this,
        `${STATS_BASE_PATH}/meta/classify`,
        express.json({ limit: '20kb' }),
        async (req, res) => {
          if (!isStatsUser(req)) return res.status(403).json({ ok: false, message: 'No autorizado.' });
          const campaignId = normalizeText(req.body?.campaignId);
          const city = normalizeText(req.body?.city);
          const requestedVacancyId = normalizeText(req.body?.vacancyId);
          if (!campaignId) return res.status(400).json({ ok: false, message: 'Falta anuncio.' });
          try {
            let vacancyId = null;
            if (requestedVacancyId) {
              const vacancy = await getClassificationPrisma().vacancy.findUnique({
                where: { id: requestedVacancyId },
                select: { id: true, city: true }
              });
              if (vacancy && (!city || normalizeCompare(vacancy.city) === normalizeCompare(city))) vacancyId = vacancy.id;
            }
            await getClassificationPrisma().campaign.update({
              where: { id: campaignId },
              data: { city: city || null, vacancyId }
            });
            return res.json({ ok: true });
          } catch (error) {
            console.error('[metaAdsClassificationEndpoint]', error);
            return res.status(500).json({ ok: false, message: 'No fue posible guardar clasificación.' });
          }
        }
      );
      this.__metaAdsClassificationEndpointInstalled = true;
    }
    return result;
  };
  appPrototype.__metaAdsClassificationEndpointPatchInstalled = true;
}

installClassificationEndpoint();
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
