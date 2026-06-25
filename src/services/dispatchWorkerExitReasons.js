import express from 'express';
import { PrismaClient } from '@prisma/client';

const BASE_PATH = '/admin/operaciones';
const TOGGLE_PATH_PATTERN = /^\/admin\/operaciones\/personal\/([^/]+)\/toggle$/;
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const DISPATCH_OWNED_SOURCES = ['MANUAL', 'EXCEL_IMPORT'];
const SCRIPT_MARKER = 'data-dispatch-exit-reasons="true"';
const INCIDENT_TYPE = 'WORKER_EXIT_REASON';
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
function opsAllowed(req = {}) { const role = req.session?.userRole || req.userRole; const user = text(req.session?.username || req.username); return role === 'dev' || Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) || Boolean(user?.startsWith('operaciones-despacho')); }
function reasonByCode(code) { return EXIT_REASONS.find((reason) => reason.code === code) || null; }
function addMessage(pathValue, message) { const [pathname, query = ''] = String(pathValue || '/admin/operaciones/personal').split('?'); const params = new URLSearchParams(query); params.set('message', message); return `${pathname}?${params.toString()}`; }
function safeBack(req) { const referer = req.get?.('referer'); if (!referer) return '/admin/operaciones/personal'; try { const parsed = new URL(referer); const origin = `${req.protocol}://${req.get('host')}`; if (parsed.origin === origin && parsed.pathname.startsWith('/admin/operaciones/personal')) return `${parsed.pathname}${parsed.search}`; } catch (_error) {} return '/admin/operaciones/personal'; }

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

async function cancelAssignments(prismaClient, workerId, reasonLabel) {
  const activeAssignments = await prismaClient.dispatchAssignment.findMany({ where: { workerId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } }, select: { id: true, serviceRequestId: true, status: true } });
  if (!activeAssignments.length) return [];
  const affectedRequestIds = [...new Set(activeAssignments.map((assignment) => assignment.serviceRequestId))];
  await prismaClient.$transaction(activeAssignments.map((assignment) => prismaClient.dispatchAssignment.update({
    where: { id: assignment.id },
    data: { status: assignment.status === CONFIRMED_ASSIGNMENT_STATUS ? 'NO_CONFIRMO' : 'CANCELLED', notes: `Auxiliar retirado del flujo. Causal: ${reasonLabel}.` }
  })));
  await Promise.all(affectedRequestIds.map((id) => recalculateRequest(prismaClient, id)));
  return affectedRequestIds;
}

async function saveExitReason(prismaClient, worker, req) {
  const reason = reasonByCode(text(req.body?.exitReasonCode));
  if (!reason) { const error = new Error('Debes seleccionar una causal de retiro para desactivar el auxiliar.'); error.statusCode = 400; throw error; }
  const note = text(req.body?.exitReasonNote);
  const actor = text(req.session?.username || req.username);
  await prismaClient.$transaction([
    prismaClient.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: 'DISABLED' } }),
    prismaClient.dispatchIncident.create({
      data: {
        serviceRequestId: worker.lastServiceRequestId,
        workerId: worker.id,
        type: INCIDENT_TYPE,
        status: 'RESOLVED',
        description: reason.label,
        reportedBy: actor,
        resolutionNote: note,
        createdByUsername: actor,
        resolvedByUsername: actor,
        resolvedAt: new Date()
      }
    })
  ]);
  return reason;
}

async function handleToggle(req, res, next, workerId) {
  if (!opsAllowed(req)) return res.status(403).send('Módulo no habilitado para este usuario');
  const prismaClient = db();
  const worker = await prismaClient.dispatchWorker.findFirst({
    where: { id: workerId, source: { in: DISPATCH_OWNED_SOURCES } },
    select: { id: true, fullName: true, operationalStatus: true, assignments: { orderBy: { createdAt: 'desc' }, take: 1, select: { serviceRequestId: true } } }
  });
  if (!worker) return res.status(404).send('Auxiliar no encontrado o no editable desde este módulo');
  const lastServiceRequestId = worker.assignments?.[0]?.serviceRequestId || null;
  if (!lastServiceRequestId && worker.operationalStatus === 'CONTRATADO') return res.redirect(addMessage(safeBack(req), 'No fue posible registrar la causal: el auxiliar no tiene una solicitud operativa asociada para guardar la novedad.'));
  const workerContext = { ...worker, lastServiceRequestId };
  try {
    if (worker.operationalStatus === 'CONTRATADO') {
      const reason = await saveExitReason(prismaClient, workerContext, req);
      const affected = await cancelAssignments(prismaClient, worker.id, reason.label);
      const extra = affected.length ? ` Se cancelaron sus asignaciones activas en ${affected.length} solicitud${affected.length !== 1 ? 'es' : ''}.` : '';
      return res.redirect(`/admin/operaciones/personal?status=DISABLED&message=${encodeURIComponent(`Auxiliar desactivado. Causal: ${reason.label}.${extra}`)}`);
    }
    await prismaClient.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: 'CONTRATADO' } });
    return res.redirect(addMessage(safeBack(req), 'Auxiliar reactivado. Ya aparece disponible para asignaciones.'));
  } catch (error) {
    if (error.statusCode === 400) return res.redirect(addMessage(safeBack(req), error.message));
    return next(error);
  }
}

