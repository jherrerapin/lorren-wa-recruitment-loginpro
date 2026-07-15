import express from 'express';
import {
  aggregateMetaAdStatistics,
  buildMetaAdStatistics,
  campaignMetaStatus,
  missingVacancyCount
} from '../services/metaRecruitmentStats.js';
import { getMetaAdsConfig } from '../services/metaAdsClient.js';
import { syncMetaAdsInsights } from '../services/metaAdsInsightsSync.js';

const BASE_PATH = '/admin/estadisticas';
const DEFAULT_LOOKBACK_DAYS = 90;

function canAccess(req = {}) {
  const role = req.userRole || req.session?.userRole;
  const username = req.username || req.session?.username;
  const scope = req.userAccessScope || req.session?.userAccessScope;
  return role === 'dev'
    || role === 'admin'
    || (username === 'reclutador-general' && scope === 'ALL');
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
  return text || null;
}

function normalizeDate(value) {
  const text = normalizeText(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function dateRange(query = {}) {
  const untilDate = new Date();
  const sinceDate = new Date(untilDate);
  sinceDate.setUTCDate(sinceDate.getUTCDate() - DEFAULT_LOOKBACK_DAYS);
  const since = normalizeDate(query.from || query.since) || dateOnly(sinceDate);
  const until = normalizeDate(query.to || query.until) || dateOnly(untilDate);
  return {
    since,
    until,
    bounds: {
      gte: new Date(`${since}T00:00:00.000Z`),
      lte: new Date(`${until}T23:59:59.999Z`)
    }
  };
}

function metaConfigured() {
  return getMetaAdsConfig().enabled;
}

function formatMoney(value, currency = 'COP') {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return '—';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: currency || 'COP',
    maximumFractionDigits: 0
  }).format(amount);
}

