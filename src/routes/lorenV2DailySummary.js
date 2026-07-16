import express from 'express';
import { requireLorenV2 } from '../services/lorenV2Gate.js';
import {
  buildCandidateAccessWhere,
  buildVacancyAccessWhere,
  getAccessContext,
  hasFullAccess
} from '../services/appUsers.js';

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bogotaDayRange(dateValue = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const day = formatter.format(new Date(dateValue));
  return {
    label: day,
    start: new Date(`${day}T00:00:00-05:00`),
    end: new Date(`${day}T23:59:59.999-05:00`)
  };
}

function formatDate(value) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Bogota'
  }).format(new Date(value));
}

function hasCv(candidate = {}) {
  return Boolean(candidate.cvStorageKey || candidate.cvData || candidate.cvOriginalName);
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
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .metric { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px; }
    .metric strong { display: block; font-size: 24px; color: #1e2d3d; }
    .metric span { color: #6b7280; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; background: #f9fafb; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #eaecef; vertical-align: top; }
    .badge { display: inline-flex; border-radius: 999px; padding: 3px 8px; background: #e6f4f1; color: #0d7a6b; font-weight: 700; font-size: 11px; }
    .muted { color: #6b7280; font-size: 12px; }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/admin">Panel</a>
    <a href="/admin/estadisticas">Estadísticas</a>
    <span class="spacer"></span>
    <a href="/logout">Cerrar sesión</a>
  </nav>
  <main class="page">${body}</main>
</body>
</html>`;
}

function renderMetrics(metrics = {}) {
  const items = [
    ['Nuevos hoy', metrics.newCandidates],
    ['Con HV', metrics.withCv],
    ['Pendientes HV', metrics.pendingCv],
    ['Agendados hoy', metrics.scheduledToday],
    ['Confirmados hoy', metrics.confirmedToday],
    ['Asistieron hoy', metrics.attendedToday],
    ['No show hoy', metrics.noShowToday],
    ['Revisión humana', metrics.humanReview]
  ];

  return `<section class="card">
    <h2>Indicadores del día</h2>
    <div class="grid">
      ${items.map(([label, value]) => `<div class="metric"><strong>${Number(value || 0)}</strong><span>${escapeHtml(label)}</span></div>`).join('')}
    </div>
  </section>`;
}

function renderCandidateTable(title, candidates = []) {
  if (!candidates.length) return `<section class="card"><h2>${escapeHtml(title)}</h2><p>No hay registros para esta sección.</p></section>`;

  const rows = candidates.map((candidate) => `<tr>
    <td><strong>${escapeHtml(candidate.fullName || 'Sin nombre')}</strong><br><span class="muted">${escapeHtml(candidate.phone || '')}</span></td>
    <td>${escapeHtml(candidate.vacancy?.title || 'Sin vacante')}</td>
    <td><span class="badge">${escapeHtml(candidate.status)}</span><br><span class="muted">${hasCv(candidate) ? 'HV recibida' : 'Sin HV'}</span></td>
    <td>${escapeHtml(candidate.sourceType || 'UNKNOWN')}<br><span class="muted">${escapeHtml(candidate.referrerName || candidate.campaign?.name || '')}</span></td>
    <td>${formatDate(candidate.createdAt)}</td>
  </tr>`).join('');

  return `<section class="card">
    <h2>${escapeHtml(title)}</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr><th>Candidato</th><th>Vacante</th><th>Estado</th><th>Origen</th><th>Registro</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderBookingTable(title, bookings = []) {
  if (!bookings.length) return `<section class="card"><h2>${escapeHtml(title)}</h2><p>No hay citas para esta sección.</p></section>`;

  const rows = bookings.map((booking) => `<tr>
    <td><strong>${formatDate(booking.scheduledAt)}</strong><br><span class="badge">${escapeHtml(booking.status)}</span></td>
    <td>${escapeHtml(booking.candidate?.fullName || 'Sin nombre')}<br><span class="muted">${escapeHtml(booking.candidate?.phone || '')}</span></td>
    <td>${escapeHtml(booking.vacancy?.title || 'Sin vacante')}</td>
    <td>${escapeHtml(booking.notes || '')}</td>
  </tr>`).join('');

  return `<section class="card">
    <h2>${escapeHtml(title)}</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr><th>Hora</th><th>Candidato</th><th>Vacante</th><th>Notas</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

async function loadDailySummary(prisma, dateValue = new Date(), accessContext = {}) {
  const { label, start, end } = bogotaDayRange(dateValue);
  const bookingAccessWhere = hasFullAccess(accessContext)
    ? {}
    : { vacancy: { is: buildVacancyAccessWhere(accessContext) } };

  const [todayCandidates, todayBookings] = await Promise.all([
    prisma.candidate.findMany({
      where: { ...buildCandidateAccessWhere(accessContext), createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        vacancy: { select: { id: true, title: true, city: true } },
        campaign: { select: { id: true, name: true, code: true } }
      }
    }),
    prisma.interviewBooking.findMany({
      where: { ...bookingAccessWhere, scheduledAt: { gte: start, lte: end } },
      orderBy: { scheduledAt: 'asc' },
      take: 150,
      include: {
        candidate: { select: { id: true, fullName: true, phone: true } },
        vacancy: { select: { id: true, title: true, city: true } }
      }
    })
  ]);

  const metrics = {
    newCandidates: todayCandidates.length,
    withCv: todayCandidates.filter(hasCv).length,
    pendingCv: todayCandidates.filter((candidate) => candidate.fullName && candidate.documentNumber && !hasCv(candidate)).length,
    scheduledToday: todayBookings.filter((booking) => ['SCHEDULED', 'CONFIRMED', 'ATTENDED', 'NO_SHOW'].includes(booking.status)).length,
    confirmedToday: todayBookings.filter((booking) => ['CONFIRMED', 'ATTENDED'].includes(booking.status)).length,
    attendedToday: todayBookings.filter((booking) => booking.status === 'ATTENDED').length,
    noShowToday: todayBookings.filter((booking) => booking.status === 'NO_SHOW').length,
    humanReview: todayCandidates.filter((candidate) => candidate.potentialDuplicate || candidate.botPaused || candidate.rejectionDetails).length
  };

  return {
    label,
    metrics,
    todayCandidates,
    todayBookings,
    pendingCvCandidates: todayCandidates.filter((candidate) => candidate.fullName && candidate.documentNumber && !hasCv(candidate)),
    humanReviewCandidates: todayCandidates.filter((candidate) => candidate.potentialDuplicate || candidate.botPaused || candidate.rejectionDetails)
  };
}

export function lorenV2DailySummaryRouter(prisma) {
  const router = express.Router();
  router.use(requireLorenV2);

  router.get('/', async (req, res) => {
    const summary = await loadDailySummary(prisma, req.query.date || new Date(), getAccessContext(req));
    const body = `<section class="card">
      <h1>Resumen diario para reclutadores</h1>
      <p>Fecha operativa: <strong>${escapeHtml(summary.label)}</strong>. Este resumen prioriza tareas accionables del día: candidatos nuevos, HV pendientes, citas y casos que requieren revisión humana.</p>
    </section>
    ${renderMetrics(summary.metrics)}
    ${renderBookingTable('Citas de hoy', summary.todayBookings)}
    ${renderCandidateTable('Candidatos nuevos de hoy', summary.todayCandidates)}
    ${renderCandidateTable('Pendientes de hoja de vida', summary.pendingCvCandidates)}
    ${renderCandidateTable('Revisión humana', summary.humanReviewCandidates)}`;
    res.send(renderLayout({ title: 'Resumen diario — Estadísticas', body }));
  });

  router.get('/json', async (req, res) => {
    const summary = await loadDailySummary(prisma, req.query.date || new Date(), getAccessContext(req));
    res.json({ ok: true, ...summary });
  });

  return router;
}
