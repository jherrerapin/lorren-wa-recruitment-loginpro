import express from 'express';
import { PrismaClient } from '@prisma/client';

const BASE_PATH = '/admin/operaciones';
const TOGGLE_PATH_PATTERN = /^\/admin\/operaciones\/personal\/([^/]+)\/toggle$/;
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const DISABLED_WORKER_STATUSES = ['DISABLED', 'INACTIVE', 'ELIMINADO'];
const SCRIPT_MARKER = 'data-dispatch-exit-reasons="true"';
const AUDIT_ACTION = 'DISPATCH_WORKER_EXIT_REASON';
const SUBSTANCE_WORD = 'estupefac' + 'ientes';

const EXIT_REASONS = [
  { code: 'T01_HURTO', category: 'TERMINACION', label: 'Terminación de contrato por hurto' },
  { code: 'T02_AUSENCIAS', category: 'TERMINACION', label: 'Terminación de contrato por ausencias' },
  { code: 'T03_BAJO_RENDIMIENTO', category: 'TERMINACION', label: 'Terminación de contrato por bajo rendimiento' },
  { code: 'T04_PORTE_ARMAS', category: 'TERMINACION', label: 'Terminación de contrato por porte de armas' },
  { code: 'T05_SUSTANCIAS', category: 'TERMINACION', label: `Terminación de contrato por consumo y/o porte de ${SUBSTANCE_WORD}` },
  { code: 'T06_CONFLICTOS', category: 'TERMINACION', label: 'Terminación de contrato por conflictos personales y/o laborales' },
  { code: 'T07_FINALIZACION_LABOR', category: 'TERMINACION', label: 'Terminación de contrato por finalización de labor' },
  { code: 'T08_AVERIAS_DANOS', category: 'TERMINACION', label: 'Terminación de contrato por averías y daños que se niega a pagar' },
  { code: 'T09_PRODUCTO_DINERO', category: 'TERMINACION', label: 'Terminación de contrato por recibir producto y/o dinero' },
  { code: 'R10_ACOSO', category: 'RENUNCIA', label: 'Renuncia por acoso sexual y/o laboral' },
  { code: 'R11_TEMA_PERSONAL', category: 'RENUNCIA', label: 'Renuncia por tema personal' },
  { code: 'R12_PRESION_ESTRES', category: 'RENUNCIA', label: 'Renuncia por presión y estrés' },
  { code: 'R13_FALTA_INDUCCION', category: 'RENUNCIA', label: 'Renuncia por falta de inducción' },
  { code: 'R14_INCUMPLIMIENTO_OFRECIDO', category: 'RENUNCIA', label: 'Renuncia por incumplimiento de lo ofrecido e inconformidad con funciones y política de la empresa' },
  { code: 'R15_JORNADA_EXTENSA', category: 'RENUNCIA', label: 'Renuncia por jornada extensa laboral' },
  { code: 'R16_ENFERMEDAD', category: 'RENUNCIA', label: 'Renuncia por enfermedad' }
];

