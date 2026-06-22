import express from 'express';
import { canSeeLorenV2, requireLorenV2 } from '../services/lorenV2Gate.js';

const CAMPAIGN_SOURCE_OPTIONS = [
  { value: 'META_ADS', label: 'Meta / Facebook Ads' },
  { value: 'REFERRED', label: 'Referido / recomendado' },
  { value: 'MANUAL', label: 'Registro manual' },
  { value: 'OTHER', label: 'Otro' }
];

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

function renderCampaignForm({ vacancies = [] }) {
  const sourceOptions = CAMPAIGN_SOURCE_OPTIONS
    .map((option) => `<option value="${option.value}">${escapeHtml(option.label)}</option>`)
    .join('');
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
        <label>Fuente
          <select name="sourceType">${sourceOptions}</select>
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
      <td>${escapeHtml(campaign.sourceType)}<br><span class="muted">${metric.inferredAttributions} inferidos por metadatos</span></td>
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
            <th>Fuente</th>
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

async function loadCampaignDashboardData(prisma) {
  const [campaigns, vacancies, candidates] = await Promise.all([
    prisma.campaign.findMany({
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
      include: {
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

  return { campaigns: enrichCampaignsWithAttribution(campaigns, candidates), vacancies };
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
    const { campaigns, vacancies } = await loadCampaignDashboardData(prisma);
    const message = normalizeString(req.query.message);
    const error = normalizeString(req.query.error);
    const body = `${message ? `<div class="alert alert-success">${escapeHtml(message)}</div>` : ''}${error ? `<div class="alert alert-error">${escapeHtml(error)}</div>` : ''}
      <section class="card">
        <h1>Campañas y estadísticas</h1>
        <p>La atribución no depende de que el candidato escriba códigos. Loren V2 cruza candidatos con campañas usando asociación directa y metadatos internos del mensaje entrante, especialmente datos de referencia enviados por WhatsApp cuando el chat nace desde pauta.</p>
      </section>
      ${renderCampaignForm({ vacancies })}
      ${renderCampaignTable(campaigns)}`;
    res.send(renderLayout({ title: 'Campañas Loren V2', body }));
  });

  router.get('/campaigns.json', async (_req, res) => {
    const { campaigns } = await loadCampaignDashboardData(prisma);
    res.json({
      ok: true,
      campaigns: campaigns.map((campaign) => ({
        id: campaign.id,
        code: campaign.code,
        name: campaign.name,
        sourceType: campaign.sourceType,
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
    const sourceType = CAMPAIGN_SOURCE_OPTIONS.some((option) => option.value === req.body.sourceType)
      ? req.body.sourceType
      : 'META_ADS';

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
        sourceType,
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
