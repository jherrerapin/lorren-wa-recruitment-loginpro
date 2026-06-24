import express from 'express';
import { canSeeLorenV2, requireLorenV2 } from '../services/lorenV2Gate.js';

// ─── Constantes ────────────────────────────────────────────────────────────────

const CAMPAIGN_SOURCE_TYPE = 'META_ADS';
const CAMPAIGN_SOURCE_LABEL = 'Meta / Facebook Ads';

// ─── Utilidades de escape y normalización ──────────────────────────────────────

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeDateInput(value) {
  const text = normalizeString(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
}

function dateRangeFromQuery(query = {}) {
  const from = normalizeDateInput(query.from);
  const to = normalizeDateInput(query.to);
  return {
    from,
    to,
    start: from ? new Date(`${from}T00:00:00-05:00`) : null,
    end: to ? new Date(`${to}T23:59:59.999-05:00`) : null
  };
}

function normalizeCampaignCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9_-]/g, '');
}

function normalizeAttributionToken(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/HTTPS?:\/\//g, '')
    .replace(/WWW\./g, '')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isValidCampaignCode(value) {
  return /^[A-Z0-9_-]{3,80}$/.test(value);
}

function compactUnique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function conversionRate(part, total) {
  if (!total) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return dateStr.slice(0, 10);
}

// ─── Clasificadores de candidatos ─────────────────────────────────────────────

function hasCandidateData(c = {}) {
  return Boolean(c.fullName || c.documentNumber || c.age || c.neighborhood || c.locality || c.transportMode);
}

function hasCompleteCoreData(c = {}) {
  return Boolean(c.fullName && c.documentNumber && c.phone);
}

function hasCv(c = {}) {
  return Boolean(c.cvStorageKey || c.cvData || c.cvOriginalName);
}

function hasBooking(c = {}) {
  return (c.interviewBookings || []).some((b) => b.status !== 'CANCELLED');
}

function hasConfirmedBooking(c = {}) {
  return (c.interviewBookings || []).some((b) => ['CONFIRMED', 'ATTENDED'].includes(b.status));
}

function hasAttendedBooking(c = {}) {
  return (c.interviewBookings || []).some((b) => b.status === 'ATTENDED');
}

function requiresHumanReview(c = {}) {
  return Boolean(c.potentialDuplicate || c.botPaused || c.rejectionDetails);
}

// ─── Motor de atribución ───────────────────────────────────────────────────────

function collectReferralValues(rawPayload = {}) {
  const referral = rawPayload?.referral || rawPayload?.context?.referral || null;
  if (!referral || typeof referral !== 'object') return [];
  return compactUnique([
    referral.source_id, referral.source_url, referral.headline, referral.body,
    referral.ctwa_clid, referral.ad_id, referral.adgroup_id,
    referral.campaign_id, referral.campaign_name, referral.ad_name
  ].map((v) => String(v || '').trim()));
}

function collectCandidateAttributionValues(candidate = {}) {
  const values = [candidate.campaignCodeRaw];
  // Atribución exacta vía campos Meta persistidos
  if (candidate.metaCampaignId) values.push(candidate.metaCampaignId);
  if (candidate.metaAdId) values.push(candidate.metaAdId);
  if (candidate.metaCampaignName) values.push(candidate.metaCampaignName);
  // Atribución inferida vía mensajes
  for (const message of candidate.messages || []) {
    values.push(...collectReferralValues(message.rawPayload || {}));
  }
  return compactUnique(values);
}

function campaignTokens(campaign = {}) {
  return compactUnique([
    normalizeCampaignCode(campaign.code),
    normalizeAttributionToken(campaign.code),
    normalizeAttributionToken(campaign.name),
    normalizeAttributionToken(campaign.notes)
  ]).filter((t) => t.length >= 3);
}

function candidateTokens(candidate = {}) {
  return compactUnique(
    collectCandidateAttributionValues(candidate)
      .flatMap((v) => [normalizeCampaignCode(v), normalizeAttributionToken(v)])
      .filter((t) => t.length >= 3)
  );
}

function tokenMatchesCampaign(ct, kt) {
  if (!ct || !kt) return false;
  if (ct === kt) return true;
  if (ct.length < 8 || kt.length < 8) return false;
  return ct.includes(kt) || kt.includes(ct);
}

function candidateBelongsToCampaign(candidate = {}, campaign = {}) {
  // 1. Vínculo directo por FK
  if (candidate.campaignId && candidate.campaignId === campaign.id) {
    return { matched: true, mode: 'direct' };
  }
  // 2. Atribución exacta por ID de Meta
  if (candidate.metaCampaignId && campaign.code) {
    const codeNorm = normalizeCampaignCode(campaign.code);
    const metaNorm = normalizeCampaignCode(candidate.metaCampaignId);
    if (codeNorm === metaNorm || codeNorm.includes(metaNorm) || metaNorm.includes(codeNorm)) {
      return { matched: true, mode: 'exact_meta' };
    }
  }
  // 3. Atribución inferida por tokens
  const tokensFromCandidate = candidateTokens(candidate);
  if (!tokensFromCandidate.length) return { matched: false, mode: null };
  const tokensFromCampaign = campaignTokens(campaign);
  const matched = tokensFromCandidate.some((ct) =>
    tokensFromCampaign.some((kt) => tokenMatchesCampaign(ct, kt))
  );
  return { matched, mode: matched ? 'metadata' : null };
}

function enrichCampaignsWithAttribution(campaigns = [], candidates = []) {
  return campaigns.map((campaign) => {
    const attributedCandidates = [];
    let exactAttributions = 0;
    let inferredAttributions = 0;

    for (const candidate of candidates) {
      const result = candidateBelongsToCampaign(candidate, campaign);
      if (!result.matched) continue;
      attributedCandidates.push(candidate);
      if (result.mode === 'exact_meta') exactAttributions += 1;
      if (result.mode === 'metadata') inferredAttributions += 1;
    }

    return { ...campaign, attributedCandidates, exactAttributions, inferredAttributions };
  });
}

// ─── Cálculo de métricas ───────────────────────────────────────────────────────

function buildCampaignMetric(campaign = {}, schedulingEnabled = false) {
  const candidates = campaign.attributedCandidates || campaign.candidates || [];
  const base = {
    conversationsStarted: candidates.length,
    startedProcess: candidates.filter(hasCandidateData).length,
    dataCompleted: candidates.filter(hasCompleteCoreData).length,
    cvReceived: candidates.filter(hasCv).length,
    apt: candidates.filter((c) => ['APROBADO', 'CONTRATADO'].includes(c.status)).length,
    rejected: candidates.filter((c) => c.status === 'RECHAZADO').length,
    hired: candidates.filter((c) => c.status === 'CONTRATADO').length,
    abandoned: candidates.filter((c) => c.status === 'NUEVO' && !hasCandidateData(c) && !hasCv(c)).length,
    pendingCv: candidates.filter((c) => hasCompleteCoreData(c) && !hasCv(c)).length,
    humanReview: candidates.filter(requiresHumanReview).length,
    exactAttributions: campaign.exactAttributions || 0,
    inferredAttributions: campaign.inferredAttributions || 0
  };
  if (schedulingEnabled) {
    base.scheduled = candidates.filter(hasBooking).length;
    base.confirmed = candidates.filter(hasConfirmedBooking).length;
    base.attended = candidates.filter(hasAttendedBooking).length;
  }
  return base;
}

function buildAggregateCampaignMetric(enrichedCampaigns = []) {
  return enrichedCampaigns.reduce((total, campaign) => {
    const schedulingEnabled = Boolean(campaign.vacancy?.schedulingEnabled);
    const metric = buildCampaignMetric(campaign, schedulingEnabled);
    for (const [key, value] of Object.entries(metric)) {
      total[key] = (total[key] || 0) + Number(value || 0);
    }
    return total;
  }, {});
}

function hasMetaAttributionEvidence(candidate = {}) {
  return Boolean(
    candidate.metaCampaignId ||
    candidate.metaAdId ||
    candidate.campaignCodeRaw ||
    (candidate.messages || []).some((m) => collectReferralValues(m.rawPayload || {}).length)
  );
}

function buildUnmatchedMetaCandidates(candidates = [], campaigns = []) {
  const campaignIds = new Set(campaigns.map((c) => c.id));
  return candidates
    .filter((c) =>
      c.sourceType === CAMPAIGN_SOURCE_TYPE &&
      !campaignIds.has(c.campaignId) &&
      hasMetaAttributionEvidence(c)
    )
    .slice(0, 50);
}

// ─── Carga de datos ────────────────────────────────────────────────────────────

async function loadCities(prisma) {
  return prisma.city.findMany({
    where: { usedForRecruitment: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true }
  });
}

async function loadVacancies(prisma, filters = {}) {
  const where = { isActive: true };
  if (filters.city) where.city = { contains: filters.city, mode: 'insensitive' };
  return prisma.vacancy.findMany({
    where,
    orderBy: [{ city: 'asc' }, { title: 'asc' }],
    select: { id: true, title: true, city: true, schedulingEnabled: true }
  });
}

async function loadCampaigns(prisma, filters = {}) {
  const where = {};
  if (filters.vacancyId) where.vacancyId = filters.vacancyId;
  if (filters.city) where.city = { contains: filters.city, mode: 'insensitive' };
  return prisma.campaign.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      vacancy: { select: { id: true, title: true, city: true, schedulingEnabled: true } }
    }
  });
}

