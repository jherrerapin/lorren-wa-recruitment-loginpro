import express from 'express';
import { canSeeLorenV2, requireLorenV2 } from '../services/lorenV2Gate.js';

const CAMPAIGN_SOURCE_TYPE = 'META_ADS';
const CAMPAIGN_SOURCE_LABEL = 'Meta / Facebook Ads';

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

function candidateCreatedAtWhere(range = {}) {
  const createdAt = {};
  if (range.start) createdAt.gte = range.start;
  if (range.end) createdAt.lte = range.end;
  return Object.keys(createdAt).length ? { createdAt } : {};
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

function hasCandidateData(candidate = {}) {
  return Boolean(
    candidate.fullName ||
    candidate.documentNumber ||
    candidate.age ||
    candidate.neighborhood ||
    candidate.locality ||
    candidate.transportMode
  );
}

function hasCompleteCoreData(candidate = {}) {
  return Boolean(candidate.fullName && candidate.documentNumber && candidate.phone);
}

function hasCv(candidate = {}) {
  return Boolean(candidate.cvStorageKey || candidate.cvData || candidate.cvOriginalName);
}

function hasBooking(candidate = {}) {
  return (candidate.interviewBookings || []).some((booking) => booking.status !== 'CANCELLED');
}

function hasConfirmedBooking(candidate = {}) {
  return (candidate.interviewBookings || []).some((booking) => ['CONFIRMED', 'ATTENDED'].includes(booking.status));
}

function hasAttendedBooking(candidate = {}) {
  return (candidate.interviewBookings || []).some((booking) => booking.status === 'ATTENDED');
}

function requiresHumanReview(candidate = {}) {
  return Boolean(candidate.potentialDuplicate || candidate.botPaused || candidate.rejectionDetails);
}

function collectReferralValues(rawPayload = {}) {
  const referral = rawPayload?.referral || rawPayload?.context?.referral || null;
  if (!referral || typeof referral !== 'object') return [];

  return compactUnique([
    referral.source_id,
    referral.source_url,
    referral.headline,
    referral.body,
    referral.ctwa_clid,
    referral.ad_id,
    referral.adgroup_id,
    referral.campaign_id,
    referral.campaign_name,
    referral.ad_name
  ].map((value) => String(value || '').trim()));
}

function collectCandidateAttributionValues(candidate = {}) {
  const values = [candidate.campaignCodeRaw];

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
  ]).filter((token) => token.length >= 3);
}

function candidateTokens(candidate = {}) {
  return compactUnique(
    collectCandidateAttributionValues(candidate)
      .flatMap((value) => [normalizeCampaignCode(value), normalizeAttributionToken(value)])
      .filter((token) => token.length >= 3)
  );
}

function tokenMatchesCampaign(candidateToken, campaignToken) {
  if (!candidateToken || !campaignToken) return false;
  if (candidateToken === campaignToken) return true;
  if (candidateToken.length < 8 || campaignToken.length < 8) return false;
  return candidateToken.includes(campaignToken) || campaignToken.includes(candidateToken);
}

function candidateBelongsToCampaign(candidate = {}, campaign = {}) {
  if (candidate.campaignId && candidate.campaignId === campaign.id) return { matched: true, mode: 'direct' };

  const tokensFromCandidate = candidateTokens(candidate);
  if (!tokensFromCandidate.length) return { matched: false, mode: null };

  const tokensFromCampaign = campaignTokens(campaign);
  const matched = tokensFromCandidate.some((candidateToken) => (
    tokensFromCampaign.some((campaignToken) => tokenMatchesCampaign(candidateToken, campaignToken))
  ));

  return { matched, mode: matched ? 'metadata' : null };
}

function enrichCampaignsWithAttribution(campaigns = [], candidates = []) {
  return campaigns.map((campaign) => {
    const attributedCandidates = [];
    let inferredAttributions = 0;

    for (const candidate of candidates) {
      const result = candidateBelongsToCampaign(candidate, campaign);
      if (!result.matched) continue;
      attributedCandidates.push(candidate);
      if (result.mode === 'metadata') inferredAttributions += 1;
    }

    return {
      ...campaign,
      attributedCandidates,
      inferredAttributions
    };
  });
}

