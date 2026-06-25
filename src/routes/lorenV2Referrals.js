import express from 'express';
import { canSeeLorenV2, requireLorenV2 } from '../services/lorenV2Gate.js';

// ─── Utilidades ────────────────────────────────────────────────────────────────

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

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Bogota'
    }).format(new Date(value));
  } catch (_e) {
    return String(value);
  }
}

function conversionRate(part, total) {
  if (!total) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

function hasCandidateData(c = {}) {
  return Boolean(c.fullName || c.documentNumber || c.age || c.neighborhood);
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

function hasAttendedBooking(c = {}) {
  return (c.interviewBookings || []).some((b) => b.status === 'ATTENDED');
}

// ─── Layout ────────────────────────────────────────────────────────────────────

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
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
    .card-title { font-size: 13px; font-weight: 700; color: #1e2d3d; margin-bottom: 14px; text-transform: uppercase; letter-spacing: .04em; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .grid-auto { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .grid-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; align-items: end; }
    .kpi { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; }
    .kpi-value { font-size: 28px; font-weight: 800; color: #1e2d3d; line-height: 1; }
    .kpi-label { font-size: 11px; color: #64748b; margin-top: 4px; font-weight: 500; }
    .kpi-rate { font-size: 11px; color: #0d7a6b; font-weight: 700; margin-top: 2px; }
    .kpi.accent { border-color: #0d7a6b33; background: #f0faf8; }
    .kpi.accent .kpi-value { color: #0d7a6b; }
    .kpi.warn { border-color: #f59e0b33; background: #fffbeb; }
    .kpi.warn .kpi-value { color: #b45309; }
    .kpi.danger { border-color: #fca5a544; background: #fff5f5; }
    .kpi.danger .kpi-value { color: #dc2626; }
    .kpi.purple { border-color: #a78bfa44; background: #f5f3ff; }
    .kpi.purple .kpi-value { color: #7c3aed; }
    .funnel { display: flex; align-items: stretch; gap: 0; margin: 4px 0; overflow-x: auto; }
    .funnel-step { flex: 1; min-width: 90px; text-align: center; padding: 12px 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-right: none; position: relative; }
    .funnel-step:first-child { border-radius: 8px 0 0 8px; }
    .funnel-step:last-child { border-right: 1px solid #e2e8f0; border-radius: 0 8px 8px 0; }
    .funnel-step.highlight { background: #f0faf8; border-color: #0d7a6b44; }
    .funnel-step-value { font-size: 22px; font-weight: 800; color: #1e2d3d; }
    .funnel-step-label { font-size: 10px; color: #64748b; margin-top: 2px; font-weight: 500; line-height: 1.3; }
    .funnel-step-rate { font-size: 10px; color: #0d7a6b; font-weight: 700; margin-top: 3px; }
    .funnel-arrow { align-self: center; color: #cbd5e1; font-size: 16px; padding: 0 2px; flex-shrink: 0; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: #475569; }
    input, select, textarea { border: 1px solid #cbd5e1; border-radius: 7px; padding: 8px 10px; font-size: 13px; font-family: inherit; color: #1a1d23; background: #fff; width: 100%; transition: border-color .15s; }
    input:focus, select:focus { outline: none; border-color: #0d7a6b; box-shadow: 0 0 0 3px #0d7a6b18; }
    .btn { display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 7px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none; transition: all .15s; }
    .btn-primary { background: #0d7a6b; color: #fff; }
    .btn-primary:hover { background: #0b6559; }
    .btn-secondary { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; }
    .btn-secondary:hover { background: #e2e8f0; }
    .btn-sm { padding: 5px 10px; font-size: 12px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #64748b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; background: #f8fafc; padding: 9px 10px; border-bottom: 2px solid #e2e8f0; white-space: nowrap; }
    td { padding: 10px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
    tr:hover td { background: #f8fafc; }
    tr:last-child td { border-bottom: 0; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-weight: 700; font-size: 11px; line-height: 1.4; }
    .badge-green { background: #dcfce7; color: #15803d; }
    .badge-blue { background: #dbeafe; color: #1d4ed8; }
    .badge-gray { background: #f1f5f9; color: #475569; }
    .badge-red { background: #fee2e2; color: #dc2626; }
    .badge-amber { background: #fef3c7; color: #92400e; }
    .badge-teal { background: #e6f4f1; color: #0d7a6b; }
    .badge-purple { background: #f5f3ff; color: #7c3aed; }
    .muted { color: #64748b; font-size: 12px; }
    .text-sm { font-size: 12px; }
    .text-xs { font-size: 11px; }
    .fw-700 { font-weight: 700; }
    .mt-4 { margin-top: 16px; }
    .flex { display: flex; align-items: center; gap: 8px; }
    .alert { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-weight: 600; font-size: 13px; }
    .alert-info { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
    .alert-success { background: #dcfce7; color: #16a34a; border: 1px solid #86efac; }
    .alert-error { background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; }
    .section-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #94a3b8; margin-bottom: 10px; }
    .divider { border: none; border-top: 1px solid #e2e8f0; margin: 20px 0; }
    .empty-state { text-align: center; padding: 40px 20px; color: #94a3b8; }
    .empty-state p { font-size: 13px; margin-top: 6px; }
    .referrer-cell { display: flex; flex-direction: column; gap: 2px; }
    .referrer-name { font-weight: 700; color: #1e2d3d; font-size: 13px; }
    .referrer-phone { font-size: 11px; color: #64748b; }
    .top-referrers-list { display: flex; flex-direction: column; gap: 8px; }
    .top-ref-item { display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; }
    .top-ref-name { font-weight: 700; font-size: 13px; color: #1e2d3d; }
    .top-ref-phone { font-size: 11px; color: #64748b; }
    .top-ref-count { background: #e6f4f1; color: #0d7a6b; font-weight: 800; font-size: 14px; border-radius: 999px; padding: 3px 10px; min-width: 32px; text-align: center; }
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
    <a href="/admin/v2/referrals" class="active">Referidos</a>
    <span class="spacer"></span>
    <a href="/logout">Cerrar sesión</a>
  </nav>
  <main class="page">${body}</main>
</body>
</html>`;
}

// ─── Métricas de referidos ─────────────────────────────────────────────────────

function buildReferralMetrics(candidates = []) {
  const total = candidates.length;
  const startedProcess = candidates.filter(hasCandidateData).length;
  const dataCompleted = candidates.filter(hasCompleteCoreData).length;
  const cvReceived = candidates.filter(hasCv).length;
  const apt = candidates.filter((c) => ['APROBADO', 'CONTRATADO'].includes(c.status)).length;
  const hired = candidates.filter((c) => c.status === 'CONTRATADO').length;
  const rejected = candidates.filter((c) => c.status === 'RECHAZADO').length;
  const scheduled = candidates.filter(hasBooking).length;
  const attended = candidates.filter(hasAttendedBooking).length;

  // Top referidores
  const referrerMap = {};
  for (const c of candidates) {
    const key = c.referrerPhone || c.referrerName;
    if (!key) continue;
    if (!referrerMap[key]) {
      referrerMap[key] = { name: c.referrerName || 'Desconocido', phone: c.referrerPhone || '', count: 0, hired: 0 };
    }
    referrerMap[key].count += 1;
    if (c.status === 'CONTRATADO') referrerMap[key].hired += 1;
  }
  const topReferrers = Object.values(referrerMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return { total, startedProcess, dataCompleted, cvReceived, apt, hired, rejected, scheduled, attended, topReferrers };
}

// ─── Render: KPIs y embudo ─────────────────────────────────────────────────────

function renderKpisAndFunnel(metrics) {
  const { total, startedProcess, dataCompleted, cvReceived, apt, hired, rejected, scheduled, attended } = metrics;

  const steps = [
    { label: 'Conversaciones', value: total, rate: null, cls: '' },
    { label: 'Inició proceso', value: startedProcess, rate: conversionRate(startedProcess, total), cls: '' },
    { label: 'Datos completos', value: dataCompleted, rate: conversionRate(dataCompleted, total), cls: '' },
    { label: 'HV recibida', value: cvReceived, rate: conversionRate(cvReceived, total), cls: '' },
    { label: 'Aptos', value: apt, rate: conversionRate(apt, cvReceived || 1), cls: 'highlight' },
    { label: 'Contratados', value: hired, rate: conversionRate(hired, total), cls: 'highlight' }
  ];

  if (scheduled > 0) {
    steps.splice(5, 0,
      { label: 'Agendados', value: scheduled, rate: conversionRate(scheduled, apt), cls: '' },
      { label: 'Asistieron', value: attended, rate: conversionRate(attended, scheduled), cls: '' }
    );
  }

  const funnelHtml = steps.map((s, i) => {
    const arrow = i < steps.length - 1 ? '<span class="funnel-arrow">›</span>' : '';
    return `<div class="funnel-step ${s.cls}">
      <div class="funnel-step-value">${s.value}</div>
      <div class="funnel-step-label">${escapeHtml(s.label)}</div>
      ${s.rate ? `<div class="funnel-step-rate">${s.rate}</div>` : ''}
    </div>${arrow}`;
  }).join('');

  // Tasa de conversión a contratado vs campaña Meta (referencia visual)
  const convHired = total ? `${Math.round((hired / total) * 100)}%` : '—';
  const convCv = total ? `${Math.round((cvReceived / total) * 100)}%` : '—';

  return `
  <section class="card">
    <div class="card-title">Embudo de conversión — referidos</div>
    <div class="funnel">${funnelHtml}</div>
    <hr class="divider">
    <div class="grid-auto" style="margin-top:0">
      <div class="kpi accent"><div class="kpi-value">${total}</div><div class="kpi-label">Total referidos detectados</div><div class="kpi-rate">Fuente: frases en conversación</div></div>
      <div class="kpi"><div class="kpi-value">${cvReceived}</div><div class="kpi-label">HV recibidas</div><div class="kpi-rate">${convCv} tasa de HV</div></div>
      <div class="kpi"><div class="kpi-value">${apt}</div><div class="kpi-label">Candidatos aptos</div><div class="kpi-rate">${conversionRate(apt, cvReceived || 1)} de HV recibidas</div></div>
      <div class="kpi accent"><div class="kpi-value">${hired}</div><div class="kpi-label">Contratados</div><div class="kpi-rate">${convHired} tasa de conversión final</div></div>
      <div class="kpi${rejected > 0 ? ' danger' : ''}"><div class="kpi-value">${rejected}</div><div class="kpi-label">Rechazados</div><div class="kpi-rate">${conversionRate(rejected, total)} del total</div></div>
    </div>
  </section>`;
}

// ─── Render: Top referidores ───────────────────────────────────────────────────

function renderTopReferrers(topReferrers = []) {
  if (!topReferrers.length) return '';

  const items = topReferrers.map((r) => `
    <div class="top-ref-item">
      <div>
        <div class="top-ref-name">${escapeHtml(r.name)}</div>
        <div class="top-ref-phone">${escapeHtml(r.phone || 'Sin teléfono registrado')}</div>
        ${r.hired > 0 ? `<span class="badge badge-teal" style="margin-top:3px">${r.hired} contratado${r.hired > 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="top-ref-count">${r.count}</div>
    </div>`).join('');

  return `
  <section class="card">
    <div class="card-title">Top referidores</div>
    <div class="alert alert-info" style="margin-bottom:12px;font-weight:400;font-size:12px">Personas que más han recomendado candidatos al proceso. El número indica cuántos candidatos han llegado por esa persona.</div>
    <div class="top-referrers-list">${items}</div>
  </section>`;
}

// ─── Render: Tabla de candidatos ──────────────────────────────────────────────

function renderReferralsTable(candidates = []) {
  if (!candidates.length) {
    return `<section class="card">
      <div class="card-title">Candidatos referidos</div>
      <div class="empty-state">
        <div style="font-size:32px">🔗</div>
        <p>Aún no hay candidatos detectados como referidos o recomendados.</p>
        <p class="text-xs" style="margin-top:8px;color:#94a3b8">Loren detecta frases como "vengo referido por…", "me recomendó…", "de parte de…"</p>
      </div>
    </section>`;
  }

  function statusBadge(status) {
    const map = {
      NUEVO: 'badge-gray', REGISTRADO: 'badge-blue', VALIDANDO: 'badge-amber',
      APROBADO: 'badge-green', RECHAZADO: 'badge-red',
      CONTACTADO: 'badge-blue', CONTRATADO: 'badge-teal'
    };
    return `<span class="badge ${map[status] || 'badge-gray'}">${escapeHtml(status)}</span>`;
  }

  const rows = candidates.map((c) => {
    const flags = [
      hasCandidateData(c) ? '✓ Datos' : null,
      hasCv(c) ? '✓ HV' : null,
      hasBooking(c) ? '✓ Cita' : null,
      hasAttendedBooking(c) ? '✓ Asistió' : null,
      c.potentialDuplicate ? '⚠ Dup.' : null
    ].filter(Boolean).join(' · ');

    return `<tr>
      <td>
        <a href="/admin/candidates/${escapeHtml(c.id)}" style="color:#0d7a6b;text-decoration:none;font-weight:600">${escapeHtml(c.fullName || 'Sin nombre')}</a>
        <br><span class="muted">${escapeHtml(c.phone || '')}</span>
      </td>
      <td>
        <div class="referrer-cell">
          <span class="referrer-name">${escapeHtml(c.referrerName || 'Sin nombre detectado')}</span>
          <span class="referrer-phone">${escapeHtml(c.referrerPhone || '')}</span>
        </div>
      </td>
      <td>${escapeHtml(c.vacancy?.title || '—')}<br><span class="muted text-xs">${escapeHtml(c.vacancy?.city || '')}</span></td>
      <td>${statusBadge(c.status)}</td>
      <td class="muted text-xs">${escapeHtml(flags || '—')}</td>
      <td class="muted text-xs">${formatDate(c.createdAt)}</td>
      <td><a href="/admin/candidates/${escapeHtml(c.id)}" class="btn btn-secondary btn-sm">Ver →</a></td>
    </tr>`;
  }).join('');

  return `<section class="card">
    <div class="card-title">Candidatos referidos (${candidates.length})</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Candidato</th>
            <th>Referidor</th>
            <th>Vacante</th>
            <th>Estado</th>
            <th>Avance</th>
            <th>Registro</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

// ─── Render: Filtros ───────────────────────────────────────────────────────────

function renderFilters(filters = {}, vacancies = []) {
  const vacancyOptions = vacancies
    .map((v) => `<option value="${escapeHtml(v.id)}" ${filters.vacancyId === v.id ? 'selected' : ''}>${escapeHtml(v.title)} — ${escapeHtml(v.city)}</option>`)
    .join('');

  const statusOptions = ['NUEVO', 'REGISTRADO', 'VALIDANDO', 'APROBADO', 'RECHAZADO', 'CONTACTADO', 'CONTRATADO']
    .map((s) => `<option value="${s}" ${filters.status === s ? 'selected' : ''}>${s}</option>`)
    .join('');

  return `<section class="card">
    <div class="card-title">Filtros</div>
    <form method="get" action="/admin/v2/referrals" class="grid-form">
      <label>Desde <input type="date" name="from" value="${escapeHtml(filters.from || '')}"></label>
      <label>Hasta <input type="date" name="to" value="${escapeHtml(filters.to || '')}"></label>
      <label>Vacante
        <select name="vacancyId">
          <option value="">Todas las vacantes</option>
          ${vacancyOptions}
        </select>
      </label>
      <label>Estado
        <select name="status">
          <option value="">Todos los estados</option>
          ${statusOptions}
        </select>
      </label>
      <div><button type="submit" class="btn btn-primary">Aplicar filtros</button></div>
    </form>
  </section>`;
}

// ─── Carga de datos ────────────────────────────────────────────────────────────

async function loadReferralData(prisma, query = {}) {
  const range = dateRangeFromQuery(query);
  const filters = {
    from: range.from,
    to: range.to,
    vacancyId: normalizeString(query.vacancyId),
    status: normalizeString(query.status)
  };

  const where = {
    OR: [
      { sourceType: 'REFERRED' },
      { referrerName: { not: null } },
      { referrerPhone: { not: null } }
    ]
  };

  if (range.start || range.end) {
    where.createdAt = {};
    if (range.start) where.createdAt.gte = range.start;
    if (range.end) where.createdAt.lte = range.end;
  }
  if (filters.vacancyId) where.vacancyId = filters.vacancyId;
  if (filters.status) where.status = filters.status;

  const [candidates, vacancies] = await Promise.all([
    prisma.candidate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        phone: true,
        fullName: true,
        documentNumber: true,
        age: true,
        neighborhood: true,
        locality: true,
        sourceType: true,
        referrerName: true,
        referrerPhone: true,
        status: true,
        cvStorageKey: true,
        cvData: true,
        cvOriginalName: true,
        potentialDuplicate: true,
        botPaused: true,
        createdAt: true,
        vacancyId: true,
        vacancy: { select: { id: true, title: true, city: true } },
        interviewBookings: { select: { status: true } }
      }
    }),
    prisma.vacancy.findMany({
      where: { isActive: true },
      orderBy: [{ city: 'asc' }, { title: 'asc' }],
      select: { id: true, title: true, city: true }
    })
  ]);

  return { candidates, vacancies, filters };
}

// ─── Router ────────────────────────────────────────────────────────────────────

export function lorenV2ReferralsRouter(prisma) {
  const router = express.Router();

  router.use((req, _res, next) => {
    req.prisma = req.prisma || prisma;
    next();
  });

  // ── GET /admin/v2/referrals ──────────────────────────────────────────────────
  router.get('/', canSeeLorenV2, async (req, res) => {
    try {
      const { candidates, vacancies, filters } = await loadReferralData(prisma, req.query);
      const metrics = buildReferralMetrics(candidates);

      const hasFilters = filters.from || filters.to || filters.vacancyId || filters.status;
      const filterInfo = hasFilters
        ? `<div class="alert alert-info" style="margin-bottom:0;font-size:12px;font-weight:400">Mostrando resultados filtrados. <a href="/admin/v2/referrals" style="color:#1d4ed8;font-weight:600">Ver todos</a></div>`
        : '';

      const body = `
        <div class="page-header">
          <div class="flex" style="margin-bottom:8px">
            <h1>Referidos y recomendados</h1>
          </div>
          <p>Loren detecta automáticamente candidatos que llegan por recomendación, sin pedirles ningún código. Frases como "vengo referido por…", "me recomendó…" o "de parte de…" activan la detección.</p>
        </div>
        ${filterInfo ? `<div style="margin-bottom:16px">${filterInfo}</div>` : ''}
        ${renderFilters(filters, vacancies)}
        ${candidates.length ? renderKpisAndFunnel(metrics) : ''}
        ${metrics.topReferrers.length ? renderTopReferrers(metrics.topReferrers) : ''}
        ${renderReferralsTable(candidates)}`;

      res.send(renderLayout({ title: 'Referidos — Loren V2', body }));
    } catch (err) {
      console.error('[lorenV2Referrals GET]', err);
      res.status(500).send(renderLayout({
        title: 'Error',
        body: '<div class="alert alert-error">Error interno cargando los referidos. Intenta de nuevo.</div>'
      }));
    }
  });

  // ── GET /admin/v2/referrals/json ──────────────────────────────────────────────
  router.get('/json', canSeeLorenV2, async (req, res) => {
    try {
      const { candidates } = await loadReferralData(prisma, req.query);
      const metrics = buildReferralMetrics(candidates);
      res.json({ ok: true, total: candidates.length, metrics, candidates });
    } catch (err) {
      console.error('[lorenV2Referrals JSON]', err);
      res.status(500).json({ ok: false, error: 'Error interno' });
    }
  });

  return router;
}

export default lorenV2ReferralsRouter;
