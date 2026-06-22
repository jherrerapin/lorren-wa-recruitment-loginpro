import express from 'express';
import { requireLorenV2 } from '../services/lorenV2Gate.js';

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return 'Sin fecha';
  try {
    return new Intl.DateTimeFormat('es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Bogota'
    }).format(new Date(value));
  } catch (_error) {
    return String(value);
  }
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
    p { color: #6b7280; }
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
    <a href="/admin/v2">Loren V2</a>
    <a href="/admin/v2/campaigns">Campañas</a>
    <a href="/admin/v2/referrals">Referidos</a>
    <span class="spacer"></span>
    <a href="/logout">Cerrar sesión</a>
  </nav>
  <main class="page">${body}</main>
</body>
</html>`;
}

function renderReferralsTable(candidates = []) {
  if (!candidates.length) {
    return `<section class="card"><p>Aún no hay candidatos detectados como referidos o recomendados.</p></section>`;
  }

  const rows = candidates.map((candidate) => `<tr>
    <td><strong>${escapeHtml(candidate.fullName || 'Sin nombre')}</strong><br><span class="muted">${escapeHtml(candidate.phone || '')}</span></td>
    <td>${escapeHtml(candidate.referrerName || 'Sin nombre detectado')}<br><span class="muted">${escapeHtml(candidate.referrerPhone || '')}</span></td>
    <td>${escapeHtml(candidate.vacancy?.title || 'Sin vacante')}</td>
    <td><span class="badge">${escapeHtml(candidate.status)}</span><br><span class="muted">${hasCv(candidate) ? 'HV recibida' : 'Sin HV'}</span></td>
    <td>${formatDate(candidate.createdAt)}</td>
    <td><a href="/admin/candidates/${escapeHtml(candidate.id)}">Ver detalle</a></td>
  </tr>`).join('');

  return `<section class="card">
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Candidato</th>
            <th>Referidor</th>
            <th>Vacante</th>
            <th>Estado</th>
            <th>Registro</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

export function lorenV2ReferralsRouter(prisma) {
  const router = express.Router();
  router.use(requireLorenV2);

  router.get('/', async (_req, res) => {
    const candidates = await prisma.candidate.findMany({
      where: {
        OR: [
          { sourceType: 'REFERRED' },
          { referrerName: { not: null } },
          { referrerPhone: { not: null } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: {
        vacancy: { select: { id: true, title: true, city: true } }
      }
    });

    const body = `<section class="card">
      <h1>Referidos y recomendados</h1>
      <p>Loren detecta internamente candidatos que escriben frases como “vengo referido por…”, “me recomendó…” o “de parte de…”. No se le pide ningún código al candidato.</p>
    </section>
    ${renderReferralsTable(candidates)}`;

    res.send(renderLayout({ title: 'Referidos Loren V2', body }));
  });

  router.get('/json', async (_req, res) => {
    const candidates = await prisma.candidate.findMany({
      where: {
        OR: [
          { sourceType: 'REFERRED' },
          { referrerName: { not: null } },
          { referrerPhone: { not: null } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        id: true,
        phone: true,
        fullName: true,
        sourceType: true,
        referrerName: true,
        referrerPhone: true,
        status: true,
        createdAt: true,
        vacancy: { select: { id: true, title: true, city: true } }
      }
    });

    res.json({ ok: true, candidates });
  });

  return router;
}