function buildCampaignMetric(campaign = {}) {
  const candidates = campaign.attributedCandidates || campaign.candidates || [];
  return {
    conversationsStarted: candidates.length,
    startedProcess: candidates.filter(hasCandidateData).length,
    dataCompleted: candidates.filter(hasCompleteCoreData).length,
    cvReceived: candidates.filter(hasCv).length,
    apt: candidates.filter((candidate) => ['APROBADO', 'CONTRATADO'].includes(candidate.status)).length,
    rejected: candidates.filter((candidate) => candidate.status === 'RECHAZADO').length,
    scheduled: candidates.filter(hasBooking).length,
    confirmed: candidates.filter(hasConfirmedBooking).length,
    attended: candidates.filter(hasAttendedBooking).length,
    hired: candidates.filter((candidate) => candidate.status === 'CONTRATADO').length,
    abandoned: candidates.filter((candidate) => candidate.status === 'NUEVO' && !hasCandidateData(candidate) && !hasCv(candidate)).length,
    pendingCv: candidates.filter((candidate) => hasCompleteCoreData(candidate) && !hasCv(candidate)).length,
    humanReview: candidates.filter(requiresHumanReview).length,
    inferredAttributions: campaign.inferredAttributions || 0
  };
}

function buildAggregateCampaignMetric(campaigns = []) {
  return campaigns.reduce((total, campaign) => {
    const metric = buildCampaignMetric(campaign);
    for (const [key, value] of Object.entries(metric)) {
      total[key] = (total[key] || 0) + Number(value || 0);
    }
    return total;
  }, {});
}

function hasMetaAttributionEvidence(candidate = {}) {
  return Boolean(candidate.campaignCodeRaw || (candidate.messages || []).some((message) => collectReferralValues(message.rawPayload || {}).length));
}

function buildUnmatchedMetaCandidates(candidates = []) {
  return candidates
    .filter((candidate) => candidate.sourceType === CAMPAIGN_SOURCE_TYPE && !candidate.campaignId && hasMetaAttributionEvidence(candidate))
    .slice(0, 50);
}