let prisma = null;
function db() { if (!prisma) prisma = new PrismaClient(); return prisma; }
function text(value) { if (typeof value !== 'string') return null; const out = value.trim(); return out ? out : null; }
function requestPath(req = {}) { return String(req.originalUrl || req.url || '').split('?')[0]; }
function opsAllowed(req = {}) {
  const role = req.session?.userRole || req.userRole;
  const user = text(req.session?.username || req.username);
  return role === 'dev' || Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) || Boolean(user?.startsWith('operaciones-despacho'));
}
function reasonByCode(code) { return EXIT_REASONS.find((reason) => reason.code === code) || null; }
function categoryLabel(category) { return category === 'RENUNCIA' ? 'Renuncia / deserción' : category === 'TERMINACION' ? 'Terminación' : 'Sin categoría'; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function formatDateTime(value) { return value ? new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '-'; }
function addMessage(pathValue, message) {
  const [pathname, query = ''] = String(pathValue || '/admin/operaciones/personal').split('?');
  const params = new URLSearchParams(query);
  params.set('message', message);
  return `${pathname}?${params.toString()}`;
}
function safeBack(req) {
  const referer = req.get?.('referer');
  if (!referer) return '/admin/operaciones/personal';
  try {
    const parsed = new URL(referer);
    const origin = `${req.protocol}://${req.get('host')}`;
    if (parsed.origin === origin && parsed.pathname.startsWith('/admin/operaciones/personal')) return `${parsed.pathname}${parsed.search}`;
  } catch (_error) {}
  return '/admin/operaciones/personal';
}

async function recalculateRequest(prismaClient, serviceRequestId) {
  const serviceRequest = await prismaClient.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true, requiredWorkers: true } });
  if (!serviceRequest) return null;
  const [activeCount, confirmedCount] = await Promise.all([
    prismaClient.dispatchAssignment.count({ where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } } }),
    prismaClient.dispatchAssignment.count({ where: { serviceRequestId, status: CONFIRMED_ASSIGNMENT_STATUS } })
  ]);
  let status = 'PENDING_ASSIGNMENT';
  if (confirmedCount >= serviceRequest.requiredWorkers) status = 'ASSIGNMENT_COMPLETE';
  else if (activeCount >= serviceRequest.requiredWorkers) status = 'PENDING_CONFIRMATION';
  else if (activeCount > 0) status = 'ASSIGNMENT_PARTIAL';
  await prismaClient.dispatchServiceRequest.update({ where: { id: serviceRequestId }, data: { status } });
  return status;
}

function resolveExitReason(req) {
  const reason = reasonByCode(text(req.body?.exitReasonCode));
  if (!reason) {
    const error = new Error('Debes seleccionar una causal de retiro para desactivar el auxiliar.');
    error.statusCode = 400;
    throw error;
  }
  return reason;
}

async function loadActiveAssignments(prismaClient, workerId) {
  return prismaClient.dispatchAssignment.findMany({
    where: { workerId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
    select: { id: true, serviceRequestId: true, status: true }
  });
}

function buildCancelAssignmentOperations(prismaClient, activeAssignments, reasonLabel) {
  return activeAssignments.map((assignment) => prismaClient.dispatchAssignment.updateMany({
    where: { id: assignment.id },
    data: {
      status: assignment.status === CONFIRMED_ASSIGNMENT_STATUS ? 'NO_CONFIRMO' : 'CANCELLED',
      notes: `Auxiliar retirado del flujo. Causal: ${reasonLabel}.`
    }
  }));
}

async function writeExitReasonAudit(prismaClient, worker, req, reason) {
  const actor = text(req.session?.username || req.username) || 'sistema';
  const note = text(req.body?.exitReasonNote);
  try {
    await prismaClient.devAuditEvent.create({
      data: {
        username: actor,
        action: AUDIT_ACTION,
        target: worker.id,
        detail: { reasonCode: reason.code, reasonLabel: reason.label, category: reason.category, note, previousStatus: worker.operationalStatus || null, newStatus: 'DISABLED', workerName: worker.fullName || null }
      }
    });
  } catch (error) {
    console.warn('[DISPATCH_WORKER_EXIT_REASON_AUDIT_FAILED]', {
      workerId: worker.id,
      username: actor,
      reasonCode: reason.code,
      message: error?.message || String(error)
    });
  }
}

async function deactivateWorkerWithAssignments(prismaClient, worker, req) {
  const reason = resolveExitReason(req);
  const activeAssignments = await loadActiveAssignments(prismaClient, worker.id);
  const affectedRequestIds = [...new Set(activeAssignments.map((assignment) => assignment.serviceRequestId))];

  await prismaClient.$transaction([
    prismaClient.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: 'DISABLED' } }),
    ...buildCancelAssignmentOperations(prismaClient, activeAssignments, reason.label)
  ]);

  await writeExitReasonAudit(prismaClient, worker, req, reason);

  const recalculations = await Promise.allSettled(affectedRequestIds.map((id) => recalculateRequest(prismaClient, id)));
  const recalculationFailures = recalculations.filter((result) => result.status === 'rejected').length;
  if (recalculationFailures) {
    console.warn('[DISPATCH_WORKER_DEACTIVATION_RECALCULATE_FAILED]', {
      workerId: worker.id,
      affectedRequestIds,
      recalculationFailures
    });
  }

  return { reason, affectedRequestIds, recalculationFailures };
}

