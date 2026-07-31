import express from 'express';
import { canSeeMetaAds, requireCvAnalysis } from '../services/lorenV2Gate.js';
import {
  buildCandidateAccessWhere,
  buildVacancyAccessWhere,
  getAccessContext
} from '../services/appUsers.js';
import {
  analyzeCandidateCv,
  parseCvAnalysisEvidence,
  reviewVacancyCandidates,
  safeErrorMessage
} from '../services/cvIntelligence.js';
import {
  createCvReviewExportSnapshot,
  CV_REVIEW_EXPORT_GROUPS,
  sendCvAnalysisWorkbook
} from '../services/cvAnalysisWorkbook.js';
import {
  getCvReviewExportOwnerKey,
  loadCvReviewExportSnapshot,
  storeCvReviewExportSnapshot
} from '../services/cvReviewExportStore.js';

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

function renderLayout({ title, body, req = {} }) {
  const metaAdsLink = canSeeMetaAds(req)
    ? '<a href="/admin/estadisticas/campaigns">Meta Ads</a>'
    : '';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon-loginpro.svg">
  <style>
    :root { --navy:#1e2d3d; --green:#0d7a6b; --green-soft:#e6f4f1; --border:#e1e4e8; --muted:#667085; --bg:#f4f5f7; --orange:#b45309; --red:#b42318; --blue:#175cd3; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter,Arial,sans-serif; background:var(--bg); color:#1a1d23; }
    .navbar { background:var(--navy); padding:0 24px; display:flex; align-items:center; gap:20px; min-height:52px; flex-wrap:wrap; }
    .navbar a { color:#cbd5e0; text-decoration:none; font-size:13px; font-weight:700; }
    .navbar a:hover,.navbar a.active { color:#fff; }
    .navbar .spacer { flex:1; }
    .page { max-width:1380px; margin:0 auto; padding:24px 20px 52px; }
    .hero { background:linear-gradient(135deg,#173044,#0d7a6b); color:#fff; border:0; }
    .hero h1,.hero p { color:#fff; }
    .card { background:#fff; border:1px solid var(--border); border-radius:14px; box-shadow:0 1px 3px rgba(0,0,0,.06); padding:19px; margin-bottom:18px; }
    h1 { font-size:24px; margin:0 0 7px; color:var(--navy); }
    h2 { font-size:18px; margin:0 0 12px; color:var(--navy); }
    h3 { font-size:15px; margin:0 0 8px; color:var(--navy); }
    p { color:var(--muted); line-height:1.55; margin:6px 0; }
    .setup { display:grid; grid-template-columns:minmax(240px,.7fr) minmax(360px,1.3fr); gap:14px; align-items:end; }
    label { display:flex; flex-direction:column; gap:7px; color:#344054; font-size:13px; font-weight:800; }
    select,textarea { width:100%; border:1px solid #cfd4dc; border-radius:9px; padding:10px 11px; color:#172033; background:#fff; font:inherit; }
    select { min-height:44px; }
    textarea { min-height:116px; resize:vertical; line-height:1.45; }
    .hint { color:var(--muted); font-size:12px; font-weight:500; }
    .actions { display:flex; justify-content:flex-end; margin-top:13px; gap:8px; flex-wrap:wrap; }
    .btn { display:inline-flex; align-items:center; justify-content:center; border:0; border-radius:9px; padding:10px 14px; background:var(--green); color:#fff; font-size:13px; font-weight:800; cursor:pointer; text-decoration:none; }
    .btn.secondary { color:#344054; background:#fff; border:1px solid #cfd4dc; }
    .btn.small { padding:7px 10px; font-size:12px; }
    .export-form { margin:0; }
    .group-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .alert { border-radius:10px; padding:11px 13px; margin-bottom:15px; background:var(--green-soft); color:var(--green); font-weight:750; }
    .alert.error { background:#fff1f0; color:var(--red); border:1px solid #fecdca; }
    .alert.warn { background:#fffaeb; color:#93370d; border:1px solid #fedf89; }
    .technical { border:1px dashed #98a2b3; background:#f8fafc; }
    .technical code { color:#344054; font-size:12px; overflow-wrap:anywhere; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(165px,1fr)); gap:10px; }
    .kpi { border:1px solid var(--border); border-radius:11px; padding:14px; background:#f8fafc; }
    .kpi strong { display:block; font-size:27px; line-height:1; color:var(--navy); }
    .kpi span { display:block; color:var(--muted); font-size:12px; margin-top:6px; }
    .kpi.good { background:#ecfdf3; border-color:#abefc6; }.kpi.good strong { color:#067647; }
    .kpi.info { background:#eff8ff; border-color:#b2ddff; }.kpi.info strong { color:var(--blue); }
    .kpi.warn { background:#fffaeb; border-color:#fedf89; }.kpi.warn strong { color:var(--orange); }
    .badge { display:inline-flex; border-radius:999px; padding:4px 9px; background:#eef2ff; color:#3730a3; font-weight:800; font-size:11px; }
    .badge.ok { background:#e6f4f1; color:var(--green); }
    .badge.warn { background:#fff7ed; color:#9a3412; }
    .badge.error { background:#fee2e2; color:#991b1b; }
    .badge.required { background:#fff1f0; color:#b42318; }
    .badge.preferred { background:#eff8ff; color:#175cd3; }
    .muted { color:var(--muted); font-size:12px; }
    .criteria { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .criterion { border:1px solid var(--border); border-radius:10px; padding:9px 11px; background:#f8fafc; max-width:360px; }
    .criterion strong { font-size:12px; color:var(--navy); }.criterion p { font-size:11px; margin:4px 0 0; }
    .group { margin-top:20px; }
    .group-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
    .result-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
    .result { border:1px solid var(--border); border-radius:12px; padding:15px; background:#fff; }
    .result.strong { border-left:5px solid #12b76a; }.result.possible { border-left:5px solid #2e90fa; }.result.low { border-left:5px solid #f79009; }.result.manual { border-left:5px solid #d92d20; }
    .result-top { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
    .score { font-size:22px; font-weight:900; color:var(--navy); white-space:nowrap; }
    .list-title { margin:12px 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:#475467; font-weight:900; }
    ul { margin:5px 0 0; padding-left:18px; color:#475467; font-size:12px; line-height:1.45; }
    .result-actions { display:flex; gap:7px; margin-top:13px; flex-wrap:wrap; }
    .registered { margin-top:12px; border:1px solid #b2ddff; border-radius:10px; padding:11px; background:#f5fbff; }
    .registered-title { color:var(--blue); font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.04em; margin-bottom:8px; }
    .registered-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(125px,1fr)); gap:8px; }
    .registered-item span { display:block; color:var(--muted); font-size:10px; margin-bottom:2px; }
    .registered-item strong { display:block; color:var(--navy); font-size:12px; line-height:1.35; }
    .table-wrap { overflow:auto; border:1px solid var(--border); border-radius:11px; }
    table { width:100%; border-collapse:collapse; font-size:13px; min-width:760px; }
    th { text-align:left; color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.05em; background:#f9fafb; }
    th,td { padding:10px; border-bottom:1px solid #eaecef; vertical-align:top; }
    tr:last-child td { border-bottom:0; }
    .empty { text-align:center; color:var(--muted); padding:28px 14px; }
    @media(max-width:760px) { .page{padding:15px 10px 40px}.setup{grid-template-columns:1fr}.actions .btn{width:100%}.navbar{padding:0 10px;gap:12px}.result-grid{grid-template-columns:1fr}.group-head{align-items:flex-start;flex-direction:column} }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/admin">Panel</a>
    <a href="/admin/estadisticas">Estadísticas</a>
    ${metaAdsLink}
    <a class="active" href="/admin/estadisticas/cv-analysis">Análisis HV</a>
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
  if (!analysis) return '<span class="badge warn">Aún no revisada</span>';
  if (analysis.classification === 'UNREADABLE') return '<span class="badge error">Revisión manual</span>';
  if (analysis.classification !== 'CV_VALID') return '<span class="badge warn">Análisis incompleto</span>';
  const evidence = parseCvAnalysisEvidence(analysis);
  return evidence.extractionMode === 'visual_pdf'
    ? '<span class="badge ok">Leída desde el PDF</span>'
    : '<span class="badge ok">Lista para comparar</span>';
}

function renderVacancyOptions(vacancies = [], selectedId = '') {
  return vacancies.map((vacancy) => {
    const selected = vacancy.id === selectedId ? ' selected' : '';
    const city = vacancy.city ? ` · ${vacancy.city}` : '';
    return `<option value="${escapeHtml(vacancy.id)}"${selected}>${escapeHtml(vacancy.title || 'Vacante sin nombre')}${escapeHtml(city)}</option>`;
  }).join('');
}

function renderProfileForm(vacancies, { vacancyId = '', desiredProfile = '' } = {}) {
  return `<section class="card">
    <h2>1. Elige la vacante y cuéntanos qué buscas</h2>
    <form method="post" action="/admin/estadisticas/cv-analysis/run">
      <div class="setup">
        <label>Vacante
          <select name="vacancyId" required>
            <option value="">Selecciona una vacante</option>
            ${renderVacancyOptions(vacancies, vacancyId)}
          </select>
          <span class="hint">Solo se revisarán las personas registradas en esta vacante que tengan hoja de vida.</span>
        </label>
        <label>Perfil que necesitas
          <textarea name="desiredProfile" maxlength="4000" required placeholder="Ejemplo: Busco una persona con al menos un año manejando inventarios, que haya usado Excel y tenga experiencia recibiendo mercancía. Es deseable que conozca SAP.">${escapeHtml(desiredProfile)}</textarea>
          <span class="hint">Escríbelo con tus palabras. El sistema mostrará cómo entendió tu solicitud antes de presentar resultados.</span>
        </label>
      </div>
      <div class="actions"><button class="btn" type="submit">Revisar hojas de vida</button></div>
    </form>
  </section>`;
}

function renderCandidateTable(candidates = [], vacancyId = '') {
  if (!vacancyId) return '<section class="card"><div class="empty">Selecciona una vacante para ver sus hojas de vida.</div></section>';
  if (!candidates.length) return '<section class="card"><div class="empty">Esta vacante todavía no tiene candidatos con hoja de vida.</div></section>';
  const rows = candidates.map((candidate) => `<tr>
    <td><strong>${escapeHtml(candidate.fullName || 'Sin nombre')}</strong><br><span class="muted">${escapeHtml(candidate.phone || '')}</span></td>
    <td>${statusBadge(candidate)}</td>
    <td>${latestAnalysis(candidate) ? formatDate(latestAnalysis(candidate).analysedAt) : 'Sin análisis'}</td>
    <td><a class="btn secondary small" href="/admin/candidates/${escapeHtml(candidate.id)}">Ver candidato</a></td>
  </tr>`).join('');
  return `<section class="card">
    <h2>Hojas de vida disponibles</h2>
    <p>Al iniciar la revisión se reutilizarán los análisis completos, se procesarán los documentos pendientes y se combinarán con los datos del registro.</p>
    <div class="table-wrap"><table><thead><tr><th>Candidato</th><th>Lectura</th><th>Último análisis</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

function renderCriteria(profile = {}) {
  profile = profile || {};
  const criteria = Array.isArray(profile.criteria) ? profile.criteria : [];
  if (!criteria.length) return '';
  return `<section class="card">
    <h2>2. Así entendimos el perfil</h2>
    <p>${escapeHtml(profile.summary || '')}</p>
    <div class="criteria">${criteria.map((criterion) => `<div class="criterion">
      <span class="badge ${criterion.priority === 'REQUIRED' ? 'required' : 'preferred'}">${criterion.priority === 'REQUIRED' ? 'Importante' : 'Deseable'}</span>
      <strong>${escapeHtml(criterion.label)}</strong>
      <p>${escapeHtml(criterion.description)}${criterion.minimumMonths ? ` · Mínimo ${Math.round(criterion.minimumMonths / 12 * 10) / 10} año(s)` : ''}</p>
    </div>`).join('')}</div>
  </section>`;
}

function renderStringList(title, items = []) {
  if (!Array.isArray(items) || !items.length) return '';
  return `<div class="list-title">${escapeHtml(title)}</div><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderRegisteredData(candidate = {}) {
  const residence = [candidate?.locality, candidate?.neighborhood, candidate?.zone]
    .map(normalizeString)
    .find(Boolean);
  const items = [
    ['Medio de transporte', candidate?.transportMode],
    ['Residencia', residence]
  ].filter(([, value]) => normalizeString(value));
  if (!items.length) return '';
  return `<div class="registered">
    <div class="registered-title">Datos registrados por el candidato</div>
    <div class="registered-grid">${items.map(([label, value]) => `<div class="registered-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>
  </div>`;
}

function operatorManualReason(reason = '') {
  const value = normalizeString(reason);
  if (!value) return '';
  if (/(lote|reintent|modelo|openai|comparación automática|respuesta de comparación|código interno)/i.test(value)) {
    return 'No fue posible completar la comparación de este perfil. Revísalo manualmente.';
  }
  return value;
}

function renderResultCard(result, kind, { isDev = false } = {}) {
  const candidate = result.candidate || {};
  const match = result.match;
  const labels = {
    strong: 'Coincidencia alta',
    possible: 'Puede encajar',
    low: 'Poca evidencia',
    manual: 'Revisar manualmente'
  };
  const manualReason = result.manualReason
    ? (isDev ? result.manualReason : operatorManualReason(result.manualReason))
    : '';
  return `<article class="result ${kind}">
    <div class="result-top">
      <div><h3>${escapeHtml(candidate.fullName || 'Candidato sin nombre')}</h3></div>
      ${match ? `<div class="score">${Math.round(match.score)}%</div>` : '<span class="badge error">Manual</span>'}
    </div>
    <span class="badge ${kind === 'strong' ? 'ok' : kind === 'manual' ? 'error' : 'warn'}" style="margin-top:10px">${labels[kind]}</span>
    ${manualReason ? `<p>${escapeHtml(manualReason)}</p>` : ''}
    ${renderRegisteredData(candidate)}
    ${renderStringList('Por qué puede servir', match?.reasons)}
    ${renderStringList('Evidencia encontrada (HV o registro)', match?.evidence)}
    <div class="result-actions">
      <a class="btn secondary small" href="/admin/candidates/${escapeHtml(candidate.id)}">Ver candidato</a>
      <a class="btn secondary small" href="/admin/candidates/${escapeHtml(candidate.id)}/cv">Descargar HV</a>
    </div>
  </article>`;
}

function renderExportForm(reviewToken, group, label, secondary = true) {
  if (!reviewToken || !Object.hasOwn(CV_REVIEW_EXPORT_GROUPS, group)) return '';
  return `<form class="export-form" method="post" action="/admin/estadisticas/cv-analysis/export">
    <input type="hidden" name="reviewToken" value="${escapeHtml(reviewToken)}">
    <input type="hidden" name="group" value="${escapeHtml(group)}">
    <button class="btn ${secondary ? 'secondary ' : ''}small" type="submit">${escapeHtml(label)}</button>
  </form>`;
}

function renderResultGroup(title, help, items, kind, reviewToken, { isDev = false } = {}) {
  if (!items.length) return '';
  return `<section class="group">
    <div class="group-head">
      <div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(help)}</p></div>
      <div class="group-actions"><span class="badge">${items.length}</span>${renderExportForm(reviewToken, kind, 'Descargar esta sección')}</div>
    </div>
    <div class="result-grid">${items.map((item) => renderResultCard(item, kind, { isDev })).join('')}</div>
  </section>`;
}

function renderTechnicalDiagnostics(review, { isDev = false } = {}) {
  if (!isDev || !review?.ok) return '';
  const warnings = Array.isArray(review.warnings) ? review.warnings : [];
  return `<section class="card technical">
    <h2>Diagnóstico técnico</h2>
    <p><strong>Modelo:</strong> <code>${escapeHtml(review.modelUsed || 'No informado')}</code></p>
    ${warnings.length ? `<div class="alert warn">${warnings.map(escapeHtml).join(' · ')}</div>` : '<p class="muted">Sin advertencias técnicas.</p>'}
  </section>`;
}

function renderReviewResults(review, reviewToken = '', { isDev = false } = {}) {
  if (!review?.ok) return '';
  if (!review.stats.total) return '<section class="card"><div class="empty">No hay hojas de vida para revisar en esta vacante.</div></section>';
  const groups = review.groups;
  return `${review.truncated ? '<div class="alert warn">Se revisaron las 120 hojas de vida más recientes. Usa una vacante o periodo más específico si necesitas abarcar más registros.</div>' : ''}
    <section class="card">
      <div class="group-head">
        <div><h2>3. Resultado de la revisión</h2><p>El orden combina la hoja de vida con el medio de transporte y la residencia registrados. No cambia el estado de ningún candidato ni toma decisiones por el coordinador.</p></div>
        ${renderExportForm(reviewToken, 'all', 'Descargar Excel completo', false)}
      </div>
      <div class="grid">
        <div class="kpi"><strong>${review.stats.total}</strong><span>Hojas de vida encontradas</span></div>
        <div class="kpi good"><strong>${review.stats.strong}</strong><span>Con evidencia clara del perfil</span></div>
        <div class="kpi info"><strong>${review.stats.possible}</strong><span>Pueden encajar</span></div>
        <div class="kpi warn"><strong>${review.stats.low}</strong><span>Con poca evidencia relacionada</span></div>
        <div class="kpi warn"><strong>${review.stats.manual}</strong><span>Necesitan revisión manual</span></div>
      </div>
    </section>
    ${renderResultGroup('Coincidencia alta', 'Empieza por aquí: la hoja de vida y/o el registro contienen evidencia clara de varios puntos importantes.', groups.strong, 'strong', reviewToken, { isDev })}
    ${renderResultGroup('Pueden encajar', 'Hay señales relacionadas y conviene una revisión humana antes de decidir.', groups.possible, 'possible', reviewToken, { isDev })}
    ${renderResultGroup('Poca evidencia para el perfil', 'La hoja de vida y los datos registrados muestran poca relación con el perfil escrito. Esto no significa rechazo.', groups.low, 'low', reviewToken, { isDev })}
    ${renderResultGroup('Revisión manual', 'No fue posible leer o comparar el documento con suficiente claridad. Descárgalo para revisarlo directamente.', groups.manual, 'manual', reviewToken, { isDev })}
    ${renderTechnicalDiagnostics(review, { isDev })}`;
}

function errorMessage(reason = '', { isDev = false } = {}) {
  const messages = {
    vacancy_required: 'Selecciona una vacante antes de iniciar la revisión.',
    vacancy_not_found: 'La vacante seleccionada ya no existe.',
    profile_too_short: 'Cuéntanos un poco más sobre la experiencia o conocimientos que buscas.',
    ai_not_configured: 'El análisis inteligente no está disponible en este momento.',
    profile_analysis_failed: 'No fue posible entender el perfil en este momento. Intenta nuevamente.',
    match_analysis_failed: 'Las hojas de vida se procesaron, pero no fue posible completar la comparación en este momento.'
  };
  const message = messages[reason] || 'No fue posible completar la revisión.';
  return isDev && reason ? `${message} [${reason}]` : message;
}

async function loadVacancies(prisma, accessContext = {}) {
  return prisma.vacancy.findMany({
    where: buildVacancyAccessWhere(accessContext),
    orderBy: [{ city: 'asc' }, { title: 'asc' }],
    select: { id: true, title: true, city: true }
  });
}

async function loadCandidates(prisma, vacancyId, accessContext = {}) {
  if (!vacancyId) return [];
  return prisma.candidate.findMany({
    where: {
      AND: [
        buildCandidateAccessWhere(accessContext),
        { vacancyId },
        {
          OR: [
            { cvStorageKey: { not: null } },
            { cvData: { not: null } },
            { cvOriginalName: { not: null } }
          ]
        }
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

function renderPage({ req = {}, vacancies, candidates = [], vacancyId = '', desiredProfile = '', review = null, reviewToken = '', message = '', error = '', showCandidates = true }) {
  const accessContext = getAccessContext(req);
  const isDev = Boolean(accessContext?.isDev);
  const body = `${message ? `<div class="alert">${escapeHtml(message)}</div>` : ''}
    ${error ? `<div class="alert error">${escapeHtml(error)}</div>` : ''}
    <section class="card hero">
      <h1>Encuentra las hojas de vida que vale la pena revisar primero</h1>
      <p>Elige una vacante, describe el perfil con tus palabras y Lórren combinará la hoja de vida con los datos registrados para organizar los resultados. Los archivos difíciles de leer quedarán separados para revisión manual.</p>
    </section>
    ${renderProfileForm(vacancies, { vacancyId, desiredProfile })}
    ${review
      ? `${renderCriteria(review.interpretedProfile)}${renderReviewResults(review, reviewToken, { isDev })}`
      : showCandidates ? renderCandidateTable(candidates, vacancyId) : ''}`;
  return renderLayout({ title: 'Análisis de hojas de vida — Lórren', body, req });
}

export function renderCvAnalysisPageForTest(options = {}) {
  return renderPage(options);
}

export function lorenV2CvAnalysisRouter(prisma) {
  const router = express.Router();
  router.use(requireCvAnalysis);

  router.get('/', async (req, res) => {
    const vacancyId = normalizeString(req.query.vacancyId) || '';
    const accessContext = getAccessContext(req);
    const [vacancies, candidates] = await Promise.all([
      loadVacancies(prisma, accessContext),
      loadCandidates(prisma, vacancyId, accessContext)
    ]);
    res.send(renderPage({
      req,
      vacancies,
      candidates,
      vacancyId,
      message: normalizeString(req.query.message) || ''
    }));
  });

  router.get('/json', async (req, res) => {
    const vacancyId = normalizeString(req.query.vacancyId) || '';
    const candidates = await loadCandidates(prisma, vacancyId, getAccessContext(req));
    res.json({ ok: true, vacancyId, candidates });
  });

  router.post('/run', async (req, res) => {
    const vacancyId = normalizeString(req.body?.vacancyId) || '';
    const desiredProfile = normalizeString(req.body?.desiredProfile)?.slice(0, 4000) || '';
    const accessContext = getAccessContext(req);
    let vacancies = [];
    try {
      vacancies = await loadVacancies(prisma, accessContext);
      if (vacancyId && !vacancies.some((vacancy) => vacancy.id === vacancyId)) {
        return res.status(403).send(renderPage({
          req,
          vacancies,
          vacancyId: '',
          desiredProfile,
          error: 'No tienes acceso a la vacante seleccionada.',
          showCandidates: false
        }));
      }
      const review = await reviewVacancyCandidates(prisma, { vacancyId, desiredProfile });

      if (!review.ok) {
        return res.status(400).send(renderPage({
          req,
          vacancies,
          vacancyId,
          desiredProfile,
          error: errorMessage(review.reason, { isDev: Boolean(accessContext?.isDev) }),
          showCandidates: false
        }));
      }

      const ownerKey = getCvReviewExportOwnerKey(req);
      const reviewToken = ownerKey
        ? storeCvReviewExportSnapshot(createCvReviewExportSnapshot(review), { ownerKey })
        : '';
      return res.send(renderPage({ req, vacancies, vacancyId, desiredProfile, review, reviewToken }));
    } catch (error) {
      console.error('[CV_REVIEW_ERROR]', { vacancyId, error: safeErrorMessage(error) });
      return res.status(500).send(renderPage({
        req,
        vacancies,
        vacancyId,
        desiredProfile,
        error: 'No fue posible revisar las hojas de vida en este momento. Intenta nuevamente; si el problema continúa, informa al administrador.',
        showCandidates: false
      }));
    }
  });

  router.post('/export', async (req, res) => {
    const reviewToken = normalizeString(req.body?.reviewToken) || '';
    const requestedGroup = normalizeString(req.body?.group) || 'all';
    const group = Object.hasOwn(CV_REVIEW_EXPORT_GROUPS, requestedGroup) ? requestedGroup : 'all';
    const ownerKey = getCvReviewExportOwnerKey(req);
    const snapshot = ownerKey
      ? loadCvReviewExportSnapshot(reviewToken, { ownerKey })
      : null;
    if (!snapshot) {
      return res.status(410).send('La descarga expiró o no pertenece a esta sesión. Ejecuta nuevamente el análisis para generar un Excel actualizado.');
    }

    const allowedVacancy = await prisma.vacancy.findFirst({
      where: {
        AND: [
          buildVacancyAccessWhere(getAccessContext(req)),
          { id: snapshot.vacancy.id }
        ]
      },
      select: { id: true }
    });
    if (!allowedVacancy) return res.status(403).send('No tienes acceso a la vacante de este análisis.');

    try {
      return await sendCvAnalysisWorkbook(res, snapshot, { group });
    } catch (error) {
      console.error('[CV_REVIEW_EXPORT_ERROR]', {
        vacancyId: snapshot.vacancy.id,
        group,
        error: safeErrorMessage(error)
      });
      if (!res.headersSent) return res.status(500).send('No fue posible generar el archivo Excel.');
      return res.end();
    }
  });

  router.post('/:candidateId/analyze', async (req, res) => {
    const accessContext = getAccessContext(req);
    const candidate = await prisma.candidate.findFirst({
      where: { id: req.params.candidateId, ...buildCandidateAccessWhere(accessContext) },
      select: { id: true }
    });
    if (!candidate) return res.status(403).send('No tienes acceso a este candidato.');
    const result = await analyzeCandidateCv(prisma, req.params.candidateId);
    const message = result.ok
      ? 'Hoja de vida analizada.'
      : accessContext?.isDev
        ? `No fue posible analizar la hoja de vida: ${result.reason}`
        : 'No fue posible analizar la hoja de vida. Intenta nuevamente.';
    res.redirect(`/admin/estadisticas/cv-analysis?message=${encodeURIComponent(message)}`);
  });

  return router;
}
