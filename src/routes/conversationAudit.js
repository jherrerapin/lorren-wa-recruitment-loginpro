import express from 'express';
import { loadConversationAuditReport } from '../services/conversationAudit.js';

const PAGE_SIZE = 25;
const RISK_OPTIONS = new Set(['ALL', 'RIESGO_ALTO', 'REVISAR', 'ADECUADA']);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function asPositiveInt(value, fallback = 1) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requireDev(req, res, next) {
  if (req.userRole !== 'dev') {
    return res.status(403).send('Esta auditoría está disponible únicamente para DEV.');
  }
  return next();
}

function formatDateTimeCO(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function riskClass(label) {
  return {
    RIESGO_ALTO: 'risk-high',
    REVISAR: 'risk-review',
    ADECUADA: 'risk-ok'
  }[label] || 'risk-review';
}

function severityClass(severity) {
  return `severity-${['critical', 'high', 'medium', 'low'].includes(severity) ? severity : 'medium'}`;
}

function buildIssueTitleMap(report) {
  const map = new Map();
  for (const conversation of report.conversations) {
    for (const issue of conversation.issues) {
      if (!map.has(issue.code)) map.set(issue.code, issue.title);
    }
  }
  return map;
}

function buildSummaryDiagnosis(report) {
  const { summary } = report;
  if (!summary.conversations) return 'No se encontraron conversaciones visibles en el periodo seleccionado.';
  if (summary.highRisk > 0) {
    return `${summary.highRisk} conversaciones presentan hallazgos de riesgo alto. La prioridad debe ser revisar esos casos antes de modificar el tono general del bot.`;
  }
  if (summary.review > 0) {
    return `${summary.review} conversaciones requieren revisión. No se detectaron fallos críticos, pero sí patrones que pueden explicar una experiencia poco natural o repetitiva.`;
  }
  return 'Las reglas automáticas no detectaron fallos relevantes en el periodo. Conviene validar una muestra humana para confirmar tono y utilidad.';
}

function renderSummaryCards(report) {
  const cards = [
    ['Conversaciones', report.summary.conversations],
    ['Mensajes', report.summary.messages],
    ['Candidatos', report.summary.uniqueCandidates],
    ['Riesgo alto', report.summary.highRisk],
    ['Por revisar', report.summary.review],
    ['Adecuadas', report.summary.adequate],
    ['Tasa adecuada', `${report.summary.adequateRate}%`],
    ['Respuesta promedio', report.summary.averageResponseSeconds == null ? 'Sin datos' : `${report.summary.averageResponseSeconds}s`]
  ];
  return cards.map(([label, value]) => `<div class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}

function renderIssueTable(report) {
  const titles = buildIssueTitleMap(report);
  const rows = Object.entries(report.issueCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `<tr><td><code>${escapeHtml(code)}</code></td><td>${escapeHtml(titles.get(code) || code)}</td><td>${count}</td></tr>`)
    .join('');
  return rows || '<tr><td colspan="3">No se detectaron hallazgos automáticos.</td></tr>';
}

function renderSources(report) {
  const rows = Object.entries(report.sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `<tr><td>${escapeHtml(source)}</td><td>${count}</td></tr>`)
    .join('');
  return rows || '<tr><td colspan="2">Sin fuentes registradas.</td></tr>';
}

function renderRecommendations(report) {
  if (!report.recommendations.length) return '<p>No hay recomendaciones automáticas prioritarias.</p>';
  return `<ol>${report.recommendations.map((item) => `<li><strong>${escapeHtml(item.count)} casos:</strong> ${escapeHtml(item.recommendation)}</li>`).join('')}</ol>`;
}

function renderConversation(conversation) {
  const issues = conversation.issues.length
    ? conversation.issues.map((issue) => `<li class="issue ${severityClass(issue.severity)}"><strong>${escapeHtml(issue.title)}</strong><span>${escapeHtml(issue.detail)}</span></li>`).join('')
    : '<li class="issue severity-low"><strong>Sin hallazgos</strong><span>No se detectaron reglas incumplidas.</span></li>';
  const transcript = conversation.transcript.map((message) => `<div class="message actor-${escapeHtml(message.actor)}">
      <div class="message-meta"><strong>${escapeHtml(message.actor)}</strong><span>${escapeHtml(formatDateTimeCO(message.at))}</span>${message.source ? `<code>${escapeHtml(message.source)}</code>` : ''}</div>
      <div class="message-body">${escapeHtml(message.body || `[${message.messageType || 'Mensaje sin texto'}]`)}</div>
    </div>`).join('');
  return `<article class="conversation">
    <div class="conversation-head">
      <div><strong>${escapeHtml(conversation.id)}</strong><span>${escapeHtml(conversation.vacancy)}</span></div>
      <span class="risk ${riskClass(conversation.risk.label)}">${escapeHtml(conversation.risk.label)} · ${conversation.risk.score}/100</span>
    </div>
    <div class="conversation-meta">
      <span>${escapeHtml(formatDateTimeCO(conversation.startedAt))} → ${escapeHtml(formatDateTimeCO(conversation.endedAt))}</span>
      <span>${conversation.messageCount} mensajes</span>
      <span>Paso: ${escapeHtml(conversation.finalState.currentStep || 'sin dato')}</span>
      <span>Estado: ${escapeHtml(conversation.finalState.status || 'sin dato')}</span>
    </div>
    <ul class="issues">${issues}</ul>
    <details><summary>Ver transcripción anonimizada</summary><div class="transcript">${transcript}</div></details>
  </article>`;
}

export function renderConversationAuditPage(report, query = {}) {
  const days = asPositiveInt(query.days, report.range.days || 15);
  const risk = RISK_OPTIONS.has(String(query.risk || '').toUpperCase()) ? String(query.risk).toUpperCase() : 'ALL';
  const filtered = risk === 'ALL' ? report.conversations : report.conversations.filter((item) => item.risk.label === risk);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(pageCount, asPositiveInt(query.page, 1));
  const startIndex = (page - 1) * PAGE_SIZE;
  const conversations = filtered.slice(startIndex, startIndex + PAGE_SIZE);
  const queryForPage = (targetPage) => `?days=${days}&risk=${encodeURIComponent(risk)}&page=${targetPage}`;
  const pagination = `<div class="pagination">
      ${page > 1 ? `<a href="${queryForPage(page - 1)}">← Anterior</a>` : '<span></span>'}
      <span>Página ${page} de ${pageCount} · ${filtered.length} conversaciones</span>
      ${page < pageCount ? `<a href="${queryForPage(page + 1)}">Siguiente →</a>` : '<span></span>'}
    </div>`;

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Auditoría conversacional</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon-loginpro.svg">
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#172033;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.navbar{height:52px;background:#1e2d3d;display:flex;align-items:center;gap:10px;padding:0 22px}.navbar a{color:#d6dee8;text-decoration:none}.navbar .spacer{flex:1}.page{max-width:1240px;margin:auto;padding:28px 18px 60px}h1{margin:0 0 5px;font-size:25px}.subtitle{color:#64748b;margin:0 0 22px}.toolbar,.panel,.conversation{background:white;border:1px solid #dfe5ec;border-radius:12px}.toolbar{display:flex;gap:12px;align-items:end;flex-wrap:wrap;padding:16px;margin-bottom:16px}.toolbar label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:#526174}.toolbar input,.toolbar select{min-width:120px;border:1px solid #cbd5e1;border-radius:7px;padding:8px}.button{display:inline-block;border:0;border-radius:8px;padding:9px 13px;background:#0d7a6b;color:white;text-decoration:none;font-weight:700;cursor:pointer}.button.secondary{background:#334155}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;margin-bottom:16px}.summary-card{background:white;border:1px solid #dfe5ec;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:4px}.summary-card span{color:#64748b;font-size:12px}.summary-card strong{font-size:22px}.panel{padding:18px;margin-bottom:16px}.panel h2{font-size:17px;margin:0 0 12px}.diagnosis{font-size:16px}.grid{display:grid;grid-template-columns:2fr 1fr;gap:16px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #e7ebf0;padding:8px;vertical-align:top}th{color:#526174;font-size:12px}code{background:#eef2f7;border-radius:5px;padding:2px 5px;font-size:11px}.recommendations ol{margin:0;padding-left:20px}.recommendations li{margin:7px 0}.conversation{padding:16px;margin-bottom:12px}.conversation-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.conversation-head>div{display:flex;flex-direction:column;gap:3px}.conversation-head span{color:#64748b}.risk{padding:5px 9px;border-radius:999px;font-size:11px;font-weight:800;white-space:nowrap}.risk-high{background:#fee2e2;color:#991b1b}.risk-review{background:#fef3c7;color:#92400e}.risk-ok{background:#dcfce7;color:#166534}.conversation-meta{display:flex;flex-wrap:wrap;gap:12px;color:#64748b;font-size:12px;margin:10px 0}.issues{list-style:none;padding:0;margin:0 0 10px;display:grid;gap:6px}.issue{border-left:4px solid #94a3b8;background:#f8fafc;padding:8px 10px;display:flex;flex-direction:column}.severity-critical{border-color:#7f1d1d}.severity-high{border-color:#dc2626}.severity-medium{border-color:#f59e0b}.severity-low{border-color:#3b82f6}.issue span{color:#526174;font-size:12px}.transcript{display:grid;gap:8px;padding-top:10px}.message{max-width:82%;border-radius:10px;padding:9px 11px;background:#eef2f7}.actor-candidate{margin-left:auto;background:#dcfce7}.actor-human{background:#ede9fe}.actor-reminder,.actor-system{background:#fef3c7}.message-meta{display:flex;gap:8px;align-items:center;font-size:11px;color:#64748b;margin-bottom:4px}.message-body{white-space:pre-wrap}.pagination{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;margin:18px 0}.pagination a{color:#0d7a6b;text-decoration:none;font-weight:700}.pagination a:last-child{text-align:right}.note{color:#64748b;font-size:12px}@media(max-width:800px){.grid{grid-template-columns:1fr}.conversation-head{flex-direction:column}.message{max-width:100%}}
  </style>
</head>
<body>
  <nav class="navbar"><a href="/admin">Panel</a><span>›</span><a href="/admin/estadisticas">Estadísticas</a><span>›</span><a href="/admin/estadisticas/conversation-audit">Auditoría</a><span class="spacer"></span><a href="/logout">Cerrar sesión</a></nav>
  <main class="page">
    <h1>Auditoría conversacional de Lórren</h1>
    <p class="subtitle">Revisa todas las conversaciones del periodo con reglas funcionales y textos anonimizados. Esta consulta no llama a OpenAI ni consume tokens.</p>
    <form class="toolbar" method="get">
      <label>Días a revisar<input type="number" name="days" min="1" max="90" value="${days}"></label>
      <label>Clasificación<select name="risk"><option value="ALL" ${risk === 'ALL' ? 'selected' : ''}>Todas</option><option value="RIESGO_ALTO" ${risk === 'RIESGO_ALTO' ? 'selected' : ''}>Riesgo alto</option><option value="REVISAR" ${risk === 'REVISAR' ? 'selected' : ''}>Por revisar</option><option value="ADECUADA" ${risk === 'ADECUADA' ? 'selected' : ''}>Adecuadas</option></select></label>
      <button class="button" type="submit">Analizar</button>
      <a class="button secondary" href="/admin/estadisticas/conversation-audit/export.json?days=${days}">Descargar JSON anónimo</a>
    </form>
    <section class="summary">${renderSummaryCards(report)}</section>
    <section class="panel"><h2>Diagnóstico automático</h2><p class="diagnosis">${escapeHtml(buildSummaryDiagnosis(report))}</p><p class="note">Periodo: ${escapeHtml(formatDateTimeCO(report.range.start))} a ${escapeHtml(formatDateTimeCO(report.range.end))}. Se revisaron todos los mensajes visibles encontrados, no solo los últimos 100.</p></section>
    <div class="grid">
      <section class="panel table-wrap"><h2>Hallazgos</h2><table><thead><tr><th>Código</th><th>Descripción</th><th>Casos</th></tr></thead><tbody>${renderIssueTable(report)}</tbody></table></section>
      <section class="panel table-wrap"><h2>Origen de mensajes</h2><table><thead><tr><th>Fuente</th><th>Mensajes</th></tr></thead><tbody>${renderSources(report)}</tbody></table></section>
    </div>
    <section class="panel recommendations"><h2>Prioridades sugeridas</h2>${renderRecommendations(report)}</section>
    <h2>Conversaciones</h2>
    ${pagination}
    ${conversations.length ? conversations.map(renderConversation).join('') : '<section class="panel">No hay conversaciones para este filtro.</section>'}
    ${pagination}
    <section class="panel"><h2>Limitaciones conocidas</h2><ul>${report.methodology.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><p class="note">La auditoría sirve para localizar riesgos. Los casos ambiguos deben confirmarse leyendo la transcripción anonimizada y comparándola con el objetivo operativo.</p></section>
  </main>
</body>
</html>`;
}

export function conversationAuditRouter(prisma, dependencies = {}) {
  const router = express.Router();
  const loadReport = dependencies.loadConversationAuditReport || loadConversationAuditReport;

  router.use(requireDev);

  router.get('/', async (req, res) => {
    try {
      const days = asPositiveInt(req.query.days, 15);
      const report = await loadReport(prisma, { days });
      res.set('Cache-Control', 'no-store');
      return res.send(renderConversationAuditPage(report, req.query));
    } catch (error) {
      console.error('[conversation_audit]', error?.message || error);
      return res.status(500).send('No fue posible generar la auditoría conversacional.');
    }
  });

  router.get('/export.json', async (req, res) => {
    try {
      const days = asPositiveInt(req.query.days, 15);
      const report = await loadReport(prisma, { days });
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', `attachment; filename="lorren-auditoria-conversaciones-${days}-dias.json"`);
      return res.json(report);
    } catch (error) {
      console.error('[conversation_audit_export]', error?.message || error);
      return res.status(500).json({ error: 'conversation_audit_failed' });
    }
  });

  return router;
}

export default conversationAuditRouter;