async function handleToggle(req, res, next, workerId) {
  if (!opsAllowed(req)) return res.status(403).send('Módulo no habilitado para este usuario');
  const prismaClient = db();
  const worker = await prismaClient.dispatchWorker.findUnique({ where: { id: workerId }, select: { id: true, fullName: true, operationalStatus: true } });
  if (!worker) return res.redirect(addMessage(safeBack(req), 'No se encontró el auxiliar. Recarga la lista e intenta nuevamente.'));
  try {
    if (worker.operationalStatus === 'CONTRATADO') {
      const { reason, affectedRequestIds, recalculationFailures } = await deactivateWorkerWithAssignments(prismaClient, worker, req);
      const extra = affectedRequestIds.length ? ` Se cancelaron sus asignaciones activas en ${affectedRequestIds.length} solicitud${affectedRequestIds.length !== 1 ? 'es' : ''}.` : '';
      const warning = recalculationFailures ? ' Algunas solicitudes requieren refrescar el tablero para ver el estado actualizado.' : '';
      return res.redirect(`/admin/operaciones/personal?status=DISABLED&message=${encodeURIComponent(`Auxiliar desactivado. Causal: ${reason.label}.${extra}${warning}`)}`);
    }
    await prismaClient.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: 'CONTRATADO' } });
    return res.redirect(addMessage(safeBack(req), 'Auxiliar reactivado. Ya aparece disponible para asignaciones.'));
  } catch (error) {
    if (error.statusCode === 400) return res.redirect(addMessage(safeBack(req), error.message));
    console.error('[DISPATCH_WORKER_TOGGLE_ERROR]', {
      workerId,
      path: requestPath(req),
      username: text(req.session?.username || req.username),
      message: error?.message || String(error),
      stack: error?.stack || null
    });
    return res.redirect(addMessage(safeBack(req), 'No fue posible actualizar el estado del auxiliar. Recarga el listado e intenta nuevamente.'));
  }
}

function detailFromAudit(row) {
  return row?.detail && typeof row.detail === 'object' ? row.detail : {};
}

async function statsPayload(workerIds = []) {
  const rows = await db().devAuditEvent.findMany({ where: { action: AUDIT_ACTION }, select: { target: true, detail: true, createdAt: true, username: true }, orderBy: { createdAt: 'desc' }, take: 1000 });
  const countMap = new Map();
  const workers = {};
  for (const row of rows) {
    const detail = detailFromAudit(row);
    const label = detail.reasonLabel || 'Sin causal';
    countMap.set(label, (countMap.get(label) || 0) + 1);
    if (workerIds.includes(row.target) && !workers[row.target]) workers[row.target] = { label, note: detail.note || null, createdAt: row.createdAt, by: row.username || null };
  }
  const stats = [...countMap.entries()].map(([label, count]) => ({ reasonLabel: label, count })).sort((a, b) => b.count - a.count || a.reasonLabel.localeCompare(b.reasonLabel, 'es'));
  return { reasons: EXIT_REASONS, stats, workers };
}