function formatInteger(value) {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function formatDateTime(value, timeZone = 'America/Bogota') {
  if (!value) return 'Sin sincronización registrada';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin sincronización registrada';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: timeZone || 'America/Bogota',
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function rate(part, total) {
  if (!total) return '—';
  return `${Math.round((Number(part || 0) / Number(total)) * 100)}%`;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function comparableCost(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function confidenceFor(metric = {}) {
  const candidates = nonNegativeNumber(metric.candidatesCount);
  if (candidates === 0) return { label: 'Sin datos', cls: 'muted' };
  if (candidates < 5) return { label: 'Muy pocos datos', cls: 'muted' };
  if (candidates < 15) return { label: 'Datos iniciales', cls: 'info' };
  if (candidates < 30) return { label: 'Datos suficientes', cls: 'good' };
  return { label: 'Datos sólidos', cls: 'good' };
}

export function recommendationFor(metric = {}, totals = {}) {
  const candidates = nonNegativeNumber(metric.candidatesCount);
  const spend = nonNegativeNumber(metric.spend);
  const completedRegistrations = nonNegativeNumber(metric.completedRegistrations);
  const cvReceived = nonNegativeNumber(metric.cvReceived);
  const apt = nonNegativeNumber(metric.apt);
  const scheduled = nonNegativeNumber(metric.scheduled);
  const attended = nonNegativeNumber(metric.attended);
  const hired = nonNegativeNumber(metric.hired);
  const costPerHired = comparableCost(metric.costPerHired);
  const averageCostPerHired = comparableCost(totals.costPerHired);
  const costPerApt = comparableCost(metric.costPerApt);
  const averageCostPerApt = comparableCost(totals.costPerApt);

  if (!metric.campaign?.vacancyId) {
    return { label: 'Asociar vacante', detail: 'Lórren necesita saber a qué vacante pertenece este anuncio.', cls: 'bad' };
  }
  if (spend > 0 && candidates === 0) {
    return { label: 'Revisar ahora', detail: 'Hay inversión, pero todavía no hay candidatos relacionados con el anuncio.', cls: 'bad' };
  }
  if (candidates < 5) {
    return { label: 'Esperar más datos', detail: 'Aún no hay suficiente información para recomendar cambios.', cls: 'muted' };
  }
  if (completedRegistrations / candidates < 0.4) {
    return { label: 'Revisar el registro', detail: 'Muchas personas llegan, pero no terminan de entregar la información.', cls: 'warn' };
  }
  if (cvReceived / candidates < 0.45) {
    return { label: 'Facilitar la hoja de vida', detail: 'Pocas personas que llegan terminan enviando su hoja de vida.', cls: 'warn' };
  }
  if (cvReceived >= 5 && apt / cvReceived < 0.3) {
    return { label: 'Aclarar requisitos', detail: 'Llegan hojas de vida, pero pocos candidatos cumplen los requisitos.', cls: 'warn' };
  }
  if (apt >= 3 && scheduled / apt < 0.5) {
    return { label: 'Revisar las citas', detail: 'Hay candidatos que cumplen, pero pocos alcanzan a agendar entrevista.', cls: 'warn' };
  }
  if (scheduled >= 3 && attended / scheduled < 0.5) {
    return { label: 'Mejorar asistencia', detail: 'Se agendan entrevistas, pero menos de la mitad de las personas asiste.', cls: 'warn' };
  }
  if (hired > 0 && costPerHired !== null && averageCostPerHired !== null && costPerHired <= averageCostPerHired) {
    return { label: 'Buen resultado', detail: 'Consigue contrataciones con un costo menor o igual al promedio del periodo.', cls: 'good' };
  }
  if (apt >= 3 && costPerApt !== null && averageCostPerApt !== null && costPerApt <= averageCostPerApt) {
    return { label: 'Buen costo por candidato', detail: 'Consigue personas que cumplen a un costo menor o igual al promedio del periodo.', cls: 'good' };
  }
  return { label: 'Seguir observando', detail: 'El anuncio tiene actividad, pero todavía no muestra una ventaja clara.', cls: 'info' };
}

function metaStatusBadge(campaign = {}) {
  const status = campaignMetaStatus(campaign);
  const map = {
    ACTIVE: ['Activo', 'good'],
    PAUSED: ['Pausado', 'warn'],
    CAMPAIGN_PAUSED: ['Campaña pausada', 'warn'],
    ADSET_PAUSED: ['Conjunto pausado', 'warn'],
    PENDING_REVIEW: ['En revisión', 'info'],
    DISAPPROVED: ['Rechazado por Meta', 'bad'],
    WITH_ISSUES: ['Con problemas', 'bad']
  };
  const [label, cls] = map[status] || [status || 'Desconocido', 'muted'];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function styles() {
  return `<style>
  *{box-sizing:border-box}body{margin:0;background:#f1f5f9;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px}.nav{height:54px;background:#1d2d3d;display:flex;align-items:center;gap:8px;padding:0 22px;overflow-x:auto}.nav a{color:#cbd5e1;text-decoration:none;font-weight:700;font-size:13px;white-space:nowrap;padding:7px 9px;border-radius:7px}.nav a:hover,.nav a.active{background:rgba(255,255,255,.1);color:#fff}.spacer{flex:1}.page{max-width:1450px;margin:0 auto;padding:24px 18px 60px}.header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px;flex-wrap:wrap}.header h1{font-size:23px;margin:0;color:#1d2d3d}.header p{margin:4px 0 0;color:#64748b;font-size:13px}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;padding:9px 13px;font-weight:800;font-size:13px;text-decoration:none;cursor:pointer}.btn.primary{background:#0d7a6b;color:#fff}.btn.secondary{background:#fff;color:#475569;border:1px solid #cbd5e1}.btn.small{padding:6px 9px;font-size:12px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:11px;padding:18px;margin-bottom:15px}.card-title{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#475569;font-weight:900;margin-bottom:12px}.alert{border-radius:9px;padding:11px 13px;margin-bottom:14px;font-size:13px;font-weight:650}.alert.info{background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8}.alert.warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e}.alert.good{background:#ecfdf5;border:1px solid #a7f3d0;color:#047857}.alert.bad{background:#fff1f2;border:1px solid #fecdd3;color:#be123c}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px}.kpi{background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:13px}.kpi strong{display:block;font-size:24px;line-height:1.1;color:#1d2d3d}.kpi span{display:block;color:#64748b;font-size:11px;margin-top:4px}.kpi em{display:block;color:#0d7a6b;font-size:11px;font-style:normal;font-weight:800;margin-top:3px}.kpi.purple{background:#f5f3ff;border-color:#ddd6fe}.kpi.purple strong{color:#6d28d9}.kpi.green{background:#ecfdf5;border-color:#a7f3d0}.kpi.green strong{color:#047857}.kpi.orange{background:#fffbeb;border-color:#fde68a}.kpi.orange strong{color:#b45309}.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;align-items:end}label{display:flex;flex-direction:column;gap:5px;color:#475569;font-size:12px;font-weight:800}input,select{min-height:39px;width:100%;border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;color:#172033}.table-wrap{overflow:auto;border:1px solid #e2e8f0;border-radius:9px}table{width:100%;border-collapse:collapse;min-width:1120px}th{background:#f8fafc;color:#64748b;text-align:left;text-transform:uppercase;letter-spacing:.04em;font-size:10px;padding:9px;border-bottom:2px solid #e2e8f0;white-space:nowrap}td{padding:10px 9px;border-bottom:1px solid #eef2f7;vertical-align:top;font-size:12px}tr:last-child td{border-bottom:0}tr:hover td{background:#fafcfe}.name{font-weight:850;color:#1d2d3d}.muted-text{color:#64748b;font-size:11px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.badge{display:inline-flex;padding:3px 8px;border-radius:999px;font-size:10px;font-weight:900;white-space:nowrap}.badge.good{background:#dcfce7;color:#15803d}.badge.warn{background:#fef3c7;color:#92400e}.badge.info{background:#dbeafe;color:#1d4ed8}.badge.bad{background:#fee2e2;color:#b91c1c}.badge.muted{background:#e2e8f0;color:#475569}.funnel{display:flex;gap:6px;overflow:auto}.step{min-width:135px;flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:11px;text-align:center}.step strong{display:block;font-size:21px}.step span{font-size:10px;color:#64748b}.step em{display:block;font-style:normal;font-size:10px;color:#0d7a6b;font-weight:800}.association{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end}.candidate-stage{max-width:230px}.cost-note{font-size:10px;color:#7c3aed;font-weight:750}.empty{text-align:center;padding:28px;color:#64748b}@media(max-width:760px){.nav{padding:0 9px}.page{padding:15px 9px 45px}.header h1{font-size:20px}.actions,.actions form{width:100%}.actions .btn{flex:1}.association{grid-template-columns:1fr}.association .btn{width:100%}.kpi strong{font-size:21px}}
  .section-help{color:#64748b;font-size:12px;line-height:1.5;margin:-5px 0 14px}.kpi.primary{background:#ecfdf5;border-color:#6ee7b7}.kpi.primary strong{color:#047857}.kpi.red{background:#fff1f2;border-color:#fecdd3}.kpi.red strong{color:#be123c}.funnel{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;overflow:visible}.step{min-width:0;text-align:left;position:relative}.step strong{font-size:24px}.step span{display:block;font-size:11px;font-weight:800;margin-top:4px}.step em{font-size:11px;margin-top:5px}.step small{display:block;color:#64748b;font-size:10px;margin-top:3px}.insight-list{display:grid;gap:10px}.insight{border:1px solid #e2e8f0;border-left:5px solid #94a3b8;border-radius:9px;padding:12px 14px;background:#f8fafc}.insight.good{border-left-color:#10b981;background:#ecfdf5}.insight.warn{border-left-color:#f59e0b;background:#fffbeb}.insight.bad{border-left-color:#e11d48;background:#fff1f2}.insight.info{border-left-color:#3b82f6;background:#eff6ff}.insight strong{display:block;color:#1d2d3d;margin-bottom:3px}.insight span{color:#475569;font-size:12px;line-height:1.5}.decision{max-width:270px}.decision .badge{margin-bottom:5px}.technical{margin-top:6px;color:#64748b;font-size:10px}.technical summary{cursor:pointer;font-weight:800;color:#475569}.technical div{padding-top:5px;line-height:1.5}.metric-pair{display:grid;gap:3px}.metric-pair strong{font-size:13px}.metric-pair span{font-size:11px;color:#64748b}.cost-stack{display:grid;gap:5px}.cost-stack b{color:#1d2d3d}.cost-stack span{color:#64748b;font-size:10px}.plain-note{background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:11px 13px;color:#475569;font-size:12px;line-height:1.5;margin-bottom:12px}table.results{min-width:1480px}@media(max-width:760px){.funnel{grid-template-columns:repeat(2,minmax(0,1fr))}.decision{max-width:none}}
  </style>`;
}

function layout(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="icon" type="image/svg+xml" href="/public/favicon-loginpro.svg?v=meta-stats">${styles()}</head><body><nav class="nav"><a href="/admin">Panel</a><a href="${BASE_PATH}">Estadísticas</a><a href="${BASE_PATH}/campaigns" class="active">Anuncios</a><span class="spacer"></span><a href="/logout">Cerrar sesión</a></nav><main class="page">${body}</main></body></html>`;
}

export function currentMetaAdsCampaignWhere({ city = null, vacancyId = null } = {}) {
  const where = {
    sourceType: 'META_ADS',
    createdByUsername: 'meta-ads-sync',
    endsAt: null
  };
  if (city) where.city = { contains: city, mode: 'insensitive' };
  if (vacancyId) where.vacancyId = vacancyId;
  return where;
}

async function loadDashboard(prisma, query = {}) {
  const range = dateRange(query);
  const city = normalizeText(query.city);
  const vacancyId = normalizeText(query.vacancyId);
  const campaignWhere = currentMetaAdsCampaignWhere({ city, vacancyId });

  const [campaigns, candidates, cities, vacancies, account, lastSnapshot] = await Promise.all([
    prisma.campaign.findMany({
      where: campaignWhere,
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
      include: { vacancy: true }
    }),
    prisma.candidate.findMany({
      where: { sourceType: 'META_ADS', createdAt: range.bounds },
      select: {
        id: true, phone: true, fullName: true, documentType: true, documentNumber: true,
        age: true, neighborhood: true, locality: true, medicalRestrictions: true,
        transportMode: true, experienceInfo: true, experienceTime: true,
        experienceSummary: true, dataConsentStatus: true, status: true, currentStep: true,
        vacancyId: true, campaignId: true, metaAdId: true, metaCampaignId: true,
        cvStorageKey: true, cvData: true, cvOriginalName: true, cvMimeType: true,
        createdAt: true, vacancy: true,
        interviewBookings: { select: { status: true } }
      }
    }),
    prisma.city.findMany({ where: { usedForRecruitment: true }, orderBy: { name: 'asc' }, select: { name: true } }),
    prisma.vacancy.findMany({ orderBy: [{ city: 'asc' }, { title: 'asc' }], select: { id: true, title: true, city: true, isActive: true } }),
    prisma.metaAdAccount.findFirst({ where: { isActive: true }, orderBy: { updatedAt: 'desc' } }),
    prisma.metaAdSnapshot.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } })
  ]);

  const snapshots = campaigns.length
    ? await prisma.metaAdSnapshot.findMany({
      where: { date: range.bounds, metaAdId: { in: campaigns.map((campaign) => campaign.code) } },
      orderBy: { date: 'asc' }
    })
    : [];
  const metrics = buildMetaAdStatistics({
    campaigns,
    candidates,
    snapshots,
    timeZone: account?.timezoneName || 'America/Bogota'
  }).sort((a, b) => b.spend - a.spend || b.candidatesCount - a.candidatesCount);

  return {
    range, city, vacancyId, metrics,
    totals: aggregateMetaAdStatistics(metrics),
    cities, vacancies, account,
    lastSyncedAt: lastSnapshot?.updatedAt || account?.updatedAt || null
  };
}

function syncFeedback(query = {}) {
  const state = normalizeText(query.sync);
  if (state === 'success') {
    return `<div class="alert good">Sincronización completada. Anuncios actuales: ${formatInteger(query.currentAds)}. Registros anteriores finalizados: ${formatInteger(query.missingAds)}.</div>`;
  }
  if (state === 'partial') {
    return `<div class="alert warn">El inventario actual se actualizó correctamente, pero Meta no entregó las métricas históricas. Los anuncios visibles sí quedaron conciliados.</div>`;
  }
  if (state === 'error') {
    const stage = normalizeText(query.stage) || 'unknown';
    const code = normalizeText(query.code);
    const subcode = normalizeText(query.subcode);
    const endpoint = normalizeText(query.endpoint);
    const message = normalizeText(query.message);
    const details = [
      code ? `Código: ${escapeHtml(code)}` : null,
      subcode ? `Subcódigo: ${escapeHtml(subcode)}` : null,
      endpoint ? `Consulta: ${escapeHtml(endpoint)}` : null,
      `Etapa: ${escapeHtml(stage)}`
    ].filter(Boolean).join(' · ');
    return `<div class="alert bad">No fue posible consultar un inventario válido de Meta Ads. Se conservó el último inventario para evitar borrar información por un fallo de acceso.${message ? ` Motivo: ${escapeHtml(message)}.` : ''} ${details}.</div>`;
  }
  return '';
}

function syncPanel(data = {}) {
  const configured = metaConfigured();
  const status = configured
    ? `<div class="alert good">Meta Ads está conectado. Lórren combina la inversión de los anuncios con lo que sucede durante el proceso de reclutamiento.</div>`
    : `<div class="alert warn">La conexión con Meta Ads no está completa. Un administrador técnico debe configurar la cuenta y su acceso antes de actualizar los resultados.</div>`;
  const form = configured
    ? `<form method="post" action="${BASE_PATH}/campaigns/sync" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Actualizando…'"><input type="hidden" name="since" value="${escapeHtml(data.range.since)}"><input type="hidden" name="until" value="${escapeHtml(data.range.until)}"><button class="btn primary" type="submit">↻ Actualizar desde Meta</button></form>`
    : '';
  return `${status}<section class="card"><div class="header" style="margin:0"><div><div class="card-title" style="margin-bottom:4px">Actualización de datos</div><div class="muted-text">Cuenta: ${escapeHtml(data.account?.name || data.account?.accountId || 'No identificada')} · Moneda: ${escapeHtml(data.account?.currency || 'COP')}</div><div class="muted-text">Última actualización: ${escapeHtml(formatDateTime(data.lastSyncedAt, data.account?.timezoneName))}</div>${configured ? '' : '<div class="muted-text">Configuración requerida: META_ADS_ACCESS_TOKEN y META_AD_ACCOUNT_ID.</div>'}</div><div class="actions">${form}</div></div></section>`;
}

function filters(data = {}) {
  const cityOptions = data.cities.map((item) => `<option value="${escapeHtml(item.name)}" ${data.city === item.name ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
  const vacancyOptions = data.vacancies.map((item) => `<option value="${escapeHtml(item.id)}" ${data.vacancyId === item.id ? 'selected' : ''}>${escapeHtml(item.title)} — ${escapeHtml(item.city)}${item.isActive ? '' : ' (inactiva)'}</option>`).join('');
  return `<section class="card"><div class="card-title">Filtros</div><form class="filters" method="get" action="${BASE_PATH}/campaigns"><label>Desde<input type="date" name="from" value="${escapeHtml(data.range.since)}"></label><label>Hasta<input type="date" name="to" value="${escapeHtml(data.range.until)}"></label><label>Ciudad<select name="city"><option value="">Todas</option>${cityOptions}</select></label><label>Vacante<select name="vacancyId"><option value="">Todas</option>${vacancyOptions}</select></label><button class="btn secondary" type="submit">Aplicar filtros</button></form></section>`;
}

function topMetrics(data = {}) {
  const total = data.totals;
  const currency = data.account?.currency;
  return `<section class="card"><div class="card-title">¿Qué produjo la inversión?</div><p class="section-help">Estas cifras unen el dinero invertido en Meta con los resultados registrados dentro de Lórren.</p><div class="grid"><div class="kpi purple"><strong>${formatMoney(total.spend, currency)}</strong><span>Dinero invertido</span><em>Importado directamente desde Meta</em></div><div class="kpi"><strong>${formatInteger(total.candidatesCount)}</strong><span>Personas que llegaron por anuncios</span><em>${formatMoney(total.costPerCandidate, currency)} por persona</em></div><div class="kpi"><strong>${formatInteger(total.completedRegistrations)}</strong><span>Terminaron el registro</span><em>${rate(total.completedRegistrations,total.candidatesCount)} de quienes llegaron · ${formatMoney(total.costPerCompletedRegistration,currency)} c/u</em></div><div class="kpi"><strong>${formatInteger(total.cvReceived)}</strong><span>Enviaron hoja de vida</span><em>${rate(total.cvReceived,total.candidatesCount)} de quienes llegaron · ${formatMoney(total.costPerCv,currency)} c/u</em></div><div class="kpi primary"><strong>${formatInteger(total.apt)}</strong><span>Cumplen los requisitos</span><em>${rate(total.apt,total.candidatesCount)} de quienes llegaron · ${formatMoney(total.costPerApt,currency)} c/u</em></div><div class="kpi"><strong>${formatInteger(total.attended)}</strong><span>Asistieron a entrevista</span><em>${rate(total.attended,total.scheduled)} de los agendados · ${formatMoney(total.costPerAttended,currency)} c/u</em></div><div class="kpi primary"><strong>${formatInteger(total.hired)}</strong><span>Fueron contratados</span><em>${rate(total.hired,total.candidatesCount)} de quienes llegaron · ${formatMoney(total.costPerHired,currency)} c/u</em></div><div class="kpi orange"><strong>${formatMoney(total.estimatedIncompleteSpend,currency)}</strong><span>Inversión en registros incompletos</span><em>Valor aproximado, no un cobro individual exacto</em></div></div></section>`;
}

function funnel(total = {}, currency = 'COP') {
  const candidateBase = total.candidatesCount;
  const steps = [
    ['Conversaciones iniciadas', total.metaConversationsStarted, total.costPerMetaConversation, 'Dato entregado por Meta'],
    ['Llegaron a Lórren', total.candidatesCount, total.costPerCandidate, `${rate(total.candidatesCount, total.metaConversationsStarted)} de las conversaciones`],
    ['Iniciaron el registro', total.startedProcess, total.costPerStartedProcess, `${rate(total.startedProcess, candidateBase)} de quienes llegaron`],
    ['Enviaron hoja de vida', total.cvReceived, total.costPerCv, `${rate(total.cvReceived, candidateBase)} de quienes llegaron`],
    ['Terminaron el registro', total.completedRegistrations, total.costPerCompletedRegistration, `${rate(total.completedRegistrations, candidateBase)} de quienes llegaron`],
    ['Cumplen requisitos', total.apt, total.costPerApt, `${rate(total.apt, candidateBase)} de quienes llegaron`],
    ['Agendaron entrevista', total.scheduled, total.costPerScheduled, `${rate(total.scheduled, candidateBase)} de quienes llegaron`],
    ['Confirmaron asistencia', total.confirmed, total.costPerConfirmed, `${rate(total.confirmed, total.scheduled)} de los agendados`],
    ['Asistieron', total.attended, total.costPerAttended, `${rate(total.attended, total.scheduled)} de los agendados`],
    ['Fueron contratados', total.hired, total.costPerHired, `${rate(total.hired, candidateBase)} de quienes llegaron`]
  ];
  return `<section class="card"><div class="card-title">¿Hasta dónde avanzaron las personas?</div><p class="section-help">El costo aumenta cuando menos personas alcanzan una etapa. Los porcentajes ayudan a encontrar dónde se está frenando el proceso.</p><div class="funnel">${steps.map(([label,value,cost,stepRate])=>`<div class="step"><strong>${formatInteger(value)}</strong><span>${escapeHtml(label)}</span><em>${escapeHtml(stepRate)}</em><small>${formatMoney(cost,currency)} por resultado</small></div>`).join('')}</div></section>`;
}

export function insightItems(data = {}) {
  const total = data.totals || {};
  const currency = data.account?.currency;
  const items = [];
  const spend = nonNegativeNumber(total.spend);
  const candidates = nonNegativeNumber(total.candidatesCount);
  const incompleteRegistrations = nonNegativeNumber(total.incompleteRegistrations);
  const cvReceived = nonNegativeNumber(total.cvReceived);
  const apt = nonNegativeNumber(total.apt);
  const scheduled = nonNegativeNumber(total.scheduled);
  const attended = nonNegativeNumber(total.attended);
  const noShow = nonNegativeNumber(total.noShow);
  const hired = nonNegativeNumber(total.hired);
  const unattributedSpend = nonNegativeNumber(total.unattributedSpend);

  if (spend > 0 && candidates === 0) {
    items.push({ cls: 'bad', title: 'Hay inversión, pero no hay candidatos relacionados', text: 'Revisa cómo se están relacionando los anuncios y confirma que los mensajes de WhatsApp estén llegando correctamente a Lórren.' });
  }
  if (candidates >= 5 && incompleteRegistrations / candidates >= 0.4) {
    items.push({ cls: 'warn', title: `${formatInteger(incompleteRegistrations)} personas no terminaron el registro`, text: `Representan ${rate(incompleteRegistrations,candidates)} de quienes llegaron. La inversión aproximada relacionada con estos casos es ${formatMoney(total.estimatedIncompleteSpend,currency)}.` });
  }
  if (candidates >= 5 && cvReceived / candidates < 0.45) {
    items.push({ cls: 'warn', title: 'Pocas personas están enviando su hoja de vida', text: 'Conviene revisar si la solicitud del archivo es clara y si el candidato entiende cómo enviarlo.' });
  }
  if (cvReceived >= 5 && apt / cvReceived < 0.3) {
    items.push({ cls: 'warn', title: 'Muchas hojas de vida no terminan en candidatos que cumplen', text: 'El anuncio puede estar atrayendo perfiles diferentes a los requisitos reales de la vacante.' });
  }
  if (apt >= 3 && scheduled / apt < 0.5) {
    items.push({ cls: 'warn', title: 'Hay candidatos que cumplen, pero pocos agendan', text: 'Revisa la disponibilidad de horarios, la dirección y el tiempo que tarda el sistema en ofrecer una cita.' });
  }
  if (scheduled >= 3 && attended / scheduled < 0.5) {
    items.push({ cls: 'warn', title: 'La asistencia a entrevistas es baja', text: `${formatInteger(noShow)} candidato(s) aparecen con inasistencia registrada. Revisa recordatorios, ubicación y horarios.` });
  }
  if (hired > 0) {
    items.push({ cls: 'good', title: `${formatInteger(hired)} contratación(es) relacionadas con anuncios`, text: `El costo actual por contratación es ${formatMoney(total.costPerHired,currency)}.` });
  }
  if (unattributedSpend > spend * 0.25) {
    items.push({ cls: 'info', title: 'Parte de la inversión no pudo relacionarse con personas', text: `${formatMoney(unattributedSpend,currency)} no se pudo distribuir por anuncio y día. Esta cifra es una estimación y sirve para revisar la calidad de esa relación.` });
  }
  if (!items.length) {
    items.push({ cls: 'info', title: 'Aún no hay una pérdida dominante', text: 'Continúa acumulando resultados. Lórren mostrará una alerta cuando encuentre un punto del proceso que necesite atención.' });
  }
  return items.slice(0, 5);
}

function insightsPanel(data = {}) {
  const items = insightItems(data);
  return `<section class="card"><div class="card-title">¿Qué necesita atención?</div><p class="section-help">Estas explicaciones se generan con reglas visibles sobre los resultados del periodo; no cambian campañas ni presupuestos automáticamente.</p><div class="insight-list">${items.map((item)=>`<div class="insight ${item.cls}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.text)}</span></div>`).join('')}</div></section>`;
}

function adsTable(data = {}) {
  if (!data.metrics.length) return `<section class="card"><div class="card-title">Anuncios actuales</div><div class="empty">Actualmente no existen anuncios en Meta Ads. Cuando se cree uno nuevo y se sincronice, aparecerá aquí automáticamente.</div></section>`;
  const rows = data.metrics.map((metric) => {
    const campaign = metric.campaign;
    const vacancy = campaign.vacancy;
    const confidence = confidenceFor(metric);
    const recommendation = recommendationFor(metric, data.totals);
    return `<tr><td><div class="name">${escapeHtml(metric.metaAdName || campaign.name)}</div><div class="muted-text">${escapeHtml(metric.metaCampaignName || 'Campaña Meta sin nombre')}</div><details class="technical"><summary>Ver datos publicitarios</summary><div>${metaStatusBadge(campaign)}<br>Impresiones: ${formatInteger(metric.impressions)} · Alcance: ${formatInteger(metric.reach)}<br>Clics: ${formatInteger(metric.inlineLinkClicks || metric.clicks)} · Costo por clic: ${formatMoney(metric.costPerLinkClick,data.account?.currency)}<br><span class="mono">ad_id: ${escapeHtml(metric.metaAdId)}</span></div></details></td><td>${vacancy?`<div class="name">${escapeHtml(vacancy.title)}</div><div class="muted-text">${escapeHtml(campaign.city || vacancy.city)}</div>`:`<span class="badge bad">Sin vacante asociada</span>`}</td><td><div class="name">${formatMoney(metric.spend,data.account?.currency)}</div><div class="muted-text">Inversión del periodo</div></td><td><div class="metric-pair"><strong>${formatInteger(metric.candidatesCount)} personas</strong><span>${formatMoney(metric.costPerCandidate,data.account?.currency)} por persona</span><span class="badge ${confidence.cls}">${escapeHtml(confidence.label)}</span></div></td><td><div class="metric-pair"><strong>${formatInteger(metric.completedRegistrations)} terminaron</strong><span>${formatInteger(metric.cvReceived)} enviaron hoja de vida</span><span>${formatInteger(metric.incompleteRegistrations)} no terminaron</span></div></td><td><div class="metric-pair"><strong>${formatInteger(metric.apt)} cumplen</strong><span>${rate(metric.apt,metric.candidatesCount)} de quienes llegaron</span></div></td><td><div class="metric-pair"><strong>${formatInteger(metric.scheduled)} agendaron</strong><span>${formatInteger(metric.attended)} asistieron</span><span>${formatInteger(metric.noShow)} no asistieron</span></div></td><td><div class="metric-pair"><strong>${formatInteger(metric.hired)} contratados</strong><span>${rate(metric.hired,metric.candidatesCount)} de quienes llegaron</span></div></td><td><div class="cost-stack"><span>Por persona que cumple <b>${formatMoney(metric.costPerApt,data.account?.currency)}</b></span><span>Por asistente <b>${formatMoney(metric.costPerAttended,data.account?.currency)}</b></span><span>Por contratación <b>${formatMoney(metric.costPerHired,data.account?.currency)}</b></span></div></td><td class="decision"><span class="badge ${recommendation.cls}">${escapeHtml(recommendation.label)}</span><div class="muted-text">${escapeHtml(recommendation.detail)}</div></td><td><a class="btn secondary small" href="${BASE_PATH}/campaigns/${encodeURIComponent(campaign.id)}?from=${encodeURIComponent(data.range.since)}&to=${encodeURIComponent(data.range.until)}">Ver detalle</a></td></tr>`;
  }).join('');
  return `<section class="card"><div class="card-title">¿Qué anuncios están dando mejores resultados? (${data.metrics.length})</div><p class="section-help">La lectura se basa en resultados del reclutamiento. Un anuncio con pocos datos nunca se marca como ganador ni se recomienda suspender automáticamente.</p><div class="plain-note"><strong>Cómo leer los costos:</strong> la inversión total viene de Meta. Los costos por etapa se calculan dividiendo esa inversión entre las personas que alcanzaron cada resultado. El costo estimado por persona y la inversión en registros incompletos son aproximaciones.</div><div class="table-wrap"><table class="results"><thead><tr><th>Anuncio</th><th>Vacante</th><th>Invertido</th><th>Personas</th><th>Registro</th><th>Cumplen</th><th>Entrevistas</th><th>Contrataciones</th><th>Costos importantes</th><th>Qué conviene hacer</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

async function renderList(prisma, req, res) {
  if (!canAccess(req)) return res.status(403).send('No autorizado.');
  const data = await loadDashboard(prisma, req.query || {});
  const missingVacancies = missingVacancyCount(data.metrics);
  const warning = missingVacancies
    ? `<div class="alert warn">Hay ${missingVacancies} anuncio(s) sin una vacante asociada. Relaciónalos para que Lórren pueda identificar correctamente a qué proceso pertenece cada candidato.</div>`
    : '';
  const body = `<div class="header"><div><h1>Resultados de reclutamiento de Meta Ads</h1><p>Descubre cuánto cuesta conseguir candidatos que cumplen, asisten y son contratados, y dónde se está perdiendo la inversión.</p></div><div class="actions"><a class="btn secondary" href="${BASE_PATH}">← Centro de estadísticas</a></div></div>${syncFeedback(req.query)}${warning}${syncPanel(data)}${filters(data)}${topMetrics(data)}${funnel(data.totals,data.account?.currency)}${insightsPanel(data)}${adsTable(data)}`;
  return res.send(layout('Resultados de Meta Ads — Estadísticas', body));
}

function candidateRows(metric, currency) {
  if (!metric.candidates.length) return `<div class="empty">Este anuncio no tiene candidatos relacionados durante el periodo seleccionado.</div>`;
  const rows = metric.candidates
    .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))
    .map((candidate)=>`<tr><td><a class="name" style="color:#0d7a6b;text-decoration:none" href="/admin/candidates/${escapeHtml(candidate.id)}">${escapeHtml(candidate.fullName || 'Sin nombre')}</a><div class="muted-text">${escapeHtml(candidate.phone || '')}</div></td><td><span class="badge ${candidate.registrationState.complete?'good':'warn'}">${candidate.registrationState.complete?'Terminó':'No terminó'}</span></td><td class="candidate-stage">${escapeHtml(candidate.registrationState.stage)}</td><td>${candidate.registrationState.hasCv?'Recibida':'Pendiente'}</td><td>${escapeHtml(candidate.status || 'NUEVO')}</td><td><div class="name">${formatMoney(candidate.estimatedCost,currency)}</div><div class="cost-note">Costo aproximado por persona</div></td><td>${escapeHtml(new Intl.DateTimeFormat('es-CO',{dateStyle:'medium'}).format(new Date(candidate.createdAt)))}</td></tr>`).join('');
  return `<div class="plain-note">El costo por persona es una aproximación: se divide la inversión diaria del anuncio entre las personas relacionadas ese día. No representa un cobro exacto por cada candidato.</div><div class="table-wrap"><table><thead><tr><th>Candidato</th><th>Registro</th><th>Qué falta</th><th>Hoja de vida</th><th>Estado del proceso</th><th>Costo aproximado</th><th>Fecha de llegada</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function renderDetail(prisma, req, res) {
  if (!canAccess(req)) return res.status(403).send('No autorizado.');
  const detailQuery = { ...req.query, city: null, vacancyId: null };
  const data = await loadDashboard(prisma, detailQuery);
  const metric = data.metrics.find((item) => item.campaign.id === req.params.id);
  if (!metric) return res.status(404).send(layout('Anuncio no encontrado', '<div class="alert bad">El anuncio ya no existe en el inventario actual de Meta Ads.</div>'));
  const campaign = metric.campaign;
  const cityOptions = data.cities.map((item)=>`<option value="${escapeHtml(item.name)}" ${campaign.city===item.name?'selected':''}>${escapeHtml(item.name)}</option>`).join('');
  const vacancyOptions = data.vacancies.map((item)=>`<option value="${escapeHtml(item.id)}" ${campaign.vacancyId===item.id?'selected':''}>${escapeHtml(item.title)} — ${escapeHtml(item.city)}${item.isActive?'':' (inactiva)'}</option>`).join('');
  const detailData = { ...data, totals: metric, metrics: [metric] };
  const recommendation = recommendationFor(metric, data.totals);
  const body = `<div class="header"><div><a class="btn secondary small" href="${BASE_PATH}/campaigns?from=${encodeURIComponent(data.range.since)}&to=${encodeURIComponent(data.range.until)}">← Volver</a><h1 style="margin-top:10px">${escapeHtml(metric.metaAdName || campaign.name)}</h1><p>${escapeHtml(metric.metaCampaignName || 'Campaña Meta')} · <span class="mono">ad_id ${escapeHtml(metric.metaAdId)}</span></p></div><div>${metaStatusBadge(campaign)}</div></div><div class="alert ${recommendation.cls === 'bad' ? 'bad' : recommendation.cls === 'warn' ? 'warn' : recommendation.cls === 'good' ? 'good' : 'info'}"><strong>${escapeHtml(recommendation.label)}:</strong> ${escapeHtml(recommendation.detail)}</div><section class="card"><div class="card-title">¿A qué vacante pertenece?</div><div class="plain-note">Esta relación no modifica el anuncio en Meta. Le indica a Lórren qué vacante debe usar cuando una persona llega desde este anuncio.</div><form class="association" method="post" action="${BASE_PATH}/campaigns/${escapeHtml(campaign.id)}/edit"><label>Ciudad<select name="city"><option value="">Sin ciudad</option>${cityOptions}</select></label><label>Vacante<select name="vacancyId"><option value="">Sin vacante</option>${vacancyOptions}</select></label><button class="btn primary" type="submit">Guardar asociación</button></form></section>${topMetrics(detailData)}${funnel(metric,data.account?.currency)}${insightsPanel(detailData)}<section class="card"><div class="card-title">Personas que llegaron por este anuncio (${metric.candidatesCount})</div>${candidateRows(metric,data.account?.currency||'COP')}</section>`;
  return res.send(layout(`Anuncio: ${metric.metaAdName || campaign.name}`, body));
}

async function saveClassification(prisma, req, res) {
  if (!canAccess(req)) return res.status(403).send('No autorizado.');
  const requestedVacancyId = normalizeText(req.body?.vacancyId);
  const requestedCity = normalizeText(req.body?.city);
  const campaign = await prisma.campaign.findFirst({
    where: { id: req.params.id, ...currentMetaAdsCampaignWhere() },
    select: { id: true, code: true }
  });
  if (!campaign) return res.status(404).send('El anuncio ya no existe en el inventario actual de Meta Ads.');

  let vacancy = null;
  if (requestedVacancyId) {
    vacancy = await prisma.vacancy.findUnique({ where: { id: requestedVacancyId }, select: { id: true, city: true } });
    if (!vacancy) return res.status(400).send('La vacante seleccionada no existe.');
  }
  const city = vacancy?.city || requestedCity || null;
  const operations = [
    prisma.campaign.update({ where: { id: campaign.id }, data: { vacancyId: vacancy?.id || null, city } }),
    prisma.candidate.updateMany({
      where: { sourceType: 'META_ADS', metaAdId: campaign.code, campaignId: null },
      data: { campaignId: campaign.id }
    })
  ];
  if (vacancy?.id) {
    operations.push(prisma.candidate.updateMany({
      where: { sourceType: 'META_ADS', metaAdId: campaign.code, vacancyId: null },
      data: { vacancyId: vacancy.id }
    }));
  }
  await prisma.$transaction(operations);
  return res.redirect(`${BASE_PATH}/campaigns/${encodeURIComponent(campaign.id)}?success=1`);
}

async function jsonList(prisma, req, res) {
  if (!canAccess(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const data = await loadDashboard(prisma, req.query || {});
  return res.json({
    ok: true,
    range: { since: data.range.since, until: data.range.until },
    lastSyncedAt: data.lastSyncedAt,
    currency: data.account?.currency || 'COP',
    totals: data.totals,
    ads: data.metrics.map((metric)=>({
      id: metric.campaign.id,
      metaAdId: metric.metaAdId,
      metaAdName: metric.metaAdName,
      metaCampaignId: metric.metaCampaignId,
      metaCampaignName: metric.metaCampaignName,
      vacancy: metric.campaign.vacancy ? { id: metric.campaign.vacancy.id, title: metric.campaign.vacancy.title, city: metric.campaign.vacancy.city } : null,
      metaStatus: campaignMetaStatus(metric.campaign),
      spend: metric.spend,
      candidates: metric.candidatesCount,
      complete: metric.completedRegistrations,
      incomplete: metric.incompleteRegistrations,
      costPerCandidate: metric.costPerCandidate,
      costPerComplete: metric.costPerCompletedRegistration,
      costPerIncomplete: metric.costPerIncompleteRegistration,
      cvReceived: metric.cvReceived,
      apt: metric.apt,
      scheduled: metric.scheduled,
      confirmed: metric.confirmed,
      attended: metric.attended,
      noShow: metric.noShow,
      hired: metric.hired,
      costPerApt: metric.costPerApt,
      costPerScheduled: metric.costPerScheduled,
      costPerAttended: metric.costPerAttended,
      costPerHired: metric.costPerHired,
      confidence: confidenceFor(metric).label,
      recommendation: recommendationFor(metric, data.totals).label
    }))
  });
}

function publicErrorText(value, maxLength = 300) {
  return String(value || '')
    .replace(/([?&])access_token=[^&\s]+/gi, '$1access_token=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function syncRedirect(result = {}) {
  const params = new URLSearchParams();
  if (result.ok) {
    params.set('sync', result.partial ? 'partial' : 'success');
    params.set('currentAds', String(result.currentAds || 0));
    params.set('missingAds', String(result.missingAds || 0));
  } else {
    params.set('sync', 'error');
    params.set('stage', result.stage || 'unknown');
    if (result.error?.code) params.set('code', String(result.error.code));
    if (result.error?.subcode) params.set('subcode', String(result.error.subcode));
    if (result.error?.endpoint) params.set('endpoint', publicErrorText(result.error.endpoint, 160));
    if (result.error?.message) params.set('message', publicErrorText(result.error.message));
  }
  return `${BASE_PATH}/campaigns?${params.toString()}`;
}

async function runSync(prisma, syncMetaAds, req, res) {
  if (!canAccess(req)) return res.status(403).send('No autorizado.');
  let result;
  try {
    result = await syncMetaAds(prisma, {
      since: normalizeDate(req.body?.since),
      until: normalizeDate(req.body?.until)
    });
  } catch (error) {
    console.error('[META_ADS_SYNC_UNEXPECTED_ERROR]', {
      name: error?.name,
      code: error?.code,
      message: publicErrorText(error?.message),
      stack: publicErrorText(error?.stack, 2000)
    });
    result = {
      ok: false,
      stage: 'unexpected',
      error: {
        code: error?.code || 'META_ADS_SYNC_UNEXPECTED',
        message: 'La sincronización produjo un error inesperado.'
      }
    };
  }
  return res.redirect(syncRedirect(result));
}

export function metaAdsStatsRouter(prisma, dependencies = {}) {
  const router = express.Router();
  const syncMetaAds = dependencies.syncMetaAds || syncMetaAdsInsights;

  router.get('/campaigns', (req, res) => renderList(prisma, req, res));
  router.get('/campaigns.json', (req, res) => jsonList(prisma, req, res));
  router.post('/campaigns/sync', (req, res) => runSync(prisma, syncMetaAds, req, res));
  router.post('/campaigns', (_req, res) => res.redirect(`${BASE_PATH}/campaigns`));
  router.get('/campaigns/:id', (req, res) => renderDetail(prisma, req, res));
  router.post('/campaigns/:id/edit', (req, res) => saveClassification(prisma, req, res));
  return router;
}

export default metaAdsStatsRouter;