async function loadCandidatesForCampaigns(prisma, range = {}) {
  const where = { sourceType: CAMPAIGN_SOURCE_TYPE };
  if (range.start || range.end) {
    where.createdAt = {};
    if (range.start) where.createdAt.gte = range.start;
    if (range.end) where.createdAt.lte = range.end;
  }
  return prisma.candidate.findMany({
    where,
    select: {
      id: true,
      phone: true,
      fullName: true,
      documentNumber: true,
      age: true,
      neighborhood: true,
      locality: true,
      transportMode: true,
      campaignId: true,
      sourceType: true,
      campaignCodeRaw: true,
      metaCtwaClid: true,
      metaAdId: true,
      metaCampaignId: true,
      metaCampaignName: true,
      cvStorageKey: true,
      cvData: true,
      cvOriginalName: true,
      status: true,
      potentialDuplicate: true,
      botPaused: true,
      rejectionDetails: true,
      createdAt: true,
      vacancyId: true,
      vacancy: { select: { id: true, title: true, city: true } },
      interviewBookings: { select: { status: true } },
      messages: {
        where: { direction: 'INBOUND' },
        select: { rawPayload: true },
        take: 5,
        orderBy: { createdAt: 'asc' }
      }
    }
  });
}

async function loadCampaignDashboardData(prisma, query = {}) {
  const range = dateRangeFromQuery(query);
  const filters = {
    from: range.from,
    to: range.to,
    city: normalizeString(query.city),
    vacancyId: normalizeString(query.vacancyId)
  };

  const [cities, vacancies, campaigns, candidates] = await Promise.all([
    loadCities(prisma),
    loadVacancies(prisma, filters),
    loadCampaigns(prisma, filters),
    loadCandidatesForCampaigns(prisma, range)
  ]);

  const enriched = enrichCampaignsWithAttribution(campaigns, candidates);
  const unmatched = buildUnmatchedMetaCandidates(candidates, campaigns);

  return { filters, cities, vacancies, campaigns: enriched, unmatched };
}

