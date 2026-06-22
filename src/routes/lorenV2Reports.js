import express from 'express';
import { requireLorenV2 } from '../services/lorenV2Gate.js';
import { buildLorenV2ReportsWorkbook } from '../services/lorenV2ReportsWorkbook.js';

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function number(value) {
  return Number(value || 0);
}

function rate(part, total) {
  if (!total) return '0%';
  return `${Math.round((number(part) / number(total)) * 100)}%`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeZone: 'America/Bogota'
  }).format(new Date(value));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Bogota'
  }).format(new Date(value));
}

function toBogotaDay(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

function addDays(day, offset) {
  const date = new Date(`${day}T00:00:00-05:00`);
  date.setUTCDate(date.getUTCDate() + offset);
  return toBogotaDay(date);
}

function startOfWeek(day) {
  const date = new Date(`${day}T12:00:00-05:00`);
  const jsDay = date.getUTCDay();
  const diffToMonday = jsDay === 0 ? -6 : 1 - jsDay;
  return addDays(day, diffToMonday);
}

function startOfMonth(day) {
  return `${day.slice(0, 7)}-01`;
}

function endOfMonth(day) {
  const [year, month] = day.split('-').map(Number);
  const end = new Date(Date.UTC(year, month, 0, 17, 0, 0));
  return toBogotaDay(end);
}

function rangeFor(period = 'week', dateValue = new Date()) {
  const day = toBogotaDay(dateValue);
  const safePeriod = period === 'month' ? 'month' : 'week';
  const startDay = safePeriod === 'month' ? startOfMonth(day) : startOfWeek(day);
  const endDay = safePeriod === 'month' ? endOfMonth(day) : addDays(startDay, 6);
  return {
    period: safePeriod,
    startDay,
    endDay,
    start: new Date(`${startDay}T00:00:00-05:00`),
    end: new Date(`${endDay}T23:59:59.999-05:00`)
  };
}

function hasCv(candidate = {}) {
  return Boolean(candidate.cvStorageKey || candidate.cvData || candidate.cvOriginalName);
}

function dayKey(value) {
  return toBogotaDay(value);
}

function groupCount(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item) || 'Sin clasificar';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function buildDailyRows(candidates = [], bookings = []) {
  const days = new Map();
  for (const candidate of candidates) {
    const key = dayKey(candidate.createdAt);
    const row = days.get(key) || { day: key, newCandidates: 0, withCv: 0, pendingCv: 0, humanReview: 0, scheduled: 0, confirmed: 0, attended: 0, noShow: 0 };
    row.newCandidates += 1;
    if (hasCv(candidate)) row.withCv += 1;
    if (candidate.fullName && candidate.documentNumber && !hasCv(candidate)) row.pendingCv += 1;
    if (candidate.potentialDuplicate || candidate.botPaused || candidate.rejectionDetails) row.humanReview += 1;
    days.set(key, row);
  }

  for (const booking of bookings) {
    const key = dayKey(booking.scheduledAt);
    const row = days.get(key) || { day: key, newCandidates: 0, withCv: 0, pendingCv: 0, humanReview: 0, scheduled: 0, confirmed: 0, attended: 0, noShow: 0 };
    if (['SCHEDULED', 'CONFIRMED', 'ATTENDED', 'NO_SHOW'].includes(booking.status)) row.scheduled += 1;
    if (['CONFIRMED', 'ATTENDED'].includes(booking.status)) row.confirmed += 1;
    if (booking.status === 'ATTENDED') row.attended += 1;
    if (booking.status === 'NO_SHOW') row.noShow += 1;
    days.set(key, row);
  }

  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function buildMetrics(candidates = [], bookings = []) {
  const scheduled = bookings.filter((booking) => ['SCHEDULED', 'CONFIRMED', 'ATTENDED', 'NO_SHOW'].includes(booking.status)).length;
  const confirmed = bookings.filter((booking) => ['CONFIRMED', 'ATTENDED'].includes(booking.status)).length;
  const attended = bookings.filter((booking) => booking.status === 'ATTENDED').length;
  const noShow = bookings.filter((booking) => booking.status === 'NO_SHOW').length;

  return {
    newCandidates: candidates.length,
    withCv: candidates.filter(hasCv).length,
    pendingCv: candidates.filter((candidate) => candidate.fullName && candidate.documentNumber && !hasCv(candidate)).length,
    approved: candidates.filter((candidate) => ['APROBADO', 'CONTRATADO'].includes(candidate.status)).length,
    rejected: candidates.filter((candidate) => candidate.status === 'RECHAZADO').length,
    scheduled,
    confirmed,
    attended,
    noShow,
    humanReview: candidates.filter((candidate) => candidate.potentialDuplicate || candidate.botPaused || candidate.rejectionDetails).length,
    cvRate: rate(candidates.filter(hasCv).length, candidates.length),
    attendanceRate: rate(attended, scheduled),
    noShowRate: rate(noShow, scheduled)
  };
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
    .navbar { background: #1e2d3d; padding: 0 24px; display: flex; align-items: center; gap: 20px; min-height: 52px; flex-wrap: wrap; }
    .navbar a { color: #cbd5e0; text-decoration: none; font-size: 13px; font-weight: 600; }
    .navbar a:hover { color: #fff; }
    .navbar .spacer { flex: 1; }
    .page { max-width: 1280px; margin: 0 auto; padding: 24px 20px 48px; }
    .card { background: #fff; border: 1px solid #e1e4e8; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 18px; margin-bottom: 18px; }
    h1 { font-size: 22px; margin: 0 0 6px; color: #1e2d3d; }
    h2 { font-size: 16px; margin: 0 0 12px; color: #1e2d3d; }
    p { color: #6b7280; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .metric { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px; }
    .metric strong { display: block; font-size: 24px; color: #1e2d3d; }
    .metric span { color: #6b7280; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 700; color: #6b7280; }
    input, select { border: 1px solid #e1e4e8; border-radius: 8px; padding: 8px 10px; font-size: 14px; font-family: inherit; }
    button, .btn { border: 0; border-radius: 8px; padding: 9px 14px; background: #0d7a6b; color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; background: #f9fafb; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #eaecef; vertical-align: top; }
    .muted { color: #6b7280; font-size: 12px; }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/admin">Panel</a>
    <a href="/admin/v2">Loren V2</a>
    <a href="/admin/v2/campaigns">Campañas</a>
    <a href="/admin/v2/referrals">Referidos</a>
    <a href="/admin/v2/daily-summary">Resumen diario</a>
    <a href="/admin/v2/reports">Reportes</a>
    <span class="spacer"></span>
    <a href="/logout">Cerrar sesión</a>
  </nav>
  <main class="page">${body}</main>
</body>
</html>`;
}

function renderFilters(report = {}) {
  const downloadQuery = new URLSearchParams({ period: report.period, date: report.baseDay }).toString();
  return `<section class="card">
    <h1>Reportes semanales y mensuales</h1>
    <p>Rango: <strong>${escapeHtml(report.startDay)}</strong> a <strong>${escapeHtml(report.endDay)}</strong>. Los cálculos usan horario de Bogotá.</p>
    <form method="get" action="/admin/v2/reports" class="grid">
      <label>Periodo
        <select name="period">
          <option value="week" ${report.period === 'week' ? 'selected' : ''}>Semanal</option>
          <option value="month" ${report.period === 'month' ? 'selected' : ''}>Mensual</option>
        </select>
      </label>
      <label>Fecha base
        <input type="date" name="date" value="${escapeHtml(report.baseDay)}">
      </label>
      <label>&nbsp;<button type="submit">Actualizar reporte</button></label>
      <label>&nbsp;<a class="btn" href="/admin/v2/reports/xlsx?${escapeHtml(downloadQuery)}">Descargar Excel bonito</a></label>
    </form>
  </section>`;
}

function renderMetrics(metrics = {}) {
  const items = [
    ['Candidatos', metrics.newCandidates],
    ['Con HV', metrics.withCv],
    ['Tasa HV', metrics.cvRate],
    ['Pendientes HV', metrics.pendingCv],
    ['Aprobados', metrics.approved],
    ['Rechazados', metrics.rejected],
    ['Agendados', metrics.scheduled],
    ['Confirmados', metrics.confirmed],
    ['Asistieron', metrics.attended],
    ['Tasa asistencia', metrics.attendanceRate],
    ['No show', metrics.noShow],
    ['Tasa no show', metrics.noShowRate],
    ['Revisión humana', metrics.humanReview]
  ];

  return `<section class="card">
    <h2>Resumen ejecutivo</h2>
    <div class="grid">
      ${items.map(([label, value]) => `<div class="metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('')}
    </div>
  </section>`;
}

function renderTable(title, headers, rows, renderRow) {
  if (!rows.length) return `<section class="card"><h2>${escapeHtml(title)}</h2><p>No hay datos para este reporte.</p></section>`;
  return `<section class="card">
    <h2>${escapeHtml(title)}</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(renderRow).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

async function loadReport(prisma, query = {}) {
  const period = query.period === 'month' ? 'month' : 'week';
  const baseDay = toBogotaDay(query.date || new Date());
  const range = rangeFor(period, baseDay);

  const [candidates, bookings] = await Promise.all([
    prisma.candidate.findMany({
      where: { createdAt: { gte: range.start, lte: range.end } },
      orderBy: { createdAt: 'asc' },
      take: 5000,
      include: {
        vacancy: { select: { id: true, title: true, city: true } },
        campaign: { select: { id: true, name: true, code: true, sourceType: true } }
      }
    }),
    prisma.interviewBooking.findMany({
      where: { scheduledAt: { gte: range.start, lte: range.end } },
      orderBy: { scheduledAt: 'asc' },
      take: 5000,
      include: {
        candidate: { select: { id: true, fullName: true, phone: true } },
        vacancy: { select: { id: true, title: true, city: true } }
      }
    })
  ]);

  return {
    ...range,
    baseDay,
    metrics: buildMetrics(candidates, bookings),
    dailyRows: buildDailyRows(candidates, bookings),
    byVacancy: groupCount(candidates, (candidate) => candidate.vacancy?.title || 'Sin vacante'),
    byCampaign: groupCount(candidates, (candidate) => candidate.campaign?.name || candidate.referrerName || candidate.sourceType || 'Sin origen'),
    latestCandidates: candidates.slice(-50).reverse(),
    latestBookings: bookings.slice(-50).reverse()
  };
}

function renderReport(report = {}) {
  return `${renderFilters(report)}
  ${renderMetrics(report.metrics)}
  ${renderTable('Desglose por día', ['Día', 'Candidatos', 'HV', 'Pend. HV', 'Agendados', 'Confirmados', 'Asistieron', 'No show', 'Revisión'], report.dailyRows, (row) => `<tr><td>${escapeHtml(row.day)}</td><td>${row.newCandidates}</td><td>${row.withCv}</td><td>${row.pendingCv}</td><td>${row.scheduled}</td><td>${row.confirmed}</td><td>${row.attended}</td><td>${row.noShow}</td><td>${row.humanReview}</td></tr>`)}
  ${renderTable('Candidatos por vacante', ['Vacante', 'Candidatos'], report.byVacancy, (row) => `<tr><td>${escapeHtml(row.label)}</td><td>${row.count}</td></tr>`)}
  ${renderTable('Candidatos por campaña / origen', ['Origen', 'Candidatos'], report.byCampaign, (row) => `<tr><td>${escapeHtml(row.label)}</td><td>${row.count}</td></tr>`)}
  ${renderTable('Últimos candidatos del rango', ['Registro', 'Candidato', 'Vacante', 'Estado', 'Origen'], report.latestCandidates, (candidate) => `<tr><td>${formatDate(candidate.createdAt)}</td><td>${escapeHtml(candidate.fullName || 'Sin nombre')}<br><span class="muted">${escapeHtml(candidate.phone || '')}</span></td><td>${escapeHtml(candidate.vacancy?.title || 'Sin vacante')}</td><td>${escapeHtml(candidate.status)}</td><td>${escapeHtml(candidate.campaign?.name || candidate.referrerName || candidate.sourceType || 'Sin origen')}</td></tr>`)}
  ${renderTable('Últimas citas del rango', ['Fecha', 'Candidato', 'Vacante', 'Estado'], report.latestBookings, (booking) => `<tr><td>${formatDateTime(booking.scheduledAt)}</td><td>${escapeHtml(booking.candidate?.fullName || 'Sin nombre')}<br><span class="muted">${escapeHtml(booking.candidate?.phone || '')}</span></td><td>${escapeHtml(booking.vacancy?.title || 'Sin vacante')}</td><td>${escapeHtml(booking.status)}</td></tr>`)}`;
}

export function lorenV2ReportsRouter(prisma) {
  const router = express.Router();
  router.use(requireLorenV2);

  router.get('/', async (req, res) => {
    const report = await loadReport(prisma, req.query);
    res.send(renderLayout({ title: 'Reportes Loren V2', body: renderReport(report) }));
  });

  router.get('/json', async (req, res) => {
    const report = await loadReport(prisma, req.query);
    res.json({ ok: true, ...report });
  });

  router.get('/xlsx', async (req, res) => {
    const { workbook, data } = await buildLorenV2ReportsWorkbook(prisma, req.query);
    const fileName = `loren-v2-${data.period}-${data.startDay}-${data.endDay}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    res.end();
  });

  return router;
}