async function statsPayload(workerIds = []) {
  const prismaClient = db();
  const rows = await prismaClient.dispatchIncident.findMany({ where: { type: INCIDENT_TYPE }, select: { workerId: true, description: true, resolutionNote: true, createdAt: true, createdByUsername: true }, orderBy: { createdAt: 'desc' }, take: 1000 });
  const countMap = new Map();
  const workers = {};
  for (const row of rows) {
    const label = row.description || 'Sin causal';
    countMap.set(label, (countMap.get(label) || 0) + 1);
    if (workerIds.includes(row.workerId) && !workers[row.workerId]) workers[row.workerId] = { label, note: row.resolutionNote || null, createdAt: row.createdAt, by: row.createdByUsername || null };
  }
  const stats = [...countMap.entries()].map(([label, count]) => ({ reasonLabel: label, count })).sort((a, b) => b.count - a.count || a.reasonLabel.localeCompare(b.reasonLabel, 'es'));
  return { reasons: EXIT_REASONS, stats, workers };
}

function installRouterPatch() {
  if (express.__dispatchWorkerExitReasonRouterInstalled) return;
  const originalRouter = express.Router;
  express.Router = function patchedRouter(...args) {
    const router = originalRouter.apply(express, args);
    router.use(async (req, res, next) => {
      const path = requestPath(req);
      if (req.method === 'POST') { const match = path.match(TOGGLE_PATH_PATTERN); if (match) return handleToggle(req, res, next, decodeURIComponent(match[1])); }
      if (req.method === 'GET' && path === `${BASE_PATH}/personal/exit-reasons`) {
        if (!opsAllowed(req)) return res.status(403).json({ ok: false });
        const workerIds = String(req.query?.workerIds || '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 500);
        return res.json({ ok: true, ...(await statsPayload(workerIds)) });
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
  function modal(){var m=document.getElementById('exit-reason-modal'); if(m) return m; m=document.createElement('div'); m.className='modal-overlay'; m.id='exit-reason-modal'; m.innerHTML='<div class="modal"><h3>Desactivar auxiliar</h3><p>Selecciona la causal de retiro. Esta información alimentará las estadísticas del módulo de despacho.</p><div class="field" style="margin-bottom:12px"><label>Causal de retiro *</label><select id="exitReasonCode" required><option value="">Selecciona una causal</option>'+opts()+'</select></div><div class="field" style="margin-bottom:16px"><label>Nota opcional</label><textarea id="exitReasonNote" rows="3" style="width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-family:inherit"></textarea></div><div class="modal-actions"><button type="button" class="btn btn-secondary" id="exitReasonCancel">Cancelar</button><button type="button" class="btn btn-danger" id="exitReasonConfirm">Desactivar auxiliar</button></div></div>'; document.body.appendChild(m); m.addEventListener('click',function(e){if(e.target===m)m.classList.remove('open')}); document.getElementById('exitReasonCancel').addEventListener('click',function(){m.classList.remove('open')}); return m;}
  document.querySelectorAll('form[action*="/admin/operaciones/personal/"][action$="/toggle"]').forEach(function(form){var b=form.querySelector('button[type="submit"]'); if(!b||n(b.textContent)!=='desactivar') return; form.addEventListener('submit',function(e){e.preventDefault(); selectedForm=form; modal().classList.add('open'); document.getElementById('exitReasonCode').value=''; document.getElementById('exitReasonNote').value=''; document.getElementById('exitReasonCode').focus();});});
  document.addEventListener('click',function(e){if(!e.target||e.target.id!=='exitReasonConfirm')return; var code=document.getElementById('exitReasonCode'); var note=document.getElementById('exitReasonNote'); if(!code.value){code.focus();return;} selectedForm.querySelectorAll('input[name="exitReasonCode"],input[name="exitReasonNote"]').forEach(function(i){i.remove()}); var a=document.createElement('input'); a.type='hidden'; a.name='exitReasonCode'; a.value=code.value; var b=document.createElement('input'); b.type='hidden'; b.name='exitReasonNote'; b.value=note.value||''; selectedForm.appendChild(a); selectedForm.appendChild(b); selectedForm.submit();});
  function loadStats(){var table=document.getElementById('workers-table'); if(!table)return; var rows=[].slice.call(table.querySelectorAll('tbody tr[data-id]')); var ids=rows.map(function(r){return r.dataset.id}).filter(Boolean); fetch('/admin/operaciones/personal/exit-reasons?workerIds='+encodeURIComponent(ids.join(',')),{credentials:'include'}).then(function(r){return r.json()}).then(function(p){if(!p||!p.ok)return; var workers=p.workers||{}; var disabled=rows.filter(function(row){return workers[row.dataset.id]&&workers[row.dataset.id].label}); if(disabled.length){var head=table.querySelector('thead tr'); if(head&&!head.querySelector('[data-exit-head]')){var th=document.createElement('th'); th.textContent='Causal retiro'; th.setAttribute('data-exit-head','true'); head.insertBefore(th,head.lastElementChild);} disabled.forEach(function(row){if(row.querySelector('[data-exit-cell]'))return; var data=workers[row.dataset.id]; var td=document.createElement('td'); td.setAttribute('data-exit-cell','true'); td.innerHTML='<span class="pill pill-red">'+h(data.label)+'</span>'+(data.note?'<br><span class="muted">'+h(data.note)+'</span>':''); row.insertBefore(td,row.lastElementChild);});} if(p.stats&&p.stats.length&&!document.getElementById('exit-reason-stats')){var panel=document.querySelector('.panel'); var card=document.createElement('section'); card.className='filters-card'; card.id='exit-reason-stats'; card.innerHTML='<div class="filters-head"><h2>Causales de retiro</h2><p>Resumen histórico de auxiliares desactivados por causal.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap">'+p.stats.slice(0,6).map(function(s){return '<span class="pill pill-red">'+h(s.reasonLabel)+' · '+Number(s.count||0)+'</span>';}).join('')+'</div>'; if(panel)panel.parentNode.insertBefore(card,panel);}}).catch(function(){});}
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
