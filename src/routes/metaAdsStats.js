import express from 'express';
import {
  aggregateMetaAdStatistics,
  buildMetaAdStatistics,
  campaignMetaStatus,
  missingVacancyCount
} from '../services/metaRecruitmentStats.js';

const BASE_PATH = '/admin/estadisticas';
const DEFAULT_LOOKBACK_DAYS = 90;

function canAccess(req = {}) {
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
  const token = String(process.env.META_ADS_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || '').trim();
  const account = String(process.env.META_AD_ACCOUNT_ID || process.env.META_ADS_ACCOUNT_ID || '').trim();
  return Boolean(token && account);
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

function metaStatusBadge(campaign = {}) {
  const status = campaignMetaStatus(campaign);
  const map = {
    ACTIVE: ['Activo', 'good'],
    PAUSED: ['Pausado', 'warn'],
    CAMPAIGN_PAUSED: ['Campaña pausada', 'warn'],
    ADSET_PAUSED: ['Conjunto pausado', 'warn'],
    PENDING_REVIEW: ['En revisión', 'info'],
    DISAPPROVED: ['Rechazado por Meta', 'bad'],
    WITH_ISSUES: ['Con problemas', 'bad'],
    NO_DISPONIBLE: ['Histórico / no disponible', 'muted']
  };
  const [label, cls] = map[status] || [status || 'Desconocido', 'muted'];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function styles() {
  return `<style>
  *{box-sizing:border-box}body{margin:0;background:#f1f5f9;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px}.nav{height:54px;background:#1d2d3d;display:flex;align-items:center;gap:8px;padding:0 22px;overflow-x:auto}.nav a{color:#cbd5e1;text-decoration:none;font-weight:700;font-size:13px;white-space:nowrap;padding:7px 9px;border-radius:7px}.nav a:hover,.nav a.active{background:rgba(255,255,255,.1);color:#fff}.spacer{flex:1}.page{max-width:1450px;margin:0 auto;padding:24px 18px 60px}.header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px;flex-wrap:wrap}.header h1{font-size:23px;margin:0;color:#1d2d3d}.header p{margin:4px 0 0;color:#64748b;font-size:13px}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;padding:9px 13px;font-weight:800;font-size:13px;text-decoration:none;cursor:pointer}.btn.primary{background:#0d7a6b;color:#fff}.btn.secondary{background:#fff;color:#475569;border:1px solid #cbd5e1}.btn.small{padding:6px 9px;font-size:12px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:11px;padding:18px;margin-bottom:15px}.card-title{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#475569;font-weight:900;margin-bottom:12px}.alert{border-radius:9px;padding:11px 13px;margin-bottom:14px;font-size:13px;font-weight:650}.alert.info{background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8}.alert.warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e}.alert.good{background:#ecfdf5;border:1px solid #a7f3d0;color:#047857}.alert.bad{background:#fff1f2;border:1px solid #fecdd3;color:#be123c}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px}.kpi{background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:13px}.kpi strong{display:block;font-size:24px;line-height:1.1;color:#1d2d3d}.kpi span{display:block;color:#64748b;font-size:11px;margin-top:4px}.kpi em{display:block;color:#0d7a6b;font-size:11px;font-style:normal;font-weight:800;margin-top:3px}.kpi.purple{background:#f5f3ff;border-color:#ddd6fe}.kpi.purple strong{color:#6d28d9}.kpi.green{background:#ecfdf5;border-color:#a7f3d0}.kpi.green strong{color:#047857}.kpi.orange{background:#fffbeb;border-color:#fde68a}.kpi.orange strong{color:#b45309}.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;align-items:end}label{display:flex;flex-direction:column;gap:5px;color:#475569;font-size:12px;font-weight:800}input,select{min-height:39px;width:100%;border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;color:#172033}.table-wrap{overflow:auto;border:1px solid #e2e8f0;border-radius:9px}table{width:100%;border-collapse:collapse;min-width:1120px}th{background:#f8fafc;color:#64748b;text-align:left;text-transform:uppercase;letter-spacing:.04em;font-size:10px;padding:9px;border-bottom:2px solid #e2e8f0;white-space:nowrap}td{padding:10px 9px;border-bottom:1px solid #eef2f7;vertical-align:top;font-size:12px}tr:last-child td{border-bottom:0}tr:hover td{background:#fafcfe}.name{font-weight:850;color:#1d2d3d}.muted-text{color:#64748b;font-size:11px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.badge{display:inline-flex;padding:3px 8px;border-radius:999px;font-size:10px;font-weight:900;white-space:nowrap}.badge.good{background:#dcfce7;color:#15803d}.badge.warn{background:#fef3c7;color:#92400e}.badge.info{background:#dbeafe;color:#1d4ed8}.badge.bad{background:#fee2e2;color:#b91c1c}.badge.muted{background:#e2e8f0;color:#475569}.funnel{display:flex;gap:6px;overflow:auto}.step{min-width:135px;flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:11px;text-align:center}.step strong{display:block;font-size:21px}.step span{font-size:10px;color:#64748b}.step em{display:block;font-style:normal;font-size:10px;color:#0d7a6b;font-weight:800}.association{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end}.candidate-stage{max-width:230px}.cost-note{font-size:10px;color:#7c3aed;font-weight:750}.empty{text-align:center;padding:28px;color:#64748b}@media(max-width:760px){.nav{padding:0 9px}.page{padding:15px 9px 45px}.header h1{font-size:20px}.actions,.actions form{width:100%}.actions .btn{flex:1}.association{grid-template-columns:1fr}.association .btn{width:100%}.kpi strong{font-size:21px}}
  </style>`;
}

function layout(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="icon" type="image/svg+xml" href="/public/favicon-loginpro.svg?v=meta-stats">${styles()}</head><body><nav class="nav"><a href="/admin">Panel</a><a href="${BASE_PATH}">Estadísticas</a><a href="${BASE_PATH}/campaigns" class="active">Anuncios</a><span class="spacer"></span><a href="/logout">Cerrar sesión</a></nav><main class="page">${body}</main></body></html>`;
}

async function loadDashboard(prisma, query = {}) {
  const range = dateRange(query);
  const showHistorical = String(query.historical || '') === '1';
  const city = normalizeText(query.city);
  const vacancyId = normalizeText(query.vacancyId);
  const campaignWhere = { sourceType: 'META_ADS' };
  if (city) campaignWhere.city = { contains: city, mode: 'insensitive' };
  if (vacancyId) campaignWhere.vacancyId = vacancyId;
  if (!showHistorical) {
    campaignWhere.OR = [
      { createdByUsername: 'meta-ads-sync', endsAt: null },
      { createdByUsername: null },
      { createdByUsername: { not: 'meta-ads-sync' } }
    ];
  }

  const [campaigns, candidates, cities, vacancies, account, lastSnapshot] = await Promise.all([
    prisma.campaign.findMany({
      where: campaignWhere,
      orderBy: [{ endsAt: 'asc' }, { updatedAt: 'desc' }],
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
  }).sort((a, b) => Number(Boolean(a.campaign.endsAt)) - Number(Boolean(b.campaign.endsAt)) || b.spend - a.spend || b.candidatesCount - a.candidatesCount);

  return {
    range, showHistorical, city, vacancyId, metrics,
    totals: aggregateMetaAdStatistics(metrics),
    cities, vacancies, account,
    lastSyncedAt: lastSnapshot?.updatedAt || account?.updatedAt || null
  };
}

function syncPanel(data = {}) {
  const configured = metaConfigured();
  const status = configured
    ? `<div class="alert good">Meta Ads está configurado. La página también sincroniza automáticamente en segundo plano y conserva snapshots para no consultar Meta en cada render.</div>`
    : `<div class="alert info">Meta Ads no está configurado. Se mostrarán únicamente los datos ya almacenados y las métricas internas de Lórren.</div>`;
  const form = configured
    ? `<form method="post" action="${BASE_PATH}/meta/sync-form" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Actualizando…'"><input type="hidden" name="since" value="${escapeHtml(data.range.since)}"><input type="hidden" name="until" value="${escapeHtml(data.range.until)}"><button class="btn primary" type="submit">↻ Actualizar desde Meta</button></form>`
    : '';
  return `${status}<section class="card"><div class="header" style="margin:0"><div><div class="card-title" style="margin-bottom:4px">Sincronización</div><div class="muted-text">Cuenta: ${escapeHtml(data.account?.name || data.account?.accountId || 'No identificada')} · Moneda: ${escapeHtml(data.account?.currency || 'COP')} · Zona horaria: ${escapeHtml(data.account?.timezoneName || 'America/Bogota')}</div><div class="muted-text">Última actualización guardada: ${escapeHtml(formatDateTime(data.lastSyncedAt, data.account?.timezoneName))}</div></div><div class="actions">${form}</div></div></section>`;
}

function filters(data = {}) {
  const cityOptions = data.cities.map((item) => `<option value="${escapeHtml(item.name)}" ${data.city === item.name ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
  const vacancyOptions = data.vacancies.map((item) => `<option value="${escapeHtml(item.id)}" ${data.vacancyId === item.id ? 'selected' : ''}>${escapeHtml(item.title)} — ${escapeHtml(item.city)}${item.isActive ? '' : ' (inactiva)'}</option>`).join('');
  return `<section class="card"><div class="card-title">Filtros</div><form class="filters" method="get" action="${BASE_PATH}/campaigns"><label>Desde<input type="date" name="from" value="${escapeHtml(data.range.since)}"></label><label>Hasta<input type="date" name="to" value="${escapeHtml(data.range.until)}"></label><label>Ciudad<select name="city"><option value="">Todas</option>${cityOptions}</select></label><label>Vacante<select name="vacancyId"><option value="">Todas</option>${vacancyOptions}</select></label><label style="flex-direction:row;align-items:center;gap:7px;min-height:39px"><input style="width:auto;min-height:auto" type="checkbox" name="historical" value="1" ${data.showHistorical ? 'checked' : ''}> Mostrar históricos/no disponibles</label><button class="btn secondary" type="submit">Aplicar filtros</button></form></section>`;
}

function topMetrics(data = {}) {
  const total = data.totals;
  return `<section class="card"><div class="card-title">Resultado del periodo</div><div class="grid"><div class="kpi purple"><strong>${formatMoney(total.spend, data.account?.currency)}</strong><span>Gasto real Meta</span></div><div class="kpi"><strong>${formatInteger(total.candidatesCount)}</strong><span>Candidatos atribuidos</span><em>${formatMoney(total.costPerCandidate, data.account?.currency)} por candidato</em></div><div class="kpi green"><strong>${formatInteger(total.completedRegistrations)}</strong><span>Registros completos</span><em>${rate(total.completedRegistrations,total.candidatesCount)} · ${formatMoney(total.costPerCompletedRegistration,data.account?.currency)}</em></div><div class="kpi orange"><strong>${formatInteger(total.incompleteRegistrations)}</strong><span>Registros incompletos</span><em>${formatMoney(total.estimatedIncompleteSpend,data.account?.currency)} inversión estimada</em></div><div class="kpi"><strong>${formatInteger(total.cvReceived)}</strong><span>Hojas de vida válidas</span><em>${formatMoney(total.costPerCv,data.account?.currency)} por HV</em></div><div class="kpi"><strong>${formatInteger(total.apt)}</strong><span>Candidatos aptos</span><em>${formatMoney(total.costPerApt,data.account?.currency)} por apto</em></div><div class="kpi green"><strong>${formatInteger(total.hired)}</strong><span>Contratados</span><em>${formatMoney(total.costPerHired,data.account?.currency)} por contratado</em></div><div class="kpi"><strong>${formatMoney(total.unattributedSpend,data.account?.currency)}</strong><span>Gasto sin candidato atribuible</span><em>Estimación por día y anuncio</em></div></div></section>`;
}

function funnel(total = {}) {
  const steps = [
    ['Clics a enlace', total.inlineLinkClicks || total.clicks, null],
    ['Conversaciones Meta', total.metaConversationsStarted, rate(total.metaConversationsStarted, total.inlineLinkClicks || total.clicks)],
    ['Candidatos Lórren', total.candidatesCount, rate(total.candidatesCount, total.metaConversationsStarted || total.inlineLinkClicks || total.clicks)],
    ['Inició proceso', total.startedProcess, rate(total.startedProcess, total.candidatesCount)],
    ['Registro completo', total.completedRegistrations, rate(total.completedRegistrations, total.candidatesCount)],
    ['HV válida', total.cvReceived, rate(total.cvReceived, total.candidatesCount)],
    ['Aptos', total.apt, rate(total.apt, total.cvReceived)],
    ['Contratados', total.hired, rate(total.hired, total.candidatesCount)]
  ];
  return `<section class="card"><div class="card-title">Embudo Meta → Lórren</div><div class="funnel">${steps.map(([label,value,stepRate])=>`<div class="step"><strong>${formatInteger(value)}</strong><span>${escapeHtml(label)}</span>${stepRate?`<em>${escapeHtml(stepRate)}</em>`:''}</div>`).join('')}</div></section>`;
}

function adsTable(data = {}) {
  if (!data.metrics.length) return `<section class="card"><div class="card-title">Anuncios</div><div class="empty">No hay anuncios para los filtros seleccionados. Pulsa “Actualizar desde Meta” o activa la vista histórica.</div></section>`;
  const rows = data.metrics.map((metric) => {
    const campaign = metric.campaign;
    const vacancy = campaign.vacancy;
    return `<tr><td><div class="name">${escapeHtml(metric.metaAdName || campaign.name)}</div><div class="muted-text">${escapeHtml(metric.metaCampaignName || 'Campaña Meta sin nombre')}</div><div class="mono muted-text">ad_id: ${escapeHtml(metric.metaAdId)}</div></td><td>${vacancy?`<div class="name">${escapeHtml(vacancy.title)}</div><div class="muted-text">${escapeHtml(campaign.city || vacancy.city)}</div>`:`<span class="badge bad">Sin vacante asociada</span>`}</td><td>${metaStatusBadge(campaign)}</td><td><div class="name">${formatMoney(metric.spend,data.account?.currency)}</div><div class="muted-text">${formatInteger(metric.impressions)} impresiones · ${formatInteger(metric.reach)} alcance</div></td><td><div class="name">${formatInteger(metric.inlineLinkClicks || metric.clicks)}</div><div class="muted-text">${formatMoney(metric.costPerLinkClick,data.account?.currency)} por clic</div></td><td><div class="name">${formatInteger(metric.candidatesCount)}</div><div class="muted-text">${formatMoney(metric.costPerCandidate,data.account?.currency)} por candidato</div></td><td><div class="name">${formatInteger(metric.completedRegistrations)} / ${formatInteger(metric.incompleteRegistrations)}</div><div class="muted-text">${metric.completionRate??'—'}% completos</div></td><td><div class="name">${formatMoney(metric.costPerCompletedRegistration,data.account?.currency)}</div><div class="muted-text">Completo</div><div class="cost-note">${formatMoney(metric.costPerIncompleteRegistration,data.account?.currency)} por incompleto</div></td><td><div class="name">${metric.cvReceived} HV · ${metric.apt} aptos</div><div class="muted-text">${metric.hired} contratados</div></td><td><a class="btn secondary small" href="${BASE_PATH}/campaigns/${encodeURIComponent(campaign.id)}?from=${encodeURIComponent(data.range.since)}&to=${encodeURIComponent(data.range.until)}">Ver y asociar</a></td></tr>`;
  }).join('');
  return `<section class="card"><div class="card-title">Anuncios sincronizados (${data.metrics.length})</div><div class="alert info">Los costos individuales e inversión en registros incompletos son estimaciones: se distribuye el gasto diario del anuncio entre los candidatos atribuidos ese mismo día. Los costos agregados por etapa usan el gasto real guardado desde Meta.</div><div class="table-wrap"><table><thead><tr><th>Anuncio</th><th>Vacante</th><th>Estado Meta</th><th>Gasto</th><th>Clics</th><th>Candidatos</th><th>Completos / incompletos</th><th>Costos por resultado</th><th>Calidad final</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

async function renderList(prisma, req, res) {
  if (!canAccess(req)) return res.status(403).send('No autorizado.');
  const data = await loadDashboard(prisma, req.query || {});
  const missingVacancies = missingVacancyCount(data.metrics);
  const warning = missingVacancies
    ? `<div class="alert warn">Hay ${missingVacancies} anuncio(s) sin vacante asociada. Mientras no se clasifiquen, Lórren no puede confirmar automáticamente la vacante usando el ad_id.</div>`
    : '';
  const body = `<div class="header"><div><h1>Anuncios Meta Ads</h1><p>Gasto real, atribución exacta por ad_id y avance del candidato dentro de Lórren.</p></div><div class="actions"><a class="btn secondary" href="${BASE_PATH}">← Centro de estadísticas</a></div></div>${warning}${syncPanel(data)}${filters(data)}${topMetrics(data)}${funnel(data.totals)}${adsTable(data)}`;
  return res.send(layout('Anuncios Meta Ads — Estadísticas', body));
}

function candidateRows(metric, currency) {
  if (!metric.candidates.length) return `<div class="empty">Este anuncio no tiene candidatos atribuidos en el periodo.</div>`;
  const rows = metric.candidates
    .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))
    .map((candidate)=>`<tr><td><a class="name" style="color:#0d7a6b;text-decoration:none" href="/admin/candidates/${escapeHtml(candidate.id)}">${escapeHtml(candidate.fullName || 'Sin nombre')}</a><div class="muted-text">${escapeHtml(candidate.phone || '')}</div></td><td><span class="badge ${candidate.registrationState.complete?'good':'warn'}">${candidate.registrationState.complete?'Completo':'Incompleto'}</span></td><td class="candidate-stage">${escapeHtml(candidate.registrationState.stage)}</td><td>${candidate.registrationState.hasCv?'Sí':'No'}</td><td>${escapeHtml(candidate.status || 'NUEVO')}</td><td><div class="name">${formatMoney(candidate.estimatedCost,currency)}</div><div class="cost-note">Costo estimado individual</div></td><td>${escapeHtml(new Intl.DateTimeFormat('es-CO',{dateStyle:'medium'}).format(new Date(candidate.createdAt)))}</td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th>Candidato</th><th>Registro</th><th>Punto pendiente</th><th>HV</th><th>Estado</th><th>Costo estimado</th><th>Fecha</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function renderDetail(prisma, req, res) {
  if (!canAccess(req)) return res.status(403).send('No autorizado.');
  const data = await loadDashboard(prisma, { ...req.query, historical: '1' });
  const metric = data.metrics.find((item) => item.campaign.id === req.params.id);
  if (!metric) return res.status(404).send(layout('Anuncio no encontrado', '<div class="alert bad">El anuncio no existe o no está disponible.</div>'));
  const campaign = metric.campaign;
  const cityOptions = data.cities.map((item)=>`<option value="${escapeHtml(item.name)}" ${campaign.city===item.name?'selected':''}>${escapeHtml(item.name)}</option>`).join('');
  const vacancyOptions = data.vacancies.map((item)=>`<option value="${escapeHtml(item.id)}" ${campaign.vacancyId===item.id?'selected':''}>${escapeHtml(item.title)} — ${escapeHtml(item.city)}${item.isActive?'':' (inactiva)'}</option>`).join('');
  const body = `<div class="header"><div><a class="btn secondary small" href="${BASE_PATH}/campaigns?from=${encodeURIComponent(data.range.since)}&to=${encodeURIComponent(data.range.until)}">← Volver</a><h1 style="margin-top:10px">${escapeHtml(metric.metaAdName || campaign.name)}</h1><p>${escapeHtml(metric.metaCampaignName || 'Campaña Meta')} · <span class="mono">ad_id ${escapeHtml(metric.metaAdId)}</span></p></div><div>${metaStatusBadge(campaign)}</div></div><section class="card"><div class="card-title">Asociación anuncio → vacante</div><div class="alert info">Esta asociación no modifica el anuncio en Meta. Define qué vacante confirma Lórren cuando recibe exactamente este ad_id.</div><form class="association" method="post" action="${BASE_PATH}/campaigns/${escapeHtml(campaign.id)}/edit"><label>Ciudad<select name="city"><option value="">Sin ciudad</option>${cityOptions}</select></label><label>Vacante<select name="vacancyId"><option value="">Sin vacante</option>${vacancyOptions}</select></label><button class="btn primary" type="submit">Guardar asociación</button></form></section><section class="card"><div class="card-title">Rendimiento del anuncio</div><div class="grid"><div class="kpi purple"><strong>${formatMoney(metric.spend,data.account?.currency)}</strong><span>Gasto real</span></div><div class="kpi"><strong>${metric.candidatesCount}</strong><span>Candidatos</span><em>${formatMoney(metric.costPerCandidate,data.account?.currency)} c/u</em></div><div class="kpi green"><strong>${metric.completedRegistrations}</strong><span>Completos</span><em>${formatMoney(metric.costPerCompletedRegistration,data.account?.currency)} c/u</em></div><div class="kpi orange"><strong>${metric.incompleteRegistrations}</strong><span>Incompletos</span><em>${formatMoney(metric.estimatedIncompleteSpend,data.account?.currency)} inversión estimada</em></div><div class="kpi"><strong>${metric.cvReceived}</strong><span>HV válidas</span><em>${formatMoney(metric.costPerCv,data.account?.currency)} c/u</em></div><div class="kpi"><strong>${metric.apt}</strong><span>Aptos</span><em>${formatMoney(metric.costPerApt,data.account?.currency)} c/u</em></div><div class="kpi green"><strong>${metric.hired}</strong><span>Contratados</span><em>${formatMoney(metric.costPerHired,data.account?.currency)} c/u</em></div></div></section><section class="card"><div class="card-title">Candidatos atribuidos (${metric.candidatesCount})</div>${candidateRows(metric,data.account?.currency||'COP')}</section>`;
  return res.send(layout(`Anuncio: ${metric.metaAdName || campaign.name}`, body));
}

async function saveClassification(prisma, req, res) {
  if (!canAccess(req)) return res.status(403).send('No autorizado.');
  const requestedVacancyId = normalizeText(req.body?.vacancyId);
  const requestedCity = normalizeText(req.body?.city);
  const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id }, select: { id: true, code: true } });
  if (!campaign) return res.status(404).send('Anuncio no encontrado.');

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
      costPerIncomplete: metric.costPerIncompleteRegistration
    }))
  });
}

export function metaAdsStatsRouter(prisma) {
  const router = express.Router();
  router.get('/campaigns', (req, res) => renderList(prisma, req, res));
  router.get('/campaigns.json', (req, res) => jsonList(prisma, req, res));
  router.post('/campaigns', (_req, res) => res.redirect(`${BASE_PATH}/campaigns`));
  router.get('/campaigns/:id', (req, res) => renderDetail(prisma, req, res));
  router.post('/campaigns/:id/edit', (req, res) => saveClassification(prisma, req, res));
  return router;
}

export default metaAdsStatsRouter;
