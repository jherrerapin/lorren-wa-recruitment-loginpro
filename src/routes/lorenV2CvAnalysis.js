import express from 'express';
import { requireLorenV2 } from '../services/lorenV2Gate.js';
import { analyzeCandidateCv, parseCvAnalysisEvidence } from '../services/cvIntelligence.js';

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
    .navbar { background: #1e2d3d; padding: 0 24px; display: flex; align-items: center; gap: 20px; min-height: 52px; flex-wrap: wrap; }
    .navbar a { color: #cbd5e0; text-decoration: none; font-size: 13px; font-weight: 600; }
    .navbar a:hover { color: #fff; }
    .navbar .spacer { flex: 1; }
    .page { max-width: 1280px; margin: 0 auto; padding: 24px 20px 48px; }
    .card { background: #fff; border: 1px solid #e1e4e8; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 18px; margin-bottom: 18px; }
    h1 { font-size: 22px; margin: 0 0 6px; color: #1e2d3d; }
    h2 { font-size: 16px; margin: 0 0 12px; color: #1e2d3d; }
    p { color: #6b7280; line-height: 1.5; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; background: #f9fafb; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #eaecef; vertical-align: top; }
    .badge { display: inline-flex; border-radius: 999px; padding: 3px 8px; background: #eef2ff; color: #3730a3; font-weight: 700; font-size: 11px; }
    .badge.ok { background: #e6f4f1; color: #0d7a6b; }
    .badge.warn { background: #fff7ed; color: #9a3412; }
    .badge.error { background: #fee2e2; color: #991b1b; }
    .muted { color: #6b7280; font-size: 12px; }
    .btn { border: 0; border-radius: 8px; padding: 8px 11px; background: #0d7a6b; color: #fff; font-size: 12px; font-weight: 700; cursor: pointer; }
    .alert { border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; background: #e6f4f1; color: #0d7a6b; font-weight: 700; }
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
    <a href="/admin/estadisticas/cv-analysis">Análisis HV</a>
    <span class="spacer"></span>
    <a href="/logout">Cerrar sesión</a>
  </nav>
  <main class="page">${body}</main>
</body>
</html>`;
}

function latestAnalysis(candidate = {}) {
  return Array.isArray(candidate.attachmentAnalyses) ? candidate.attachmentAnalyses[0] : null;
}

function statusBadge(candidate = {}) {
  if (!hasCv(candidate)) return '<span class="badge error">Sin HV</span>';
  const analysis = latestAnalysis(candidate);
  if (!analysis) return '<span class="badge warn">Pendiente análisis</span>';

  if (analysis.classification === 'UNREADABLE') {
    return '<span class="badge error">Archivo ilegible</span>';
  }
  if (analysis.classification !== 'CV_VALID') {
    return '<span class="badge warn">Análisis incompleto</span>';
  }

  const evidence = parseCvAnalysisEvidence(analysis);
  const mismatches = Array.isArray(evidence.mismatches) ? evidence.mismatches.length : 0;
  if (mismatches > 0) return `<span class="badge warn">${mismatches} alerta(s)</span>`;
  return '<span class="badge ok">Analizada</span>';
}

function renderAnalysisSummary(candidate = {}) {
  const analysis = latestAnalysis(candidate);
  if (!analysis) return '<span class="muted">Sin análisis todavía.</span>';
  const evidence = parseCvAnalysisEvidence(analysis);
  const extracted = evidence.extracted || {};
  const mismatches = Array.isArray(evidence.mismatches) ? evidence.mismatches : [];
  const warnings = Array.isArray(evidence.warnings) ? evidence.warnings : [];
  return `<div>
    <strong>Confianza:</strong> ${Math.round(Number(analysis.confidence || 0) * 100)}%<br>
    <span class="muted">Analizado: ${formatDate(analysis.analysedAt)}</span><br>
    ${analysis.summary ? `<span class="muted">${escapeHtml(analysis.summary)}</span><br>` : ''}
    <span class="muted">Nombre HV: ${escapeHtml(extracted.fullName || 'No identificado')}</span><br>
    <span class="muted">Doc. HV: ${escapeHtml(extracted.documentNumber || 'No identificado')}</span><br>
    ${mismatches.length ? `<span class="badge warn">Diferencias: ${mismatches.map((item) => escapeHtml(item.field)).join(', ')}</span><br>` : ''}
    ${warnings.length ? `<span class="muted">Advertencias: ${warnings.map(escapeHtml).join(' | ')}</span>` : ''}
  </div>`;
}

function renderRows(candidates = []) {
  if (!candidates.length) return '<tr><td colspan="6">No hay candidatos con hoja de vida.</td></tr>';
  return candidates.map((candidate) => `<tr>
    <td><strong>${escapeHtml(candidate.fullName || 'Sin nombre')}</strong><br><span class="muted">${escapeHtml(candidate.phone || '')}</span></td>
    <td>${escapeHtml(candidate.vacancy?.title || 'Sin vacante')}<br><span class="muted">${escapeHtml(candidate.vacancy?.city || '')}</span></td>
    <td>${escapeHtml(candidate.cvOriginalName || 'HV almacenada')}<br><span class="muted">${escapeHtml(candidate.cvMimeType || '')}</span></td>
    <td>${statusBadge(candidate)}</td>
    <td>${renderAnalysisSummary(candidate)}</td>
    <td>
      <form method="post" action="/admin/estadisticas/cv-analysis/${candidate.id}/analyze">
        <button class="btn" type="submit">Analizar HV</button>
      </form>
    </td>
  </tr>`).join('');
}

async function loadCandidates(prisma) {
  return prisma.candidate.findMany({
    where: {
      OR: [
        { cvStorageKey: { not: null } },
        { cvData: { not: null } },
        { cvOriginalName: { not: null } }
      ]
    },
    orderBy: { updatedAt: 'desc' },
    take: 300,
    include: {
      vacancy: { select: { id: true, title: true, city: true } },
      attachmentAnalyses: { orderBy: { analysedAt: 'desc' }, take: 1 }
    }
  });
}

export function lorenV2CvAnalysisRouter(prisma) {
  const router = express.Router();
  router.use(requireLorenV2);

  router.get('/', async (req, res) => {
    const candidates = await loadCandidates(prisma);
    const message = normalizeString(req.query.message);
    const body = `${message ? `<div class="alert">${escapeHtml(message)}</div>` : ''}
      <section class="card">
        <h1>Análisis inteligente de hojas de vida</h1>
        <p>Esta vista permite analizar HV recibidas, extraer datos principales y comparar lo encontrado en el documento contra la información registrada por chat.</p>
      </section>
      <section class="card">
        <h2>Candidatos con HV</h2>
        <div style="overflow-x:auto;">
          <table>
            <thead><tr><th>Candidato</th><th>Vacante</th><th>Archivo</th><th>Estado</th><th>Resumen IA</th><th>Acción</th></tr></thead>
            <tbody>${renderRows(candidates)}</tbody>
          </table>
        </div>
      </section>`;
    res.send(renderLayout({ title: 'Análisis HV — Estadísticas', body }));
  });

  router.get('/json', async (_req, res) => {
    const candidates = await loadCandidates(prisma);
    res.json({ ok: true, candidates });
  });

  router.post('/:candidateId/analyze', async (req, res) => {
    const result = await analyzeCandidateCv(prisma, req.params.candidateId);
    const message = result.ok ? 'Análisis de HV generado.' : `No fue posible analizar la HV: ${result.reason}`;
    res.redirect(`/admin/estadisticas/cv-analysis?message=${encodeURIComponent(message)}`);
  });

  return router;
}