function conversionRate(part, total) {
  if (!total) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function renderLayout({ title, body }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f4f5f7; color: #1a1d23; }
    .navbar { background: #1e2d3d; padding: 0 24px; display: flex; align-items: center; gap: 20px; height: 52px; }
    .navbar a { color: #cbd5e0; text-decoration: none; font-size: 13px; font-weight: 600; }
    .navbar a:hover { color: #fff; }
    .navbar .spacer { flex: 1; }
    .page { max-width: 1280px; margin: 0 auto; padding: 24px 20px 48px; }
    .card { background: #fff; border: 1px solid #e1e4e8; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 18px; margin-bottom: 18px; }
    h1 { font-size: 22px; margin: 0 0 6px; color: #1e2d3d; }
    h2 { font-size: 16px; margin: 0 0 12px; color: #1e2d3d; }
    p { color: #6b7280; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 700; color: #6b7280; }
    input, select, textarea { border: 1px solid #e1e4e8; border-radius: 8px; padding: 8px 10px; font-size: 14px; font-family: inherit; }
    textarea { min-height: 70px; resize: vertical; }
    button, .btn { border: 0; border-radius: 8px; padding: 9px 14px; background: #0d7a6b; color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; background: #f9fafb; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #eaecef; vertical-align: top; }
    .badge { display: inline-flex; border-radius: 999px; padding: 3px 8px; background: #e6f4f1; color: #0d7a6b; font-weight: 700; font-size: 11px; }
    .muted { color: #6b7280; font-size: 12px; }
    .alert { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-weight: 700; }
    .alert-error { background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; }
    .alert-success { background: #dcfce7; color: #16a34a; border: 1px solid #86efac; }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/admin">Panel</a>
    <a href="/admin/v2">Loren V2</a>
    <a href="/admin/v2/campaigns">Campañas</a>
    <span class="spacer"></span>
    <a href="/logout">Cerrar sesión</a>
  </nav>
  <main class="page">${body}</main>
</body>
</html>`;
}

function renderCampaignFilters({ filters = {}, vacancies = [] }) {
  const vacancyOptions = vacancies
    .map((vacancy) => `<option value="${escapeHtml(vacancy.id)}" ${filters.vacancyId === vacancy.id ? 'selected' : ''}>${escapeHtml(vacancy.title)} — ${escapeHtml(vacancy.city)}</option>`)
    .join('');

  return `<section class="card">
    <h2>Filtros de análisis</h2>
    <form method="get" action="/admin/v2/campaigns" class="grid">
      <label>Desde
        <input type="date" name="from" value="${escapeHtml(filters.from || '')}">
      </label>
      <label>Hasta
        <input type="date" name="to" value="${escapeHtml(filters.to || '')}">
      </label>
      <label>Ciudad
        <input name="city" value="${escapeHtml(filters.city || '')}" placeholder="Bogotá">
      </label>
      <label>Vacante
        <select name="vacancyId">
          <option value="">Todas</option>
          ${vacancyOptions}
        </select>
      </label>
      <label>&nbsp;<button type="submit">Actualizar métricas</button></label>
    </form>
  </section>`;
}

function renderCampaignFunnel(campaigns = []) {
  const metric = buildAggregateCampaignMetric(campaigns);
  const items = [
    ['Datos completos / conversaciones', conversionRate(metric.dataCompleted, metric.conversationsStarted), `${metric.dataCompleted || 0} de ${metric.conversationsStarted || 0}`],
    ['HV / conversaciones', conversionRate(metric.cvReceived, metric.conversationsStarted), `${metric.cvReceived || 0} de ${metric.conversationsStarted || 0}`],
    ['Aptos / HV', conversionRate(metric.apt, metric.cvReceived), `${metric.apt || 0} de ${metric.cvReceived || 0}`],
    ['Agendados / aptos', conversionRate(metric.scheduled, metric.apt), `${metric.scheduled || 0} de ${metric.apt || 0}`],
    ['Asistencia / confirmados', conversionRate(metric.attended, metric.confirmed), `${metric.attended || 0} de ${metric.confirmed || 0}`]
  ];

  return `<section class="card">
    <h2>Embudo general de campañas Meta</h2>
    <div class="grid">
      ${items.map(([label, rate, detail]) => `<div><strong>${escapeHtml(rate)}</strong><br><span class="muted">${escapeHtml(label)} · ${escapeHtml(detail)}</span></div>`).join('')}
    </div>
  </section>`;
}

function renderUnmatchedMetaCandidates(candidates = []) {
  if (!candidates.length) {
    return `<section class="card"><h2>Metadata Meta sin campaña asociada</h2><p>No hay candidatos Meta pendientes de asociación en el rango seleccionado.</p></section>`;
  }

  const rows = candidates.map((candidate) => `<tr>
    <td>${escapeHtml(candidate.fullName || 'Sin nombre')}<br><span class="muted">${escapeHtml(candidate.phone || '')}</span></td>
    <td>${escapeHtml(candidate.vacancy?.title || 'Sin vacante')}</td>
    <td><span class="muted">${escapeHtml(String(candidate.campaignCodeRaw || '').slice(0, 220))}</span></td>
  </tr>`).join('');

  return `<section class="card">
    <h2>Metadata Meta sin campaña asociada</h2>
    <p>Estos candidatos llegaron con evidencia de pauta Meta, pero todavía no coinciden con una campaña interna. Úsalos para ajustar el ID, nombre o notas de la campaña.</p>
    <div style="overflow-x:auto;">
      <table>
        <thead><tr><th>Candidato</th><th>Vacante</th><th>Metadata recibida</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderCampaignForm({ vacancies = [] }) {
  const vacancyOptions = vacancies
    .map((vacancy) => `<option value="${escapeHtml(vacancy.id)}">${escapeHtml(vacancy.title)} — ${escapeHtml(vacancy.city)}</option>`)
    .join('');

  return `<section class="card">
    <h2>Nueva campaña interna</h2>
    <p class="muted">Este dato no se le pide al candidato. Usa un ID interno de campaña/anuncio, nombre de anuncio o etiqueta administrativa que pueda compararse con los metadatos entrantes de WhatsApp.</p>
    <form method="post" action="/admin/v2/campaigns">
      <div class="grid">
        <label>ID / código interno
          <input name="code" placeholder="META-AD-238000000000000" required maxlength="80">
        </label>
        <label>Nombre
          <input name="name" placeholder="Auxiliar Bogotá - pauta junio" required maxlength="120">
        </label>
        <label>Vacante asociada
          <select name="vacancyId">
            <option value="">Sin vacante específica</option>
            ${vacancyOptions}
          </select>
        </label>
        <label>Ciudad
          <input name="city" placeholder="Bogotá">
        </label>
        <label>Zona
          <input name="zone" placeholder="Montevideo, Siberia, Ibagué...">
        </label>
      </div>
      <label style="margin-top:12px;">Notas / nombres alternos
        <textarea name="notes" placeholder="Nombre del anuncio, URL de pauta, hipótesis, público o presupuesto"></textarea>
      </label>
      <div style="margin-top:12px;"><button type="submit">Crear campaña</button></div>
    </form>
  </section>`;
}

function renderCampaignTable(campaigns = []) {
  if (!campaigns.length) {
    return `<section class="card"><h2>Campañas registradas</h2><p>Aún no hay campañas registradas.</p></section>`;
  }

  const rows = campaigns.map((campaign) => {
    const metric = buildCampaignMetric(campaign);
    return `<tr>
      <td><strong>${escapeHtml(campaign.name)}</strong><br><span class="badge">${escapeHtml(campaign.code)}</span><br><span class="muted">${escapeHtml(campaign.city || 'Sin ciudad')} ${campaign.zone ? '· ' + escapeHtml(campaign.zone) : ''}</span></td>
      <td>${escapeHtml(campaign.vacancy?.title || 'Sin vacante')}</td>
      <td>${escapeHtml(CAMPAIGN_SOURCE_LABEL)}<br><span class="muted">${metric.inferredAttributions} inferidos por metadatos Meta</span></td>
      <td><strong>${metric.conversationsStarted}</strong><br><span class="muted">conversaciones</span></td>
      <td><strong>${metric.dataCompleted}</strong><br><span class="muted">${conversionRate(metric.dataCompleted, metric.conversationsStarted)} de conversaciones</span></td>
      <td><strong>${metric.cvReceived}</strong><br><span class="muted">HV recibidas</span></td>
      <td><strong>${metric.apt}</strong><br><span class="muted">aptos</span></td>
      <td><strong>${metric.scheduled}</strong><br><span class="muted">agendados</span></td>
      <td><strong>${metric.confirmed}</strong><br><span class="muted">confirmados</span></td>
      <td><strong>${metric.attended}</strong><br><span class="muted">asistieron</span></td>
      <td><strong>${metric.hired}</strong><br><span class="muted">contratados</span></td>
      <td><strong>${metric.pendingCv}</strong><br><span class="muted">pend. HV</span></td>
    </tr>`;
  }).join('');

  return `<section class="card">
    <h2>Campañas registradas</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Campaña</th>
            <th>Vacante</th>
            <th>Origen de pauta</th>
            <th>Conversaciones</th>
            <th>Datos completos</th>
            <th>HV</th>
            <th>Aptos</th>
            <th>Agendados</th>
            <th>Confirmados</th>
            <th>Asistieron</th>
            <th>Contratados</th>
            <th>Pend. HV</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

async function loadCampaignDashboardData(prisma, query = {}) {
  const range = dateRangeFromQuery(query);
  const filters = {
    from: range.from,
    to: range.to,
    city: normalizeString(query.city),
    vacancyId: normalizeString(query.vacancyId)
  };
  const campaignWhere = {
    ...(filters.city ? { city: { contains: filters.city, mode: 'insensitive' } } : {}),
    ...(filters.vacancyId ? { vacancyId: filters.vacancyId } : {})
  };
  const candidateWhere = {
    ...candidateCreatedAtWhere(range),
    ...(filters.vacancyId ? { vacancyId: filters.vacancyId } : {})
  };

  const [campaigns, vacancies, candidates] = await Promise.all([
    prisma.campaign.findMany({
      where: campaignWhere,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      include: {
        vacancy: { select: { id: true, title: true, city: true } }
      }
    }),
    prisma.vacancy.findMany({
      where: { isActive: true },
      orderBy: [{ city: 'asc' }, { title: 'asc' }],
      select: { id: true, title: true, city: true }
    }),
    prisma.candidate.findMany({
      where: candidateWhere,
      include: {
        vacancy: { select: { id: true, title: true, city: true } },
        interviewBookings: { select: { status: true } },
        messages: {
          where: { direction: 'INBOUND' },
          orderBy: { createdAt: 'asc' },
          take: 5,
          select: { body: true, rawPayload: true, createdAt: true }
        }
      }
    })
  ]);

  const filteredCandidates = filters.city
    ? candidates.filter((candidate) => (candidate.vacancy?.city || '').toLowerCase().includes(filters.city.toLowerCase()))
    : candidates;

  const enrichedCampaigns = enrichCampaignsWithAttribution(campaigns, filteredCandidates);
  return {
    campaigns: enrichedCampaigns,
    vacancies,
    filters,
    unmatchedMetaCandidates: buildUnmatchedMetaCandidates(filteredCandidates)
  };
}

export function lorenV2Router(prisma) {
  const router = express.Router();

  router.use(requireLorenV2);

  router.get('/', (req, res) => {
    const body = `<section class="card">
      <h1>Loren V2</h1>
      <p>Modulo habilitado para desarrollo y liberacion controlada.</p>
      <div class="grid">
        <a class="btn" href="/admin/v2/campaigns">Campañas y estadísticas</a>
      </div>
    </section>
    <section class="card">
      <h2>Funciones planeadas</h2>
      <ul>
        <li>Campañas y estadisticas</li>
        <li>Referidos y recomendados</li>
        <li>Resumen diario y reportes</li>
        <li>Extraccion inteligente de hojas de vida</li>
        <li>Alertas automaticas</li>
        <li>Check-in operativo</li>
        <li>Validacion documental asistida</li>
      </ul>
    </section>`;
    res.send(renderLayout({ title: 'Loren V2', body }));
  });

  router.get('/status', (req, res) => {
    res.json({
      ok: true,
      lorenV2: true,
      canSeeLorenV2: canSeeLorenV2(req),
      userRole: req.userRole || null,
      username: req.username || null,
      userAccessScope: req.userAccessScope || null
    });
  });

  router.get('/campaigns', async (req, res) => {
    const { campaigns, vacancies, filters, unmatchedMetaCandidates } = await loadCampaignDashboardData(prisma, req.query);
    const message = normalizeString(req.query.message);
    const error = normalizeString(req.query.error);
    const body = `${message ? `<div class="alert alert-success">${escapeHtml(message)}</div>` : ''}${error ? `<div class="alert alert-error">${escapeHtml(error)}</div>` : ''}
      <section class="card">
        <h1>Campañas y estadísticas</h1>
        <p>La atribución no depende de que el candidato escriba códigos. Loren V2 cruza candidatos con campañas usando asociación directa y metadatos internos del mensaje entrante, especialmente datos de referencia enviados por WhatsApp cuando el chat nace desde pauta.</p>
      </section>
      ${renderCampaignFilters({ filters, vacancies })}
      ${renderCampaignFunnel(campaigns)}
      ${renderCampaignForm({ vacancies })}
      ${renderCampaignTable(campaigns)}
      ${renderUnmatchedMetaCandidates(unmatchedMetaCandidates)}`;
    res.send(renderLayout({ title: 'Campañas Loren V2', body }));
  });

  router.get('/campaigns.json', async (req, res) => {
    const { campaigns, filters, unmatchedMetaCandidates } = await loadCampaignDashboardData(prisma, req.query);
    res.json({
      ok: true,
      filters,
      unmatchedMetaCandidates: unmatchedMetaCandidates.length,
      campaigns: campaigns.map((campaign) => ({
        id: campaign.id,
        code: campaign.code,
        name: campaign.name,
        sourceType: CAMPAIGN_SOURCE_TYPE,
        city: campaign.city,
        zone: campaign.zone,
        vacancy: campaign.vacancy,
        metrics: buildCampaignMetric(campaign)
      }))
    });
  });

  router.post('/campaigns', async (req, res) => {
    const code = normalizeCampaignCode(req.body.code);
    const name = normalizeString(req.body.name);
    if (!isValidCampaignCode(code)) {
      return res.redirect('/admin/v2/campaigns?error=' + encodeURIComponent('El ID o código interno debe tener entre 3 y 80 caracteres, usando letras, números, guion o guion bajo.'));
    }
    if (!name) {
      return res.redirect('/admin/v2/campaigns?error=' + encodeURIComponent('El nombre de la campaña es obligatorio.'));
    }

    await prisma.campaign.create({
      data: {
        code,
        name,
        sourceType: CAMPAIGN_SOURCE_TYPE,
        vacancyId: normalizeString(req.body.vacancyId),
        city: normalizeString(req.body.city),
        zone: normalizeString(req.body.zone),
        notes: normalizeString(req.body.notes),
        createdByUsername: req.username || null
      }
    });

    return res.redirect('/admin/v2/campaigns?message=' + encodeURIComponent('Campaña creada correctamente.'));
  });

  return router;
}
