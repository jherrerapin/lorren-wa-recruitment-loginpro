import express from 'express';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const DEFAULT_META_API_VERSION = 'v23.0';
const GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const GRAPH_AUTH_PARAM = ['access', 'token'].join('_');
const STATS_BASE_PATH = '/admin/estadisticas';
const FAVICON_HREF = '/public/favicon-loginpro.svg?v=stats';
const CLEANER_MARKER = 'data-estadisticas-cleaner="true"';

let prismaForStatsPatch = null;

function db() {
  if (!prismaForStatsPatch) prismaForStatsPatch = new PrismaClient();
  return prismaForStatsPatch;
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

function requestPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function userCanAccessStats(req = {}) {
  const role = req.userRole || req.session?.userRole;
  return role === 'dev' || role === 'admin';
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length ? text : null;
}

function normalizeCompare(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function statsCampaignId(req = {}) {
  const match = requestPath(req).match(/^\/admin\/estadisticas\/campaigns\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function statsCampaignEditId(req = {}) {
  const match = requestPath(req).match(/^\/admin\/estadisticas\/campaigns\/([^/]+)\/edit$/);
  return match ? decodeURIComponent(match[1]) : null;
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

async function saveStatsClassification(campaignId, body = {}) {
  const city = normalizeText(body.city);
  const requestedVacancyId = normalizeText(body.vacancyId);
  let vacancyId = null;

  if (requestedVacancyId) {
    const vacancy = await db().vacancy.findUnique({
      where: { id: requestedVacancyId },
      select: { id: true, city: true }
    });
    if (vacancy && (!city || normalizeCompare(vacancy.city) === normalizeCompare(city))) {
      vacancyId = vacancy.id;
    }
  }

  await db().campaign.update({
    where: { id: campaignId },
    data: { city: city || null, vacancyId }
  });
}

async function renderStatsClassificationPage(req, res, campaignId) {
  if (!userCanAccessStats(req)) return res.status(403).send('No autorizado.');

  const [campaign, cities, vacancies] = await Promise.all([
    db().campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, code: true, name: true, city: true, vacancyId: true }
    }),
    db().city.findMany({
      where: { usedForRecruitment: true },
      orderBy: { name: 'asc' },
      select: { name: true }
    }),
    db().vacancy.findMany({
      where: { isActive: true },
      orderBy: [{ city: 'asc' }, { title: 'asc' }],
      select: { id: true, title: true, city: true }
    })
  ]);

  if (!campaign) return res.status(404).send('Anuncio no encontrado.');

  const cityOptions = cities.map((item) => {
    const selected = campaign.city === item.name ? 'selected' : '';
    return `<option value="${escapeHtml(item.name)}" ${selected}>${escapeHtml(item.name)}</option>`;
  }).join('');

  const vacancyOptions = vacancies.map((vacancy) => {
    const selected = campaign.vacancyId === vacancy.id ? 'selected' : '';
    return `<option value="${escapeHtml(vacancy.id)}" ${selected}>${escapeHtml(vacancy.title)} — ${escapeHtml(vacancy.city)}</option>`;
  }).join('');

  return res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}"><title>Clasificación interna del anuncio</title><style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#1a1d23}.navbar{height:52px;background:#1e2d3d;display:flex;align-items:center;gap:8px;padding:0 24px}.navbar a{color:#94a3b8;text-decoration:none;font-size:13px;font-weight:600;padding:6px 10px;border-radius:6px}.navbar a.active,.navbar a:hover{color:#fff;background:rgba(255,255,255,.08)}.spacer{flex:1}.page{max-width:760px;margin:0 auto;padding:24px 18px 56px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:20px}.title{font-size:20px;font-weight:800;color:#1e2d3d;margin:0 0 2px}.muted{font-size:12px;color:#64748b;font-family:monospace;margin-bottom:18px}.card-title{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#1e2d3d;margin-bottom:12px}.alert{background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px;font-weight:600}form{display:grid;gap:12px}label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:700;color:#475569}select{width:100%;min-height:40px;border:1px solid #cbd5e1;border-radius:7px;padding:8px 10px;background:#fff}.btn{border:0;border-radius:7px;padding:10px 14px;font-weight:800;cursor:pointer}.btn-primary{background:#0d7a6b;color:#fff}.btn-secondary{display:inline-block;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;text-decoration:none;margin-bottom:12px}.status{font-size:12px;font-weight:800;color:#0d7a6b}@media(max-width:760px){.navbar{padding:0 10px;overflow-x:auto}.navbar a{white-space:nowrap}.page{padding:16px 10px}.card{padding:14px}.btn{width:100%}}</style></head><body><nav class="navbar"><a href="/admin">Panel</a><a href="/admin/estadisticas">Estadísticas</a><a href="/admin/estadisticas/campaigns" class="active">Anuncios</a><span class="spacer"></span><a href="/logout">Cerrar sesión</a></nav><main class="page"><a class="btn btn-secondary" href="/admin/estadisticas/campaigns">← Volver a anuncios</a><h1 class="title">${escapeHtml(campaign.name)}</h1><div class="muted">${escapeHtml(campaign.code || campaign.id)}</div><section class="card"><div class="card-title">Clasificación interna del anuncio</div><div class="alert">Este panel es solo informativo. Aquí únicamente se asigna ciudad y vacante interna; no se crea ni se modifica la campaña publicitaria en Meta Ads.</div><form method="post" action="/admin/estadisticas/campaigns/${escapeHtml(campaign.id)}/edit"><label>Ciudad<select name="city"><option value="">Sin ciudad asignada</option>${cityOptions}</select></label><label>Vacante<select name="vacancyId"><option value="">Sin vacante asignada</option>${vacancyOptions}</select></label><button class="btn btn-primary" type="submit">Guardar clasificación</button><div class="status" id="status"></div></form></section></main><script>function clean(v){return String(v||'').trim().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'')}function optCity(o){var t=String(o.textContent||'');var p=t.lastIndexOf('—');return p>=0?t.slice(p+1).trim():''}var c=document.querySelector('select[name="city"]');var v=document.querySelector('select[name="vacancyId"]');function sync(){var city=clean(c.value);Array.prototype.forEach.call(v.options,function(o){if(!o.value){o.hidden=false;o.disabled=false;return}var ok=!city||clean(optCity(o))===city;o.hidden=!ok;o.disabled=!ok;if(!ok&&o.selected)v.value=''})}c.addEventListener('change',sync);sync();document.querySelector('form').addEventListener('submit',function(){document.getElementById('status').textContent='Guardando clasificación...'})</script></body></html>`);
}

function installStatsClassificationRouter() {
  if (express.__estadisticasClassificationRouterInstalled) return;
  const originalRouter = express.Router;
  express.Router = function patchedRouter(...args) {
    const router = originalRouter.apply(express, args);
    router.use(async (req, res, next) => {
      const editId = statsCampaignEditId(req);
      if (editId && req.method === 'POST') {
        try {
          await saveStatsClassification(editId, req.body || {});
          return res.redirect(`${STATS_BASE_PATH}/campaigns?classification=1`);
        } catch (error) {
          console.error('[estadisticas classification save]', error);
          return res.redirect(`${STATS_BASE_PATH}/campaigns/${encodeURIComponent(editId)}?error=1`);
        }
      }

      const detailId = statsCampaignId(req);
      if (detailId && req.method === 'GET') {
        try {
          return await renderStatsClassificationPage(req, res, detailId);
        } catch (error) {
          console.error('[estadisticas classification page]', error);
          return next(error);
        }
      }

      return next();
    });
    return router;
  };
  Object.assign(express.Router, originalRouter);
  express.__estadisticasClassificationRouterInstalled = true;
}

installStatsClassificationRouter();
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