// ─── Render: Layout ────────────────────────────────────────────────────────────

function renderLayout({ title, body }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; color: #1a1d23; font-size: 14px; line-height: 1.5; }
    .navbar { background: #1e2d3d; padding: 0 24px; display: flex; align-items: center; gap: 8px; height: 52px; border-bottom: 1px solid #0f1a26; }
    .navbar a { color: #94a3b8; text-decoration: none; font-size: 13px; font-weight: 500; padding: 6px 10px; border-radius: 6px; transition: all .15s; }
    .navbar a:hover, .navbar a.active { color: #fff; background: rgba(255,255,255,.08); }
    .navbar .sep { color: #334155; font-size: 16px; }
    .navbar .spacer { flex: 1; }
    .page { max-width: 1320px; margin: 0 auto; padding: 24px 20px 60px; }
    .page-header { margin-bottom: 20px; }
    .page-header h1 { font-size: 20px; font-weight: 700; color: #1e2d3d; }
    .page-header p { color: #64748b; font-size: 13px; margin-top: 2px; }

    /* Cards */
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
    .card-title { font-size: 13px; font-weight: 700; color: #1e2d3d; margin-bottom: 14px; text-transform: uppercase; letter-spacing: .04em; }

    /* Grid */
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .grid-auto { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .grid-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; align-items: end; }

    /* KPI */
    .kpi { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; }
    .kpi-value { font-size: 28px; font-weight: 800; color: #1e2d3d; line-height: 1; }
    .kpi-label { font-size: 11px; color: #64748b; margin-top: 4px; font-weight: 500; }
    .kpi-rate { font-size: 11px; color: #0d7a6b; font-weight: 700; margin-top: 2px; }
    .kpi.accent { border-color: #0d7a6b33; background: #f0faf8; }
    .kpi.accent .kpi-value { color: #0d7a6b; }
    .kpi.warn { border-color: #f59e0b33; background: #fffbeb; }
    .kpi.warn .kpi-value { color: #b45309; }

    /* Funnel */
    .funnel { display: flex; align-items: stretch; gap: 0; margin: 4px 0; overflow-x: auto; }
    .funnel-step { flex: 1; min-width: 90px; text-align: center; padding: 12px 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-right: none; position: relative; }
    .funnel-step:first-child { border-radius: 8px 0 0 8px; }
    .funnel-step:last-child { border-right: 1px solid #e2e8f0; border-radius: 0 8px 8px 0; }
    .funnel-step.highlight { background: #f0faf8; border-color: #0d7a6b44; }
    .funnel-step.dim { background: #fff5f5; border-color: #fca5a544; }
    .funnel-step-value { font-size: 22px; font-weight: 800; color: #1e2d3d; }
    .funnel-step-label { font-size: 10px; color: #64748b; margin-top: 2px; font-weight: 500; line-height: 1.3; }
    .funnel-step-rate { font-size: 10px; color: #0d7a6b; font-weight: 700; margin-top: 3px; }
    .funnel-arrow { align-self: center; color: #cbd5e1; font-size: 16px; padding: 0 2px; flex-shrink: 0; }

    /* Forms */
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: #475569; }
    input, select, textarea { border: 1px solid #cbd5e1; border-radius: 7px; padding: 8px 10px; font-size: 13px; font-family: inherit; color: #1a1d23; background: #fff; width: 100%; transition: border-color .15s; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: #0d7a6b; box-shadow: 0 0 0 3px #0d7a6b18; }
    textarea { min-height: 68px; resize: vertical; }
    .btn { display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 7px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none; transition: all .15s; }
    .btn-primary { background: #0d7a6b; color: #fff; }
    .btn-primary:hover { background: #0b6559; }
    .btn-secondary { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; }
    .btn-secondary:hover { background: #e2e8f0; }
    .btn-danger { background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; }
    .btn-danger:hover { background: #fecaca; }
    .btn-sm { padding: 5px 10px; font-size: 12px; }

    /* Table */
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #64748b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; background: #f8fafc; padding: 9px 10px; border-bottom: 2px solid #e2e8f0; white-space: nowrap; }
    td { padding: 10px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
    tr:hover td { background: #f8fafc; }
    tr:last-child td { border-bottom: 0; }

    /* Badges */
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-weight: 700; font-size: 11px; line-height: 1.4; }
    .badge-green { background: #dcfce7; color: #15803d; }
    .badge-blue { background: #dbeafe; color: #1d4ed8; }
    .badge-gray { background: #f1f5f9; color: #475569; }
    .badge-red { background: #fee2e2; color: #dc2626; }
    .badge-amber { background: #fef3c7; color: #92400e; }
    .badge-teal { background: #e6f4f1; color: #0d7a6b; }

    /* Misc */
    .muted { color: #64748b; font-size: 12px; }
    .text-sm { font-size: 12px; }
    .text-xs { font-size: 11px; }
    .fw-700 { font-weight: 700; }
    .mt-4 { margin-top: 16px; }
    .mb-4 { margin-bottom: 16px; }
    .gap-2 { gap: 8px; }
    .flex { display: flex; align-items: center; }
    .alert { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-weight: 600; font-size: 13px; }
    .alert-error { background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; }
    .alert-success { background: #dcfce7; color: #16a34a; border: 1px solid #86efac; }
    .section-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #94a3b8; margin-bottom: 10px; }
    .divider { border: none; border-top: 1px solid #e2e8f0; margin: 20px 0; }
    .empty-state { text-align: center; padding: 40px 20px; color: #94a3b8; }
    .empty-state p { font-size: 13px; margin-top: 6px; }

    @media (max-width: 768px) {
      .grid-2, .grid-3 { grid-template-columns: 1fr; }
      .funnel { flex-wrap: wrap; }
      .funnel-step { min-width: 80px; flex: 1 1 80px; }
      .funnel-arrow { display: none; }
    }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/admin">Panel</a>
    <span class="sep">›</span>
    <a href="/admin/v2">Loren V2</a>
    <span class="sep">›</span>
    <a href="/admin/v2/campaigns" class="active">Campañas</a>
    <span class="spacer"></span>
    <a href="/logout">Cerrar sesión</a>
  </nav>
  <main class="page">${body}</main>
</body>
</html>`;
}

// ─── Render: Filtros ───────────────────────────────────────────────────────────

function renderFilters({ filters = {}, cities = [], vacancies = [] }) {
  const cityOptions = cities
    .map((c) => `<option value="${escapeHtml(c.name)}" ${filters.city === c.name ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
    .join('');

  const vacancyOptions = vacancies
    .map((v) => `<option value="${escapeHtml(v.id)}" ${filters.vacancyId === v.id ? 'selected' : ''}>${escapeHtml(v.title)} — ${escapeHtml(v.city)}</option>`)
    .join('');

  return `<section class="card">
    <div class="card-title">Filtros de análisis</div>
    <form method="get" action="/admin/v2/campaigns" class="grid-form">
      <label>Desde
        <input type="date" name="from" value="${escapeHtml(filters.from || '')}">
      </label>
      <label>Hasta
        <input type="date" name="to" value="${escapeHtml(filters.to || '')}">
      </label>
      <label>Ciudad
        <select name="city">
          <option value="">Todas las ciudades</option>
          ${cityOptions}
        </select>
      </label>
      <label>Vacante
        <select name="vacancyId">
          <option value="">Todas las vacantes</option>
          ${vacancyOptions}
        </select>
      </label>
      <div><button type="submit" class="btn btn-primary">Aplicar filtros</button></div>
    </form>
  </section>`;
}

// ─── Render: Embudo agregado ───────────────────────────────────────────────────

function renderFunnel(campaigns = []) {
  const metric = buildAggregateCampaignMetric(campaigns);
  const hasScheduling = campaigns.some((c) => c.vacancy?.schedulingEnabled);
  const total = metric.conversationsStarted || 0;

  const steps = [
    { label: 'Conversaciones', value: metric.conversationsStarted || 0, rate: null, cls: '' },
    { label: 'Inició proceso', value: metric.startedProcess || 0, rate: conversionRate(metric.startedProcess, total), cls: '' },
    { label: 'Datos completos', value: metric.dataCompleted || 0, rate: conversionRate(metric.dataCompleted, total), cls: '' },
    { label: 'HV recibida', value: metric.cvReceived || 0, rate: conversionRate(metric.cvReceived, total), cls: '' },
    { label: 'Aptos', value: metric.apt || 0, rate: conversionRate(metric.apt, metric.cvReceived), cls: 'highlight' }
  ];

  if (hasScheduling) {
    steps.push(
      { label: 'Agendados', value: metric.scheduled || 0, rate: conversionRate(metric.scheduled, metric.apt), cls: '' },
      { label: 'Confirmados', value: metric.confirmed || 0, rate: conversionRate(metric.confirmed, metric.scheduled), cls: '' },
      { label: 'Asistieron', value: metric.attended || 0, rate: conversionRate(metric.attended, metric.confirmed), cls: '' }
    );
  }

  steps.push({ label: 'Contratados', value: metric.hired || 0, rate: conversionRate(metric.hired, total), cls: 'highlight' });

  const stepsHtml = steps.map((s, i) => {
    const arrow = i < steps.length - 1 ? '<span class="funnel-arrow">›</span>' : '';
    return `<div class="funnel-step ${s.cls}">
      <div class="funnel-step-value">${s.value}</div>
      <div class="funnel-step-label">${escapeHtml(s.label)}</div>
      ${s.rate ? `<div class="funnel-step-rate">${escapeHtml(s.rate)}</div>` : ''}
    </div>${arrow}`;
  }).join('');

  const abandoned = metric.abandoned || 0;
  const humanReview = metric.humanReview || 0;
  const pendingCv = metric.pendingCv || 0;

  return `<section class="card">
    <div class="card-title">Embudo de conversión — todas las campañas</div>
    <div class="funnel">${stepsHtml}</div>
    <hr class="divider">
    <div class="grid-auto" style="margin-top: 0;">
      <div class="kpi warn">
        <div class="kpi-value">${abandoned}</div>
        <div class="kpi-label">Abandonaron sin datos</div>
        <div class="kpi-rate">${conversionRate(abandoned, total)} de conversaciones</div>
      </div>
      <div class="kpi">
        <div class="kpi-value">${pendingCv}</div>
        <div class="kpi-label">Pendientes de HV</div>
        <div class="kpi-rate">Datos completos sin HV</div>
      </div>
      <div class="kpi">
        <div class="kpi-value">${humanReview}</div>
        <div class="kpi-label">Revisión manual</div>
        <div class="kpi-rate">Duplicados, pausados, rechazados</div>
      </div>
      <div class="kpi">
        <div class="kpi-value">${metric.rejected || 0}</div>
        <div class="kpi-label">Rechazados</div>
        <div class="kpi-rate">${conversionRate(metric.rejected, total)} de conversaciones</div>
      </div>
    </div>
  </section>`;
}

// ─── Render: Tabla de campañas ─────────────────────────────────────────────────

function renderCampaignTable(campaigns = []) {
  if (!campaigns.length) {
    return `<section class="card">
      <div class="card-title">Campañas registradas</div>
      <div class="empty-state">
        <div style="font-size:32px">📭</div>
        <p>Aún no hay campañas. Crea la primera usando el formulario de abajo.</p>
      </div>
    </section>`;
  }

  const rows = campaigns.map((campaign) => {
    const schedulingEnabled = Boolean(campaign.vacancy?.schedulingEnabled);
    const metric = buildCampaignMetric(campaign, schedulingEnabled);
    const total = metric.conversationsStarted;
    const activeLabel = campaign.isActive
      ? '<span class="badge badge-green">Activa</span>'
      : '<span class="badge badge-gray">Inactiva</span>';

    const schedulingCells = schedulingEnabled
      ? `<td class="text-sm">${metric.scheduled}<br><span class="muted">${conversionRate(metric.scheduled, metric.apt)} de aptos</span></td>
         <td class="text-sm">${metric.confirmed}<br><span class="muted">confirmados</span></td>
         <td class="text-sm">${metric.attended}<br><span class="muted">${conversionRate(metric.attended, metric.confirmed)} asistencia</span></td>`
      : `<td class="muted text-xs" colspan="3" style="text-align:center">Sin entrevistas configuradas</td>`;

    const attrLabel = metric.exactAttributions > 0
      ? `<span class="badge badge-teal text-xs">${metric.exactAttributions} exactos</span>`
      : metric.inferredAttributions > 0
        ? `<span class="badge badge-blue text-xs">${metric.inferredAttributions} inferidos</span>`
        : '';

    return `<tr>
      <td>
        <a href="/admin/v2/campaigns/${escapeHtml(campaign.id)}" class="fw-700" style="color:#0d7a6b;text-decoration:none;">${escapeHtml(campaign.name)}</a><br>
        <span class="badge badge-gray text-xs" style="margin-top:3px;font-family:monospace">${escapeHtml(campaign.code)}</span>
        ${attrLabel}
      </td>
      <td>
        ${campaign.vacancy ? escapeHtml(campaign.vacancy.title) : '<span class="muted">Sin vacante</span>'}<br>
        <span class="muted">${escapeHtml(campaign.city || campaign.vacancy?.city || '—')}</span>
      </td>
      <td>${activeLabel}</td>
      <td class="fw-700">${total}<br><span class="muted text-xs">conversaciones</span></td>
      <td class="text-sm">${metric.dataCompleted}<br><span class="muted">${conversionRate(metric.dataCompleted, total)}</span></td>
      <td class="text-sm">${metric.cvReceived}<br><span class="muted">${conversionRate(metric.cvReceived, total)}</span></td>
      <td class="text-sm"><strong>${metric.apt}</strong><br><span class="muted">${conversionRate(metric.apt, metric.cvReceived)} de HV</span></td>
      ${schedulingCells}
      <td class="text-sm"><strong style="color:#0d7a6b">${metric.hired}</strong><br><span class="muted">${conversionRate(metric.hired, total)}</span></td>
      <td>
        <a href="/admin/v2/campaigns/${escapeHtml(campaign.id)}" class="btn btn-secondary btn-sm">Ver →</a>
      </td>
    </tr>`;
  }).join('');

  return `<section class="card">
    <div class="card-title">Campañas registradas (${campaigns.length})</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Campaña</th>
            <th>Vacante / Ciudad</th>
            <th>Estado</th>
            <th>Conversaciones</th>
            <th>Datos completos</th>
            <th>HV</th>
            <th>Aptos</th>
            <th>Agendados</th>
            <th>Confirmados</th>
            <th>Asistieron</th>
            <th>Contratados</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

// ─── Render: Formulario de creación ───────────────────────────────────────────

function renderCreateForm({ cities = [], vacancies = [], error = null, success = null }) {
  const cityOptions = cities
    .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`)
    .join('');

  const vacancyOptions = vacancies
    .map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.title)} — ${escapeHtml(v.city)}${v.schedulingEnabled ? ' [entrevista]' : ''}</option>`)
    .join('');

  return `<section class="card">
    <div class="card-title">Nueva campaña</div>
    <p class="muted mb-4">El código interno debe coincidir con el ID de campaña, nombre del anuncio o etiqueta de Meta Ads. Se usa para atribuir automáticamente los candidatos que lleguen de esa pauta.</p>
    ${error ? `<div class="alert alert-error">${escapeHtml(error)}</div>` : ''}
    ${success ? `<div class="alert alert-success">${escapeHtml(success)}</div>` : ''}
    <form method="post" action="/admin/v2/campaigns">
      <div class="grid-form">
        <label>Código interno de Meta Ads *
          <input name="code" placeholder="23856238000000000 o BOGOTA-JUN-2026" required maxlength="80" style="font-family:monospace">
          <span class="muted text-xs">ID de campaña, ad_id o etiqueta — se normaliza automáticamente</span>
        </label>
        <label>Nombre de la campaña *
          <input name="name" placeholder="Auxiliares Bogotá — junio 2026" required maxlength="120">
        </label>
        <label>Ciudad
          <select name="city">
            <option value="">Sin ciudad específica</option>
            ${cityOptions}
          </select>
        </label>
        <label>Vacante asociada
          <select name="vacancyId">
            <option value="">Sin vacante específica</option>
            ${vacancyOptions}
          </select>
        </label>
        <label>Fecha inicio pauta
          <input type="date" name="startsAt">
        </label>
        <label>Fecha fin pauta
          <input type="date" name="endsAt">
        </label>
      </div>
      <label style="margin-top:12px;">Notas adicionales
        <textarea name="notes" placeholder="Público objetivo, presupuesto, hipótesis de segmentación, nombres alternativos del anuncio..."></textarea>
      </label>
      <div style="margin-top:14px;">
        <button type="submit" class="btn btn-primary">Crear campaña</button>
      </div>
    </form>
  </section>`;
}

// ─── Render: Candidatos sin match ──────────────────────────────────────────────

function renderUnmatched(candidates = [], campaigns = []) {
  if (!candidates.length) {
    return `<section class="card">
      <div class="card-title">Candidatos Meta sin campaña asociada</div>
      <div class="empty-state"><p>No hay candidatos Meta pendientes de asociación en el rango seleccionado. ✅</p></div>
    </section>`;
  }

  const campaignOptions = campaigns
    .filter((c) => c.isActive)
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.code)})</option>`)
    .join('');

  const rows = candidates.map((c) => {
    const metaInfo = [
      c.metaCampaignId ? `campaign_id: ${c.metaCampaignId}` : null,
      c.metaAdId ? `ad_id: ${c.metaAdId}` : null,
      c.metaCampaignName ? `"${c.metaCampaignName}"` : null,
      c.campaignCodeRaw ? `raw: ${String(c.campaignCodeRaw).slice(0, 60)}` : null
    ].filter(Boolean).join(' · ');

    return `<tr>
      <td>
        <span class="fw-700">${escapeHtml(c.fullName || 'Sin nombre')}</span><br>
        <span class="muted">${escapeHtml(c.phone || '')}</span>
      </td>
      <td>${escapeHtml(c.vacancy?.title || 'Sin vacante')}</td>
      <td><span class="muted text-xs" style="font-family:monospace">${escapeHtml(metaInfo || '—')}</span></td>
      <td>
        <form method="post" action="/admin/v2/campaigns/associate" style="display:flex;gap:6px;align-items:center">
          <input type="hidden" name="candidateId" value="${escapeHtml(c.id)}">
          <select name="campaignId" style="min-width:160px;font-size:12px;padding:5px 8px">
            <option value="">Seleccionar campaña…</option>
            ${campaignOptions}
          </select>
          <button type="submit" class="btn btn-secondary btn-sm">Asociar</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  return `<section class="card">
    <div class="card-title">Candidatos Meta sin campaña asociada (${candidates.length})</div>
    <p class="muted mb-4">Estos candidatos llegaron con evidencia de pauta Meta pero no coinciden con ninguna campaña registrada. Asócialos manualmente o ajusta el código/notas de la campaña para que el motor los detecte.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Candidato</th><th>Vacante</th><th>Metadata Meta recibida</th><th>Asociar a campaña</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

// ─── Render: Detalle de campaña ────────────────────────────────────────────────

function renderCampaignDetail({ campaign, candidates = [], error = null, success = null }) {
  const schedulingEnabled = Boolean(campaign.vacancy?.schedulingEnabled);
  const metric = buildCampaignMetric(campaign, schedulingEnabled);
  const total = metric.conversationsStarted;

  const statusSteps = [
    { key: 'conversationsStarted', label: 'Conversaciones', value: total, rate: null },
    { key: 'dataCompleted', label: 'Datos completos', value: metric.dataCompleted, rate: conversionRate(metric.dataCompleted, total) },
    { key: 'cvReceived', label: 'HV recibida', value: metric.cvReceived, rate: conversionRate(metric.cvReceived, total) },
    { key: 'apt', label: 'Aptos', value: metric.apt, rate: conversionRate(metric.apt, metric.cvReceived), cls: 'highlight' }
  ];
  if (schedulingEnabled) {
    statusSteps.push(
      { key: 'scheduled', label: 'Agendados', value: metric.scheduled, rate: conversionRate(metric.scheduled, metric.apt) },
      { key: 'attended', label: 'Asistieron', value: metric.attended, rate: conversionRate(metric.attended, metric.scheduled) }
    );
  }
  statusSteps.push({ key: 'hired', label: 'Contratados', value: metric.hired, rate: conversionRate(metric.hired, total), cls: 'highlight' });

  const funnelHtml = statusSteps.map((s, i) => {
    const arrow = i < statusSteps.length - 1 ? '<span class="funnel-arrow">›</span>' : '';
    return `<div class="funnel-step ${s.cls || ''}">
      <div class="funnel-step-value">${s.value}</div>
      <div class="funnel-step-label">${escapeHtml(s.label)}</div>
      ${s.rate ? `<div class="funnel-step-rate">${escapeHtml(s.rate)}</div>` : ''}
    </div>${arrow}`;
  }).join('');

  function statusBadge(status) {
    const map = {
      NUEVO: 'badge-gray', REGISTRADO: 'badge-blue', VALIDANDO: 'badge-amber',
      APROBADO: 'badge-green', RECHAZADO: 'badge-red', CONTACTADO: 'badge-blue',
      CONTRATADO: 'badge-teal'
    };
    return `<span class="badge ${map[status] || 'badge-gray'}">${escapeHtml(status)}</span>`;
  }

  const candidateRows = candidates.map((c) => {
    const attrMode = c.campaignId === campaign.id ? 'Directo' : c.metaCampaignId ? 'Meta exacto' : 'Token';
    const flags = [
      hasCandidateData(c) ? '✓ Datos' : null,
      hasCv(c) ? '✓ HV' : null,
      schedulingEnabled && hasBooking(c) ? '✓ Cita' : null,
      schedulingEnabled && hasAttendedBooking(c) ? '✓ Asistió' : null,
      c.potentialDuplicate ? '⚠ Dup.' : null,
      c.botPaused ? '⏸ Pausado' : null
    ].filter(Boolean).join(' · ');

    return `<tr>
      <td>
        <a href="/admin/candidates/${escapeHtml(c.id)}" style="color:#0d7a6b;text-decoration:none;font-weight:600">${escapeHtml(c.fullName || 'Sin nombre')}</a><br>
        <span class="muted">${escapeHtml(c.phone || '')}</span>
      </td>
      <td>${statusBadge(c.status)}</td>
      <td class="muted text-xs">${escapeHtml(flags || '—')}</td>
      <td class="muted text-xs">${escapeHtml(attrMode)}</td>
      <td class="muted text-xs">${c.createdAt ? new Date(c.createdAt).toLocaleDateString('es-CO') : '—'}</td>
    </tr>`;
  }).join('');

  const candidateTable = candidates.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Candidato</th><th>Estado</th><th>Avance en proceso</th><th>Atribución</th><th>Registro</th></tr></thead>
        <tbody>${candidateRows}</tbody>
      </table></div>`
    : `<div class="empty-state"><p>No hay candidatos atribuidos a esta campaña en el período seleccionado.</p></div>`;

  const activeLabel = campaign.isActive
    ? '<span class="badge badge-green">Activa</span>'
    : '<span class="badge badge-gray">Inactiva</span>';

  return renderLayout({
    title: `Campaña: ${campaign.name}`,
    body: `
      <div class="page-header">
        <div class="flex gap-2" style="margin-bottom:8px">
          <a href="/admin/v2/campaigns" class="btn btn-secondary btn-sm">← Campañas</a>
          ${activeLabel}
        </div>
        <h1>${escapeHtml(campaign.name)}</h1>
        <p style="font-family:monospace;color:#64748b;font-size:12px">${escapeHtml(campaign.code)}</p>
      </div>

      ${error ? `<div class="alert alert-error">${escapeHtml(error)}</div>` : ''}
      ${success ? `<div class="alert alert-success">${escapeHtml(success)}</div>` : ''}

      <div class="grid-2">
        <section class="card">
          <div class="card-title">Embudo de esta campaña</div>
          <div class="funnel">${funnelHtml}</div>
        </section>
        <section class="card">
          <div class="card-title">Editar campaña</div>
          <form method="post" action="/admin/v2/campaigns/${escapeHtml(campaign.id)}/edit">
            <div style="display:grid;gap:10px">
              <label>Nombre
                <input name="name" value="${escapeHtml(campaign.name)}" required maxlength="120">
              </label>
              <label>Notas
                <textarea name="notes">${escapeHtml(campaign.notes || '')}</textarea>
              </label>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <label>Fecha inicio
                  <input type="date" name="startsAt" value="${escapeHtml(campaign.startsAt ? formatDate(campaign.startsAt.toISOString()) : '')}">
                </label>
                <label>Fecha fin
                  <input type="date" name="endsAt" value="${escapeHtml(campaign.endsAt ? formatDate(campaign.endsAt.toISOString()) : '')}">
                </label>
              </div>
              <label style="flex-direction:row;align-items:center;gap:8px;cursor:pointer">
                <input type="checkbox" name="isActive" value="1" ${campaign.isActive ? 'checked' : ''} style="width:auto">
                <span>Campaña activa</span>
              </label>
              <button type="submit" class="btn btn-primary">Guardar cambios</button>
            </div>
          </form>
        </section>
      </div>

      <section class="card">
        <div class="card-title">Candidatos atribuidos a esta campaña (${candidates.length})</div>
        ${candidateTable}
      </section>`
  });
}

// ─── Router ────────────────────────────────────────────────────────────────────

const router = express.Router();

// GET /admin/v2/campaigns — Dashboard principal
router.get('/campaigns', canSeeLorenV2, async (req, res) => {
  try {
    const { prisma } = req;
    const data = await loadCampaignDashboardData(prisma, req.query);

    const body = `
      <div class="page-header">
        <h1>Campañas Meta Ads</h1>
        <p>Seguimiento de candidatos por pauta publicitaria — ${CAMPAIGN_SOURCE_LABEL}</p>
      </div>
      ${renderFilters({ filters: data.filters, cities: data.cities, vacancies: data.vacancies })}
      ${data.campaigns.length ? renderFunnel(data.campaigns) : ''}
      ${renderCampaignTable(data.campaigns)}
      ${renderUnmatched(data.unmatched, data.campaigns)}
      ${renderCreateForm({ cities: data.cities, vacancies: data.vacancies })}
    `;

    res.send(renderLayout({ title: 'Campañas — Loren V2', body }));
  } catch (err) {
    console.error('[lorenV2 campaigns GET]', err);
    res.status(500).send(renderLayout({ title: 'Error', body: '<div class="alert alert-error">Error interno cargando las campañas.</div>' }));
  }
});

// GET /admin/v2/campaigns.json — API JSON
router.get('/campaigns.json', canSeeLorenV2, async (req, res) => {
  try {
    const data = await loadCampaignDashboardData(req.prisma, req.query);
    const result = data.campaigns.map((campaign) => ({
      id: campaign.id,
      code: campaign.code,
      name: campaign.name,
      city: campaign.city,
      isActive: campaign.isActive,
      vacancy: campaign.vacancy ? { id: campaign.vacancy.id, title: campaign.vacancy.title } : null,
      metric: buildCampaignMetric(campaign, Boolean(campaign.vacancy?.schedulingEnabled))
    }));
    res.json({ ok: true, campaigns: result, total: result.length });
  } catch (err) {
    console.error('[lorenV2 campaigns.json]', err);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// GET /admin/v2/campaigns/:id — Detalle de campaña
router.get('/campaigns/:id', canSeeLorenV2, async (req, res) => {
  try {
    const { prisma } = req;
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      include: { vacancy: { select: { id: true, title: true, city: true, schedulingEnabled: true } } }
    });
    if (!campaign) return res.status(404).send(renderLayout({ title: 'No encontrada', body: '<div class="alert alert-error">Campaña no encontrada.</div>' }));

    const range = dateRangeFromQuery(req.query);
    const candidates = await loadCandidatesForCampaigns(prisma, range);
    const enriched = enrichCampaignsWithAttribution([campaign], candidates);
    const attributed = enriched[0]?.attributedCandidates || [];

    const successMsg = req.query.success ? 'Cambios guardados correctamente.' : null;
    res.send(renderCampaignDetail({ campaign, candidates: attributed, success: successMsg }));
  } catch (err) {
    console.error('[lorenV2 campaign detail]', err);
    res.status(500).send(renderLayout({ title: 'Error', body: '<div class="alert alert-error">Error cargando la campaña.</div>' }));
  }
});

// POST /admin/v2/campaigns — Crear campaña
router.post('/campaigns', requireLorenV2, async (req, res) => {
  const { prisma, body } = req;
  const code = normalizeCampaignCode(body.code || '');
  const name = normalizeString(body.name);
  const city = normalizeString(body.city);
  const vacancyId = normalizeString(body.vacancyId);
  const notes = normalizeString(body.notes);
  const startsAt = normalizeDateInput(body.startsAt);
  const endsAt = normalizeDateInput(body.endsAt);

  const reload = async (error) => {
    const data = await loadCampaignDashboardData(prisma, {});
    const body2 = `
      <div class="page-header"><h1>Campañas Meta Ads</h1><p>${CAMPAIGN_SOURCE_LABEL}</p></div>
      ${renderFilters({ filters: {}, cities: data.cities, vacancies: data.vacancies })}
      ${data.campaigns.length ? renderFunnel(data.campaigns) : ''}
      ${renderCampaignTable(data.campaigns)}
      ${renderUnmatched(data.unmatched, data.campaigns)}
      ${renderCreateForm({ cities: data.cities, vacancies: data.vacancies, error })}
    `;
    res.status(400).send(renderLayout({ title: 'Campañas — Loren V2', body: body2 }));
  };

  if (!code || !isValidCampaignCode(code)) return reload('El código ingresado no es válido. Usa solo letras, números, guiones o guiones bajos (mínimo 3 caracteres).');
  if (!name) return reload('El nombre de la campaña es obligatorio.');

  try {
    const existing = await prisma.campaign.findUnique({ where: { code } });
    if (existing) return reload(`Ya existe una campaña con el código "${code}". Usa un código diferente o edita la existente.`);

    await prisma.campaign.create({
      data: {
        id: `cmp_${Date.now()}`,
        code,
        name,
        sourceType: CAMPAIGN_SOURCE_TYPE,
        city: city || null,
        vacancyId: vacancyId || null,
        notes: notes || null,
        startsAt: startsAt ? new Date(`${startsAt}T05:00:00Z`) : null,
        endsAt: endsAt ? new Date(`${endsAt}T23:59:59Z`) : null,
        isActive: true,
        createdByUsername: req.session?.username || null
      }
    });

    res.redirect('/admin/v2/campaigns?success=1');
  } catch (err) {
    console.error('[lorenV2 campaigns POST]', err);
    reload('Error al guardar la campaña. Intenta de nuevo.');
  }
});

// POST /admin/v2/campaigns/:id/edit — Editar campaña
router.post('/campaigns/:id/edit', requireLorenV2, async (req, res) => {
  const { prisma, body } = req;
  const name = normalizeString(body.name);
  const notes = normalizeString(body.notes);
  const startsAt = normalizeDateInput(body.startsAt);
  const endsAt = normalizeDateInput(body.endsAt);
  const isActive = body.isActive === '1';

  try {
    await prisma.campaign.update({
      where: { id: req.params.id },
      data: {
        name: name || undefined,
        notes: notes || null,
        startsAt: startsAt ? new Date(`${startsAt}T05:00:00Z`) : null,
        endsAt: endsAt ? new Date(`${endsAt}T23:59:59Z`) : null,
        isActive
      }
    });
    res.redirect(`/admin/v2/campaigns/${req.params.id}?success=1`);
  } catch (err) {
    console.error('[lorenV2 campaign edit]', err);
    res.redirect(`/admin/v2/campaigns/${req.params.id}?error=1`);
  }
});

// POST /admin/v2/campaigns/associate — Asociar candidato a campaña manualmente
router.post('/campaigns/associate', requireLorenV2, async (req, res) => {
  const { prisma, body } = req;
  const candidateId = normalizeString(body.candidateId);
  const campaignId = normalizeString(body.campaignId);

  if (!candidateId || !campaignId) return res.redirect('/admin/v2/campaigns?error=missing');

  try {
    await prisma.candidate.update({
      where: { id: candidateId },
      data: { campaignId, sourceType: CAMPAIGN_SOURCE_TYPE }
    });
    res.redirect('/admin/v2/campaigns?success=asociado');
  } catch (err) {
    console.error('[lorenV2 associate]', err);
    res.redirect('/admin/v2/campaigns?error=1');
  }
});

export default router;