async function retirementStatsPayload() {
  const prismaClient = db();
  const [rows, disabledCount] = await Promise.all([
    prismaClient.devAuditEvent.findMany({
      where: { action: AUDIT_ACTION },
      select: { target: true, detail: true, createdAt: true, username: true },
      orderBy: { createdAt: 'desc' },
      take: 2000
    }),
    prismaClient.dispatchWorker.count({ where: { operationalStatus: { in: DISABLED_WORKER_STATUSES } } })
  ]);

  const byReason = new Map();
  const byCategory = new Map();
  const workerIdsWithReason = new Set();

  for (const row of rows) {
    if (row.target) workerIdsWithReason.add(row.target);
    const detail = detailFromAudit(row);
    const label = detail.reasonLabel || 'Sin causal registrada';
    const category = detail.category || 'SIN_CATEGORIA';
    const reasonItem = byReason.get(label) || { label, category, count: 0 };
    reasonItem.count += 1;
    byReason.set(label, reasonItem);
    byCategory.set(category, (byCategory.get(category) || 0) + 1);
  }

  const reasons = [...byReason.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'));
  const maxReasonCount = Math.max(1, ...reasons.map((item) => item.count));
  const missingReasonCount = Math.max(0, disabledCount - workerIdsWithReason.size);

  return {
    totalRegistered: rows.length,
    currentInactive: disabledCount,
    terminations: byCategory.get('TERMINACION') || 0,
    resignations: byCategory.get('RENUNCIA') || 0,
    missingReasonCount,
    reasons,
    maxReasonCount,
    latest: rows.slice(0, 30).map((row) => ({
      target: row.target,
      detail: detailFromAudit(row),
      createdAt: row.createdAt,
      username: row.username
    }))
  };
}

function renderReasonRows(payload) {
  if (!payload.reasons.length) return '<div class="empty"><strong>Sin causales registradas.</strong>Cuando desactives auxiliares con causal, aquí aparecerán los motivos acumulados.</div>';
  return payload.reasons.map((item) => {
    const width = Math.max(6, Math.round((item.count / payload.maxReasonCount) * 100));
    return `<div class="reason-row"><div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(categoryLabel(item.category))}</span></div><div class="bar"><i style="width:${width}%"></i></div><strong>${item.count}</strong></div>`;
  }).join('');
}

function renderLatestRows(payload) {
  if (!payload.latest.length) return '<tr><td colspan="4" class="muted">Sin registros recientes.</td></tr>';
  return payload.latest.map((row) => {
    const label = row.detail.reasonLabel || 'Sin causal';
    const category = categoryLabel(row.detail.category);
    const name = row.detail.workerName || row.target || 'Auxiliar';
    return `<tr><td><strong>${escapeHtml(name)}</strong></td><td>${escapeHtml(label)}<div class="muted">${escapeHtml(category)}</div></td><td>${escapeHtml(formatDateTime(row.createdAt))}</td><td>${escapeHtml(row.username || 'Sin usuario')}</td></tr>`;
  }).join('');
}

async function renderRetirementStatsPage(_req, res) {
  const payload = await retirementStatsPayload();
  return res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Estadísticas de retiros — LoginPro</title>
  <link rel="icon" type="image/png" href="/public/favicon-loginpro.svg" />
  <style>
    *{box-sizing:border-box;margin:0;padding:0}:root{--bg:#f4f5f7;--surface:#fff;--surface-2:#f9fafb;--border:#e1e4e8;--text:#1a1d23;--muted:#6b7280;--navy:#1e2d3d;--teal:#0d7a6b;--red:#b91c1c;--red-light:#fee2e2;--amber:#92400e;--amber-light:#fef3c7;--green:#166534;--green-light:#dcfce7;--blue:#1d4ed8;--blue-light:#dbeafe;--shadow-sm:0 1px 3px rgba(0,0,0,.08);--shadow-md:0 10px 28px rgba(15,23,42,.08);--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}body{font-family:var(--font);background:var(--bg);color:var(--text);font-size:14px}.navbar{background:var(--navy);padding:0 24px;display:flex;align-items:center;gap:20px;min-height:52px;box-shadow:0 2px 8px rgba(0,0,0,.2)}.navbar a{color:#cbd5e0;text-decoration:none;font-size:13px;font-weight:600;padding:4px 2px;border-bottom:2px solid transparent}.navbar a:hover,.navbar a.nav-active{color:#fff;border-bottom-color:#4fd1c5}.navbar .brand img{height:28px;display:block}.navbar .spacer{flex:1}.page{max-width:1240px;margin:0 auto;padding:28px 20px 60px;display:grid;gap:18px}.hero{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap;background:linear-gradient(135deg,#fff 0%,#fff7ed 100%);border:1px solid var(--border);border-radius:18px;padding:24px;box-shadow:var(--shadow-md)}.eyebrow{color:var(--amber);font-size:12px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}h1{color:var(--navy);font-size:28px;line-height:1.15;margin-bottom:8px}.subtitle{color:var(--muted);line-height:1.6;max-width:760px}.actions{display:flex;gap:10px;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border:1px solid var(--border);border-radius:8px;padding:7px 13px;background:var(--surface);color:var(--navy);text-decoration:none;font-size:12px;font-weight:800;cursor:pointer;box-shadow:var(--shadow-sm);white-space:nowrap}.btn-primary{background:var(--teal);border-color:var(--teal);color:#fff}.cards{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px;box-shadow:var(--shadow-sm)}.card span{display:block;color:var(--muted);font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}.card strong{display:block;color:var(--navy);font-size:28px;margin-top:6px}.card small{display:block;color:var(--muted);font-size:12px;margin-top:4px}.panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow-sm);overflow:hidden}.panel-head{padding:16px 20px;border-bottom:1px solid #eaecef}.panel-head h2{color:var(--navy);font-size:17px}.panel-head p{color:var(--muted);font-size:13px;margin-top:2px}.reason-list{display:grid;gap:10px;padding:18px 20px}.reason-row{display:grid;grid-template-columns:minmax(220px,1.4fr) minmax(180px,2fr) 52px;gap:12px;align-items:center}.reason-row span{display:block;color:var(--muted);font-size:12px;margin-top:3px}.bar{height:12px;border-radius:999px;background:#f3f4f6;overflow:hidden}.bar i{display:block;height:100%;background:var(--amber);border-radius:999px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:780px}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #eaecef;vertical-align:top}th{background:var(--surface-2);color:var(--muted);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.06em}.muted{color:var(--muted)}.empty{padding:28px 20px;text-align:center;color:var(--muted)}.empty strong{display:block;color:var(--navy);font-size:16px;margin-bottom:6px}@media(max-width:980px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.reason-row{grid-template-columns:1fr}.navbar{flex-wrap:wrap;height:auto;padding:10px 16px}.navbar .spacer{display:none}}@media(max-width:640px){.cards{grid-template-columns:1fr}.page{padding:18px 14px 42px}.actions,.btn{width:100%}}
  </style>
</head>
<body>
  <nav class="navbar"><a class="brand" href="/admin" aria-label="LoginPro"><img src="/public/logo-loginpro.svg" alt="LoginPro" /></a><a href="/admin">Panel</a><a href="/admin/operaciones" class="nav-active">Operaciones / Despacho</a><a href="/admin/operaciones/personal">Personal operativo</a><span class="spacer"></span></nav>
  <main class="page">
    <section class="hero"><div><div class="eyebrow">Retiros de auxiliares</div><h1>Estadísticas de despidos y deserciones</h1><p class="subtitle">Resumen de causales registradas al desactivar auxiliares. Sirve para identificar por qué se van o por qué se retiran del flujo operativo.</p></div><div class="actions"><a class="btn" href="/admin/operaciones/personal">Volver al personal</a><a class="btn btn-primary" href="/admin/operaciones/personal?status=DISABLED">Ver desactivados</a></div></section>
    <section class="cards"><article class="card"><span>Retiros registrados</span><strong>${payload.totalRegistered}</strong><small>Casos con causal guardada</small></article><article class="card"><span>Terminaciones</span><strong>${payload.terminations}</strong><small>Auxiliares retirados por causal de empresa</small></article><article class="card"><span>Renuncias / deserciones</span><strong>${payload.resignations}</strong><small>Casos informados como renuncia</small></article><article class="card"><span>Desactivados actuales</span><strong>${payload.currentInactive}</strong><small>Auxiliares fuera del flujo hoy</small></article><article class="card"><span>Sin causal</span><strong>${payload.missingReasonCount}</strong><small>Desactivados que requieren revisión</small></article></section>
    <section class="panel"><div class="panel-head"><h2>Motivos principales</h2><p>La barra más larga corresponde al motivo más repetido.</p></div><div class="reason-list">${renderReasonRows(payload)}</div></section>
    <section class="panel"><div class="panel-head"><h2>Últimos retiros registrados</h2><p>Detalle reciente para revisar auxiliares, causal, fecha y usuario que registró la salida.</p></div><div class="table-wrap"><table><thead><tr><th>Auxiliar</th><th>Causal</th><th>Fecha registro</th><th>Usuario</th></tr></thead><tbody>${renderLatestRows(payload)}</tbody></table></div></section>
  </main>
</body>
</html>`);
}

function installRouterPatch() {
  if (express.__dispatchWorkerExitReasonRouterInstalled) return;
  const originalRouter = express.Router;
  express.Router = function patchedRouter(...args) {
    const router = originalRouter.apply(express, args);
    router.use(async (req, res, next) => {
      const path = requestPath(req);
      if (req.method === 'POST') {
        const match = path.match(TOGGLE_PATH_PATTERN);
        if (match) return handleToggle(req, res, next, decodeURIComponent(match[1]));
      }
      if (req.method === 'GET' && path === `${BASE_PATH}/personal/exit-reasons`) {
        if (!opsAllowed(req)) return res.status(403).json({ ok: false });
        const workerIds = String(req.query?.workerIds || '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 500);
        return res.json({ ok: true, ...(await statsPayload(workerIds)) });
      }
      if (req.method === 'GET' && path === `${BASE_PATH}/personal/retiros`) {
        if (!opsAllowed(req)) return res.status(403).send('Módulo no habilitado para este usuario');
        return renderRetirementStatsPage(req, res);
      }
      return next();
    });
    return router;
  };
  Object.assign(express.Router, originalRouter);
  express.__dispatchWorkerExitReasonRouterInstalled = true;
}

function uiScript() {
  return `<script ${SCRIPT_MARKER}>
(function(){
  var reasons = ${JSON.stringify(EXIT_REASONS)};
  function h(v){return String(v||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function n(v){return String(v||'').trim().toLowerCase();}
  function opts(){return reasons.map(function(r){return '<option value="'+h(r.code)+'">'+h(r.label)+'</option>';}).join('');}
  var selectedForm=null;
  function ensureRetirementStatsLink(){
    var actions=document.querySelector('.hero-actions');
    if(!actions||actions.querySelector('[data-retirement-stats-link]'))return;
    var a=document.createElement('a');
    a.className='btn btn-secondary';
    a.href='/admin/operaciones/personal/retiros';
    a.setAttribute('data-retirement-stats-link','true');
    a.textContent='Estadísticas de retiros';
    actions.insertBefore(a, actions.firstChild);
  }
  function modal(){
    var m=document.getElementById('exit-reason-modal');
    if(m) return m;
    m=document.createElement('div');
    m.className='modal-overlay';
    m.id='exit-reason-modal';
    m.innerHTML='<div class="modal"><h3>Desactivar auxiliar</h3><p>Selecciona la causal de retiro. Esta información alimentará las estadísticas del módulo de despacho.</p><div class="field" style="margin-bottom:12px"><label>Causal de retiro *</label><select id="exitReasonCode" required><option value="">Selecciona una causal</option>'+opts()+'</select></div><div class="field" style="margin-bottom:16px"><label>Nota opcional</label><textarea id="exitReasonNote" rows="3" style="width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-family:inherit"></textarea></div><div class="modal-actions"><button type="button" class="btn btn-secondary" id="exitReasonCancel">Cancelar</button><button type="button" class="btn btn-danger" id="exitReasonConfirm">Desactivar auxiliar</button></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click',function(e){if(e.target===m)m.classList.remove('open')});
    document.getElementById('exitReasonCancel').addEventListener('click',function(){m.classList.remove('open')});
    return m;
  }
  document.querySelectorAll('form[action*="/admin/operaciones/personal/"][action$="/toggle"]').forEach(function(form){
    var b=form.querySelector('button[type="submit"]');
    if(!b||n(b.textContent)!=='desactivar') return;
    form.addEventListener('submit',function(e){
      e.preventDefault();
      selectedForm=form;
      modal().classList.add('open');
      document.getElementById('exitReasonCode').value='';
      document.getElementById('exitReasonNote').value='';
      document.getElementById('exitReasonCode').focus();
    });
  });
  document.addEventListener('click',function(e){
    if(!e.target||e.target.id!=='exitReasonConfirm')return;
    var code=document.getElementById('exitReasonCode');
    var note=document.getElementById('exitReasonNote');
    if(!code.value){code.focus();return;}
    selectedForm.querySelectorAll('input[name="exitReasonCode"],input[name="exitReasonNote"]').forEach(function(i){i.remove()});
    var a=document.createElement('input'); a.type='hidden'; a.name='exitReasonCode'; a.value=code.value;
    var b=document.createElement('input'); b.type='hidden'; b.name='exitReasonNote'; b.value=note.value||'';
    selectedForm.appendChild(a); selectedForm.appendChild(b); selectedForm.submit();
  });
  function loadStats(){
    var table=document.getElementById('workers-table');
    if(!table)return;
    var rows=[].slice.call(table.querySelectorAll('tbody tr[data-id]'));
    var ids=rows.map(function(r){return r.dataset.id}).filter(Boolean);
    fetch('/admin/operaciones/personal/exit-reasons?workerIds='+encodeURIComponent(ids.join(',')),{credentials:'include'})
      .then(function(r){return r.json()})
      .then(function(p){
        if(!p||!p.ok)return;
        var workers=p.workers||{};
        var disabled=rows.filter(function(row){return workers[row.dataset.id]&&workers[row.dataset.id].label});
        if(disabled.length){
          var head=table.querySelector('thead tr');
          if(head&&!head.querySelector('[data-exit-head]')){
            var th=document.createElement('th'); th.textContent='Causal retiro'; th.setAttribute('data-exit-head','true'); head.insertBefore(th,head.lastElementChild);
          }
          disabled.forEach(function(row){
            if(row.querySelector('[data-exit-cell]'))return;
            var data=workers[row.dataset.id];
            var td=document.createElement('td'); td.setAttribute('data-exit-cell','true');
            td.innerHTML='<span class="pill pill-red">'+h(data.label)+'</span>'+(data.note?'<br><span class="muted">'+h(data.note)+'</span>':'');
            row.insertBefore(td,row.lastElementChild);
          });
        }
      }).catch(function(){});
  }
  ensureRetirementStatsLink();
  loadStats();
})();
</script>`;
}

function installUiPatch() {
  if (express.response.__dispatchWorkerExitReasonUiInstalled) return;
  const originalSend = express.response.send;
  express.response.send = function patchedSend(body) {
    let out = body;
    if (typeof out === 'string' && requestPath(this.req) === `${BASE_PATH}/personal` && this.req.method === 'GET' && out.includes('</body>') && !out.includes(SCRIPT_MARKER)) out = out.replace('</body>', uiScript() + '\n</body>');
    return originalSend.call(this, out);
  };
  express.response.__dispatchWorkerExitReasonUiInstalled = true;
}

installRouterPatch();
installUiPatch();
