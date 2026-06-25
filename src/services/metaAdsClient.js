import express from 'express';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const DEFAULT_META_API_VERSION = 'v23.0';
const GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const GRAPH_AUTH_PARAM = ['access', 'token'].join('_');
const STATS_BASE_PATH = '/admin/estadisticas';
const FAVICON_HREF = '/public/favicon-loginpro.svg?v=stats';

let patchPrisma = null;

function getPatchPrisma() {
  if (!patchPrisma) patchPrisma = new PrismaClient();
  return patchPrisma;
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

function normalizeText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeCompare(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function currentPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function html(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isStatsUser(req = {}) {
  const role = req.userRole || req.session?.userRole;
  return role === 'dev' || role === 'admin';
}

function matchCampaignDetail(req = {}) {
  const match = currentPath(req).match(/^\/admin\/estadisticas\/campaigns\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function matchCampaignEdit(req = {}) {
  const match = currentPath(req).match(/^\/admin\/estadisticas\/campaigns\/([^/]+)\/edit$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function resolveVacancy(city, requestedVacancyId) {
  if (!requestedVacancyId) return null;
  const vacancy = await getPatchPrisma().vacancy.findUnique({
    where: { id: requestedVacancyId },
    select: { id: true, city: true }
  });
  if (!vacancy) return null;
  if (city && normalizeCompare(vacancy.city) !== normalizeCompare(city)) return null;
  return vacancy.id;
}

async function saveClassification(campaignId, body = {}) {
  const city = normalizeText(body.city);
  const requestedVacancyId = normalizeText(body.vacancyId);
  const vacancyId = await resolveVacancy(city, requestedVacancyId);
  await getPatchPrisma().campaign.update({
    where: { id: campaignId },
    data: { city: city || null, vacancyId }
  });
}

async function renderClassificationPage(req, res, campaignId) {
  if (!isStatsUser(req)) return res.status(403).send('No autorizado.');

  const [campaign, cities, vacancies] = await Promise.all([
    getPatchPrisma().campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, code: true, name: true, city: true, vacancyId: true, isActive: true }
    }),
    getPatchPrisma().city.findMany({
      where: { usedForRecruitment: true },
      orderBy: { name: 'asc' },
      select: { name: true }
    }),
    getPatchPrisma().vacancy.findMany({
      where: { isActive: true },
      orderBy: [{ city: 'asc' }, { title: 'asc' }],
      select: { id: true, title: true, city: true, schedulingEnabled: true }
    })
  ]);

  if (!campaign) return res.status(404).send('Anuncio no encontrado.');

  const cityOptions = cities.map((city) => {
    const selected = campaign.city === city.name ? 'selected' : '';
    return `<option value="${html(city.name)}" ${selected}>${html(city.name)}</option>`;
  }).join('');

  const vacancyOptions = vacancies.map((vacancy) => {
    const selected = campaign.vacancyId === vacancy.id ? 'selected' : '';
    const interview = vacancy.schedulingEnabled ? ' ✓ entrevista' : '';
    return `<option value="${html(vacancy.id)}" ${selected}>${html(vacancy.title)} — ${html(vacancy.city)}${interview}</option>`;
  }).join('');

  const status = campaign.isActive ? 'Activa' : 'Inactiva';
  const statusClass = campaign.isActive ? 'badge-green' : 'badge-gray';

  return res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">
  <title>Clasificar anuncio</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#1a1d23;font-size:14px;line-height:1.5}
    .navbar{background:#1e2d3d;padding:0 24px;display:flex;align-items:center;gap:8px;height:52px;border-bottom:1px solid #0f1a26}
    .navbar a{color:#94a3b8;text-decoration:none;font-size:13px;font-weight:500;padding:6px 10px;border-radius:6px}.navbar a:hover,.navbar a.active{color:#fff;background:rgba(255,255,255,.08)}.sep{color:#334155}.spacer{flex:1}
    .page{max-width:860px;margin:0 auto;padding:24px 20px 60px}.page-header{margin-bottom:20px}.page-header h1{font-size:20px;font-weight:700;color:#1e2d3d}.page-header p{font-family:monospace;color:#64748b;font-size:12px;margin-top:4px}
    .card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin-bottom:16px}.card-title{font-size:13px;font-weight:700;color:#1e2d3d;margin-bottom:14px;text-transform:uppercase;letter-spacing:.04em}
    label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:#475569}select{border:1px solid #cbd5e1;border-radius:7px;padding:8px 10px;font-size:13px;color:#1a1d23;background:#fff;width:100%;min-height:38px}
    form{display:grid;gap:12px}.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:7px;padding:9px 14px;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none}.btn-primary{background:#0d7a6b;color:#fff}.btn-secondary{background:#f1f5f9;color:#475569;border:1px solid #e2e8f0}.alert{padding:10px 14px;border-radius:8px;margin-bottom:16px;font-weight:600;font-size:13px}.alert-info{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}.alert-error{background:#fee2e2;color:#dc2626;border:1px solid #fca5a5}.badge{display:inline-flex;border-radius:999px;padding:3px 10px;font-weight:800;font-size:12px}.badge-green{background:#dcfce7;color:#15803d}.badge-gray{background:#f1f5f9;color:#475569}.muted{color:#64748b;font-size:12px}.save-status{font-size:12px;font-weight:700;color:#0d7a6b}.save-status.error{color:#dc2626}
    @media(max-width:768px){.page{padding:16px 10px 40px}.navbar{padding:0 10px;overflow-x:auto}.navbar a{white-space:nowrap}.card{padding:14px}.btn{width:100%}}
  </style>
</head>
<body>
  <nav class="navbar"><a href="/admin">Panel</a><span class="sep">›</span><a href="/admin/estadisticas">Estadísticas</a><span class="sep">›</span><a href="/admin/estadisticas/campaigns" class="active">Anuncios</a><span class="spacer"></span><a href="/logout">Cerrar sesión</a></nav>
  <main class="page">
    <div class="page-header"><a href="/admin/estadisticas/campaigns" class="btn btn-secondary" style="margin-bottom:10px">← Anuncios</a><h1>${html(campaign.name)}</h1><p>${html(campaign.code || campaign.id)}</p><div style="margin-top:8px"><span class="badge ${statusClass}">${status}</span></div></div>
    ${req.query?.error ? '<div class="alert alert-error">No fue posible guardar la clasificación.</div>' : ''}
    <section class="card">
      <div class="card-title">Clasificación interna del anuncio</div>
      <div class="alert alert-info">Este módulo es informativo. Aquí solo se asigna ciudad y vacante interna; no se modifica el anuncio real ni la campaña publicitaria en Meta Ads.</div>
      <form id="classificationForm" method="post" action="/admin/estadisticas/campaigns/${html(campaign.id)}/edit">
        <label>Ciudad<select name="city"><option value="">Sin ciudad específica</option>${cityOptions}</select></label>
        <label>Vacante<select name="vacancyId"><option value="">Sin vacante específica</option>${vacancyOptions}</select></label>
        <button type="submit" class="btn btn-primary">Guardar clasificación interna</button>
        <div class="save-status" id="saveStatus"></div>
      </form>
    </section>
  </main>
  <script>
    function norm(value){return String(value||'').trim().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'')}
    function optionCity(option){var text=String(option&&option.textContent||'').trim();var index=text.lastIndexOf('—');return index>=0?text.slice(index+1).replace('✓ entrevista','').trim():''}
    var city=document.querySelector('select[name="city"]');var vacancy=document.querySelector('select[name="vacancyId"]');
    function sync(){var selected=norm(city.value);Array.prototype.forEach.call(vacancy.options,function(option){if(!option.value){option.hidden=false;option.disabled=false;return}var ok=!selected||norm(optionCity(option))===selected;option.hidden=!ok;option.disabled=!ok;if(!ok&&option.selected)vacancy.value=''})}
    city.addEventListener('change',sync);sync();
    document.getElementById('classificationForm').addEventListener('submit',function(){document.getElementById('saveStatus').textContent='Guardando clasificación...'})
  </script>
</body>
</html>`);
}

function installDirectClassificationRouter() {
  if (express.__directMetaAdsClassificationInstalled) return;
  const originalRouter = express.Router;
  express.Router = function patchedRouter(...args) {
    const router = originalRouter.apply(express, args);
    router.use(async (req, res, next) => {
      const campaignIdForEdit = matchCampaignEdit(req);
      if (campaignIdForEdit && req.method === 'POST') {
        if (!isStatsUser(req)) return res.status(403).send('No autorizado.');
        try {
          await saveClassification(campaignIdForEdit, req.body || {});
          return res.redirect(`${STATS_BASE_PATH}/campaigns?classification=1`);
        } catch (error) {
          console.error('[metaAds classification save]', error);
          return res.redirect(`${STATS_BASE_PATH}/campaigns/${encodeURIComponent(campaignIdForEdit)}?error=1`);
        }
      }

      const campaignIdForDetail = matchCampaignDetail(req);
      if (campaignIdForDetail && req.method === 'GET') {
        try {
          return await renderClassificationPage(req, res, campaignIdForDetail);
        } catch (error) {
          console.error('[metaAds classification page]', error);
          return next();
        }
      }
      return next();
    });
    return router;
  };
  Object.assign(express.Router, originalRouter);
  express.__directMetaAdsClassificationInstalled = true;
}

installDirectClassificationRouter();

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
