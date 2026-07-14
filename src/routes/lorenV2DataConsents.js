import express from 'express';
import { requireLorenV2 } from '../services/lorenV2Gate.js';
import { recordCandidateDataConsent } from '../services/consentStateService.js';

const CONSENT_VERSION = 'loren-v2-2026-06-v1';
const CONSENT_TEXT = 'Autorizo de manera libre, previa, expresa e informada el tratamiento de mis datos personales y documentos aportados dentro del proceso de reclutamiento, selección y validación documental de Opera Loginpro / Loren, incluyendo contacto por canales digitales, verificación de información suministrada, análisis de hoja de vida y conservación de la trazabilidad del proceso. Declaro que conozco que puedo solicitar información, actualización, rectificación o revocatoria de la autorización según la normativa aplicable de protección de datos personales.';

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

function formatDate(value) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Bogota'
  }).format(new Date(value));
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
    p { color: #6b7280; line-height: 1.5; }
    textarea { width: 100%; min-height: 90px; border: 1px solid #e1e4e8; border-radius: 8px; padding: 10px; font-family: inherit; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .metric { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px; }
    .metric strong { display: block; font-size: 24px; color: #1e2d3d; }
    .metric span { color: #6b7280; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; background: #f9fafb; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #eaecef; vertical-align: top; }
    .badge { display: inline-flex; border-radius: 999px; padding: 3px 8px; background: #eef2ff; color: #3730a3; font-weight: 700; font-size: 11px; }
    .badge.accepted { background: #e6f4f1; color: #0d7a6b; }
    .badge.revoked { background: #fee2e2; color: #991b1b; }
    .muted { color: #6b7280; font-size: 12px; }
    .btn { border: 0; border-radius: 8px; padding: 8px 11px; background: #0d7a6b; color: #fff; font-size: 12px; font-weight: 700; cursor: pointer; }
    .btn-danger { background: #991b1b; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .alert { border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; background: #e6f4f1; color: #0d7a6b; font-weight: 700; }
    .warning { background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; border-radius: 10px; padding: 10px 12px; font-size: 13px; }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/admin">Panel</a>
    <a href="/admin/estadisticas">Estadísticas</a>
    <a href="/admin/estadisticas/campaigns">Campañas</a>
    <a href="/admin/estadisticas/daily-summary">Resumen diario</a>
    <a href="/admin/estadisticas/reports">Reportes</a>
    <a href="/admin/estadisticas/data-consents">Datos personales</a>
    <span class="spacer"></span>
    <a href="/logout">Cerrar sesión</a>
  </nav>
  <main class="page">${body}</main>
</body>
</html>`;
}

function consentClass(status = '') {
  if (status === 'ACCEPTED') return 'accepted';
  if (status === 'REVOKED') return 'revoked';
  return '';
}

function renderMetrics(metrics = {}) {
  const items = [
    ['Pendientes', metrics.pending],
    ['Aceptadas', metrics.accepted],
    ['Revocadas', metrics.revoked],
    ['Total revisado', metrics.total]
  ];
  return `<section class="card">
    <h2>Estado de autorizaciones</h2>
    <div class="grid">
      ${items.map(([label, value]) => `<div class="metric"><strong>${Number(value || 0)}</strong><span>${escapeHtml(label)}</span></div>`).join('')}
    </div>
  </section>`;
}

function renderCandidateRows(candidates = []) {
  if (!candidates.length) return '<tr><td colspan="6">No hay candidatos para mostrar.</td></tr>';
  return candidates.map((candidate) => `<tr>
    <td><strong>${escapeHtml(candidate.fullName || 'Sin nombre')}</strong><br><span class="muted">${escapeHtml(candidate.phone || '')}</span></td>
    <td>${escapeHtml(candidate.documentType || '')} ${escapeHtml(candidate.documentNumber || '')}<br><span class="muted">${escapeHtml(candidate.vacancy?.title || 'Sin vacante')}</span></td>
    <td><span class="badge ${consentClass(candidate.dataConsentStatus)}">${escapeHtml(candidate.dataConsentStatus || 'PENDING')}</span><br><span class="muted">Versión: ${escapeHtml(candidate.dataConsentVersion || 'Sin versión')}</span></td>
    <td>${formatDate(candidate.dataConsentAcceptedAt || candidate.dataConsentRevokedAt)}<br><span class="muted">${escapeHtml(candidate.dataConsentSource || '')}</span></td>
    <td><span class="muted">${escapeHtml(candidate.dataConsentRecordedBy || '')}</span></td>
    <td>
      <div class="actions">
        <form method="post" action="/admin/estadisticas/data-consents/${candidate.id}/accept">
          <button class="btn" type="submit">Registrar aceptación</button>
        </form>
        <form method="post" action="/admin/estadisticas/data-consents/${candidate.id}/revoke">
          <button class="btn btn-danger" type="submit">Revocar</button>
        </form>
      </div>
    </td>
  </tr>`).join('');
}

async function loadConsentDashboard(prisma) {
  const [pending, accepted, revoked, candidates] = await Promise.all([
    prisma.candidate.count({ where: { dataConsentStatus: 'PENDING' } }),
    prisma.candidate.count({ where: { dataConsentStatus: 'ACCEPTED' } }),
    prisma.candidate.count({ where: { dataConsentStatus: 'REVOKED' } }),
    prisma.candidate.findMany({
      orderBy: [{ dataConsentStatus: 'asc' }, { updatedAt: 'desc' }],
      take: 300,
      include: { vacancy: { select: { id: true, title: true, city: true } } }
    })
  ]);
  return { metrics: { pending, accepted, revoked, total: pending + accepted + revoked }, candidates };
}

async function recordConsent(prisma, req, candidateId, status) {
  const source = 'LOREN_V2_ADMIN';
  const username = req.username || req.session?.username || null;
  const note = normalizeString(req.body?.note);

  await recordCandidateDataConsent(prisma, {
    candidateId,
    status,
    version: CONSENT_VERSION,
    text: CONSENT_TEXT,
    source,
    actorUsername: username,
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent') || null,
    note
  });
}

export function lorenV2DataConsentsRouter(prisma) {
  const router = express.Router();
  router.use(requireLorenV2);

  router.get('/', async (req, res) => {
    const { metrics, candidates } = await loadConsentDashboard(prisma);
    const message = normalizeString(req.query.message);
    const body = `${message ? `<div class="alert">${escapeHtml(message)}</div>` : ''}
      <section class="card">
        <h1>Autorización de tratamiento de datos</h1>
        <p>Registro operativo para controlar si el candidato autorizó el tratamiento de datos personales dentro del proceso de reclutamiento.</p>
        <div class="warning">Este texto es una base operativa y debe ser validado por el área jurídica o responsable de protección de datos antes de uso definitivo.</div>
        <h2>Texto versión ${escapeHtml(CONSENT_VERSION)}</h2>
        <textarea readonly>${escapeHtml(CONSENT_TEXT)}</textarea>
      </section>
      ${renderMetrics(metrics)}
      <section class="card">
        <h2>Candidatos y autorización</h2>
        <div style="overflow-x:auto;">
          <table>
            <thead><tr><th>Candidato</th><th>Documento / vacante</th><th>Estado</th><th>Fecha</th><th>Registrado por</th><th>Acciones</th></tr></thead>
            <tbody>${renderCandidateRows(candidates)}</tbody>
          </table>
        </div>
      </section>`;
    res.send(renderLayout({ title: 'Datos personales — Estadísticas', body }));
  });

  router.get('/json', async (_req, res) => {
    const dashboard = await loadConsentDashboard(prisma);
    res.json({ ok: true, consentVersion: CONSENT_VERSION, consentText: CONSENT_TEXT, ...dashboard });
  });

  router.post('/:candidateId/accept', async (req, res) => {
    await recordConsent(prisma, req, req.params.candidateId, 'ACCEPTED');
    res.redirect('/admin/estadisticas/data-consents?message=Autorización registrada.');
  });

  router.post('/:candidateId/revoke', async (req, res) => {
    await recordConsent(prisma, req, req.params.candidateId, 'REVOKED');
    res.redirect('/admin/estadisticas/data-consents?message=Revocatoria registrada.');
  });

  return router;
}
