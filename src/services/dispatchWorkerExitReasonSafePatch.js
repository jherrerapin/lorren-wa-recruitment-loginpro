import express from 'express';
import { PrismaClient } from '@prisma/client';

const BASE_PATH = '/admin/operaciones';
const TOGGLE_RE = /^\/admin\/operaciones\/personal\/([^/]+)\/toggle$/;
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const PENDING_REQUEST_STATUSES = ['PENDING_ASSIGNMENT', 'ASSIGNMENT_PARTIAL', 'PENDING_CONFIRMATION'];
const OPEN_INCIDENT_STATUSES = ['OPEN', 'IN_PROGRESS'];
const MARKER = 'data-dispatch-exit-reason-safe="true"';
const NOTE_PREFIX = '[CAUSAL_RETIRO]';
const SUBSTANCE_WORD = 'estupefac' + 'ientes';

const EXIT_REASONS = [
  { code: 'T01_HURTO', label: 'Terminación de contrato por hurto' },
  { code: 'T02_AUSENCIAS', label: 'Terminación de contrato por ausencias' },
  { code: 'T03_BAJO_RENDIMIENTO', label: 'Terminación de contrato por bajo rendimiento' },
  { code: 'T04_PORTE_ARMAS', label: 'Terminación de contrato por porte de armas' },
  { code: 'T05_SUSTANCIAS', label: `Terminación de contrato por consumo y/o porte de ${SUBSTANCE_WORD}` },
  { code: 'T06_CONFLICTOS', label: 'Terminación de contrato por conflictos personales y/o laborales' },
  { code: 'T07_FINALIZACION_LABOR', label: 'Terminación de contrato por finalización de labor' },
  { code: 'T08_AVERIAS_DANOS', label: 'Terminación de contrato por averías y daños que se niega a pagar' },
  { code: 'T09_PRODUCTO_DINERO', label: 'Terminación de contrato por recibir producto y/o dinero' },
  { code: 'R10_ACOSO', label: 'Renuncia por acoso sexual y/o laboral' },
  { code: 'R11_TEMA_PERSONAL', label: 'Renuncia por tema personal' },
  { code: 'R12_PRESION_ESTRES', label: 'Renuncia por presión y estrés' },
  { code: 'R13_FALTA_INDUCCION', label: 'Renuncia por falta de inducción' },
  { code: 'R14_INCUMPLIMIENTO_OFRECIDO', label: 'Renuncia por incumplimiento de lo ofrecido e inconformidad con funciones y política de la empresa' },
  { code: 'R15_JORNADA_EXTENSA', label: 'Renuncia por jornada extensa laboral' },
  { code: 'R16_ENFERMEDAD', label: 'Renuncia por enfermedad' }
];

let prisma;
function db() { if (!prisma) prisma = new PrismaClient(); return prisma; }
function clean(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function pathOf(req = {}) { return String(req.originalUrl || req.url || '').split('?')[0]; }
function reasonByCode(code) { return EXIT_REASONS.find((item) => item.code === code) || null; }
function canUseOps(req = {}) {
  const role = req.session?.userRole || req.userRole;
  const username = clean(req.session?.username || req.username) || '';
  return role === 'dev' || Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) || username.startsWith('operaciones-despacho');
}
function redirectBack(req, message) {
  const referer = req.get?.('referer') || '/admin/operaciones/personal';
  const separator = referer.includes('?') ? '&' : '?';
  return `${referer}${separator}message=${encodeURIComponent(message)}`;
}
function todayCO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function normalizeDateParam(value, fallback = todayCO()) {
  const raw = clean(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fallback;
  return raw;
}
function selectedDateFromRequest(req = {}) {
  return normalizeDateParam(req.query?.fecha || req.query?.date);
}
function dayRange(dateText) {
  const start = new Date(`${dateText}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}
function html(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function reasonNote(reason, note) {
  return `${NOTE_PREFIX} ${reason.label}${note ? ` | Nota: ${note}` : ''}`;
}
function extractReasonFromNotes(notes) {
  const text = String(notes || '');
  const index = text.lastIndexOf(NOTE_PREFIX);
  if (index < 0) return null;
  const raw = text.slice(index + NOTE_PREFIX.length).split('\n')[0].trim();
  return raw.split('|')[0].trim() || null;
}
function buildOperationalCityFilter(operationalCityId) {
  return operationalCityId ? { cities: { some: { cityId: operationalCityId } } } : {};
}
function buildWorkerSearchFilter(q) {
  return q ? { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { documentNumber: { contains: q, mode: 'insensitive' } }, { phone: { contains: q, mode: 'insensitive' } }] } : {};
}
function cleanStrings(rows, field) {
  return [...new Set(rows.map((row) => clean(row?.[field])).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
}
function scheduleLabel(request) {
  return request?.endTime ? `${request.startTime || '-'} - ${request.endTime}` : `${request?.startTime || '-'}`;
}
async function recalculateServiceRequest(prismaClient, serviceRequestId) {
  const request = await prismaClient.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { requiredWorkers: true } });
  if (!request) return;
  const [activeCount, confirmedCount] = await Promise.all([
    prismaClient.dispatchAssignment.count({ where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } } }),
    prismaClient.dispatchAssignment.count({ where: { serviceRequestId, status: CONFIRMED_ASSIGNMENT_STATUS } })
  ]);
  let status = 'PENDING_ASSIGNMENT';
  if (confirmedCount >= request.requiredWorkers) status = 'ASSIGNMENT_COMPLETE';
  else if (activeCount >= request.requiredWorkers) status = 'PENDING_CONFIRMATION';
  else if (activeCount > 0) status = 'ASSIGNMENT_PARTIAL';
  await prismaClient.dispatchServiceRequest.update({ where: { id: serviceRequestId }, data: { status } });
}
async function cancelActiveAssignments(prismaClient, workerId, label) {
  const assignments = await prismaClient.dispatchAssignment.findMany({ where: { workerId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } }, select: { id: true, serviceRequestId: true, status: true } });
  if (!assignments.length) return 0;
  await prismaClient.$transaction(assignments.map((item) => prismaClient.dispatchAssignment.update({
    where: { id: item.id },
    data: { status: item.status === CONFIRMED_ASSIGNMENT_STATUS ? 'NO_CONFIRMO' : 'CANCELLED', notes: `Auxiliar desactivado desde personal. Causal: ${label}.` }
  })));
  const requestIds = [...new Set(assignments.map((item) => item.serviceRequestId))];
  await Promise.allSettled(requestIds.map((id) => recalculateServiceRequest(prismaClient, id)));
  return requestIds.length;
}
async function handleToggle(req, res, next, workerId) {
  try {
    if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario');
    const prismaClient = db();
    const worker = await prismaClient.dispatchWorker.findUnique({ where: { id: workerId }, select: { id: true, fullName: true, operationalStatus: true, notes: true } });
    if (!worker) return res.redirect(redirectBack(req, 'No se encontró el auxiliar. Recarga el listado e intenta nuevamente.'));
    if (worker.operationalStatus === 'CONTRATADO') {
      const reason = reasonByCode(clean(req.body?.exitReasonCode));
      if (!reason) return res.redirect(redirectBack(req, 'Debes seleccionar una causal de retiro para desactivar el auxiliar.'));
      const note = clean(req.body?.exitReasonNote);
      const nextNotes = [worker.notes, reasonNote(reason, note)].filter(Boolean).join('\n');
      await prismaClient.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: 'DISABLED', notes: nextNotes } });
      const affected = await cancelActiveAssignments(prismaClient, worker.id, reason.label);
      const extra = affected ? ` Se cancelaron asignaciones activas en ${affected} solicitud${affected !== 1 ? 'es' : ''}.` : '';
      return res.redirect(`/admin/operaciones/personal?status=DISABLED&message=${encodeURIComponent(`Auxiliar desactivado. Causal: ${reason.label}.${extra}`)}`);
    }
    await prismaClient.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: 'CONTRATADO' } });
    return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('Auxiliar reactivado. Ya aparece disponible para asignaciones.')}`);
  } catch (error) {
    console.error('[dispatch-worker-toggle-safe]', error);
    return next(error);
  }
}
async function stats(workerIds = []) {
  const rows = await db().dispatchWorker.findMany({ where: { notes: { contains: NOTE_PREFIX } }, select: { id: true, notes: true }, take: 1000, orderBy: { updatedAt: 'desc' } });
  const count = new Map();
  const workers = {};
  for (const row of rows) {
    const label = extractReasonFromNotes(row.notes);
    if (!label) continue;
    count.set(label, (count.get(label) || 0) + 1);
    if (workerIds.includes(row.id)) workers[row.id] = { label };
  }
  return { stats: [...count.entries()].map(([reasonLabel, total]) => ({ reasonLabel, total })).sort((a, b) => b.total - a.total), workers };
}
async function buildDashboardMetrics(prismaClient, selectedDate) {
  const { start, end } = dayRange(selectedDate);
  const whereForDate = { serviceDate: { gte: start, lt: end } };
  const [totalRequests, pendingRequests, completedRequests, openIncidents] = await Promise.all([
    prismaClient.dispatchServiceRequest.count({ where: whereForDate }),
    prismaClient.dispatchServiceRequest.count({ where: { ...whereForDate, status: { in: PENDING_REQUEST_STATUSES } } }),
    prismaClient.dispatchServiceRequest.count({ where: { ...whereForDate, status: 'ASSIGNMENT_COMPLETE' } }),
    prismaClient.dispatchIncident.count({ where: { status: { in: OPEN_INCIDENT_STATUSES }, serviceRequest: { is: whereForDate } } })
  ]);
  return { totalRequests, pendingRequests, completedRequests, openIncidents };
}
async function handleOperationsDashboard(req, res, next) {
  try {
    if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario');
    const selectedDate = selectedDateFromRequest(req);
    const metrics = await buildDashboardMetrics(db(), selectedDate);
    return res.render('operacionesDashboard', {
      pageTitle: 'Operaciones / Despacho',
      subtitle: 'Gestión operativa de solicitudes, asignaciones, novedades y reemplazos.',
      activeSection: 'dashboard',
      selectedDate,
      metrics,
      role: req.session?.userRole || req.userRole,
      canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
    });
  } catch (error) {
    console.error('[dispatch-dashboard-date-safe]', error);
    return next(error);
  }
}
async function handleAssignmentsBoard(req, res, next) {
  try {
    if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario');
    const prismaClient = db();
    const selectedDate = selectedDateFromRequest(req);
    const { start, end } = dayRange(selectedDate);
    const q = clean(req.query?.q);
    const operationalCityId = clean(req.query?.operationalCityId);
    const transportMode = clean(req.query?.transportMode);
    const locality = clean(req.query?.locality);
    const serviceRequestId = clean(req.query?.serviceRequestId);
    const baseWorkerWhere = { operationalStatus: 'CONTRATADO', ...buildWorkerSearchFilter(q), ...buildOperationalCityFilter(operationalCityId) };
    const workerWhere = { ...baseWorkerWhere, ...(transportMode ? { transportMode } : {}), ...(locality ? { residenceLocality: locality } : {}) };
    const localityWhere = { ...baseWorkerWhere, ...(transportMode ? { transportMode } : {}) };
    const transportModeWhere = { ...baseWorkerWhere, ...(locality ? { residenceLocality: locality } : {}) };
    const [workers, cities, transportModeRows, localityRows, serviceRequests, clients] = await Promise.all([
      prismaClient.dispatchWorker.findMany({ where: workerWhere, include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } }, orderBy: { createdAt: 'desc' } }),
      prismaClient.city.findMany({ where: { usedForDispatch: true, NOT: { id: { startsWith: 'city_' } } }, orderBy: { name: 'asc' } }),
      prismaClient.dispatchWorker.findMany({ where: transportModeWhere, select: { transportMode: true }, distinct: ['transportMode'], orderBy: { transportMode: 'asc' } }),
      prismaClient.dispatchWorker.findMany({ where: localityWhere, select: { residenceLocality: true }, distinct: ['residenceLocality'], orderBy: { residenceLocality: 'asc' } }),
      prismaClient.dispatchServiceRequest.findMany({ where: { serviceDate: { gte: start, lt: end } }, include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ startTime: 'asc' }, { createdAt: 'desc' }] }),
      prismaClient.dispatchClient.findMany({ where: { isActive: true }, include: { operationPoints: { where: { isActive: true }, orderBy: { name: 'asc' } }, services: { where: { isActive: true }, orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } })
    ]);
    const selectedServiceRequest = serviceRequestId ? serviceRequests.find((item) => item.id === serviceRequestId) || null : serviceRequests[0] || null;
    const blockedWorkerIds = new Set(selectedServiceRequest ? selectedServiceRequest.assignments.map((assignment) => assignment.workerId) : []);
    const availableWorkers = workers.filter((worker) => !blockedWorkerIds.has(worker.id));
    const sameDayAssignments = selectedServiceRequest ? await prismaClient.dispatchAssignment.findMany({ where: { serviceRequestId: { not: selectedServiceRequest.id }, status: { in: ACTIVE_ASSIGNMENT_STATUSES }, serviceRequest: { serviceDate: { gte: start, lt: end } } }, select: { workerId: true } }) : [];
    return res.render('operacionesAsignacionesConfirmacion', {
      activeStatuses: ACTIVE_ASSIGNMENT_STATUSES,
      workers,
      availableWorkers,
      assignedWorkerIdsOnSelectedDate: new Set(sameDayAssignments.map((assignment) => assignment.workerId)),
      cities,
      serviceRequests,
      selectedServiceRequest,
      selectedServiceRequestId: selectedServiceRequest?.id || '',
      clients,
      message: clean(req.query?.message),
      filters: { q: q || '', operationalCityId: operationalCityId || '', transportMode: transportMode || '', locality: locality || '', fecha: selectedDate },
      transportModes: cleanStrings(transportModeRows, 'transportMode'),
      localities: cleanStrings(localityRows, 'residenceLocality'),
      role: req.session?.userRole || req.userRole,
      canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
    });
  } catch (error) {
    console.error('[dispatch-assignments-date-safe]', error);
    return next(error);
  }
}
function installRouterPatch() {
  if (express.__dispatchWorkerExitReasonSafePatch) return;
  const originalRouter = express.Router;
  express.Router = function patchedRouter(...args) {
    const router = originalRouter.apply(express, args);
    router.use(async (req, res, next) => {
      const pathname = pathOf(req);
      if (req.method === 'GET' && (pathname === BASE_PATH || pathname === `${BASE_PATH}/` || pathname === `${BASE_PATH}/abrir`)) return handleOperationsDashboard(req, res, next);
      if (req.method === 'GET' && pathname === `${BASE_PATH}/asignaciones`) return handleAssignmentsBoard(req, res, next);
      const match = pathname.match(TOGGLE_RE);
      if (req.method === 'POST' && match) return handleToggle(req, res, next, decodeURIComponent(match[1]));
      if (req.method === 'GET' && pathname === `${BASE_PATH}/personal/exit-reasons`) {
        if (!canUseOps(req)) return res.status(403).json({ ok: false });
        const workerIds = String(req.query?.workerIds || '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 500);
        return res.json({ ok: true, reasons: EXIT_REASONS, ...(await stats(workerIds)) });
      }
      return next();
    });
    return router;
  };
  Object.assign(express.Router, originalRouter);
  express.__dispatchWorkerExitReasonSafePatch = true;
}
function uiScript() {
  return `<script ${MARKER}>
(function(){
  var reasons = ${JSON.stringify(EXIT_REASONS)};
  function h(v){return String(v||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function n(v){return String(v||'').trim().toLowerCase();}
  function options(){return reasons.map(function(r){return '<option value="'+h(r.code)+'">'+h(r.label)+'</option>';}).join('');}
  var selectedForm=null;
  function ensureModal(){
    var m=document.getElementById('exit-reason-modal'); if(m) return m;
    m=document.createElement('div'); m.className='modal-overlay'; m.id='exit-reason-modal';
    m.innerHTML='<div class="modal"><h3>Desactivar auxiliar</h3><p>Selecciona la causal de retiro. Esta información alimentará las estadísticas del módulo de despacho.</p><div class="field" style="margin-bottom:12px"><label>Causal de retiro *</label><select id="exitReasonCode"><option value="">Selecciona una causal</option>'+options()+'</select></div><div class="field" style="margin-bottom:16px"><label>Nota opcional</label><textarea id="exitReasonNote" rows="3" style="width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-family:inherit"></textarea></div><div class="modal-actions"><button type="button" class="btn btn-secondary" id="exitReasonCancel">Cancelar</button><button type="button" class="btn btn-danger" id="exitReasonConfirm">Desactivar auxiliar</button></div></div>';
    document.body.appendChild(m); document.getElementById('exitReasonCancel').onclick=function(){m.classList.remove('open')}; return m;
  }
  document.querySelectorAll('form[action*="/admin/operaciones/personal/"][action$="/toggle"]').forEach(function(form){
    var button=form.querySelector('button[type="submit"]'); if(!button || n(button.textContent)!=='desactivar') return;
    form.addEventListener('submit',function(e){e.preventDefault(); selectedForm=form; var m=ensureModal(); document.getElementById('exitReasonCode').value=''; document.getElementById('exitReasonNote').value=''; m.classList.add('open');});
  });
  document.addEventListener('click',function(e){
    if(!e.target || e.target.id!=='exitReasonConfirm') return;
    var code=document.getElementById('exitReasonCode'); var note=document.getElementById('exitReasonNote'); if(!code.value){code.focus();return;}
    selectedForm.querySelectorAll('input[name="exitReasonCode"],input[name="exitReasonNote"]').forEach(function(input){input.remove()});
    var a=document.createElement('input'); a.type='hidden'; a.name='exitReasonCode'; a.value=code.value;
    var b=document.createElement('input'); b.type='hidden'; b.name='exitReasonNote'; b.value=note.value||'';
    selectedForm.appendChild(a); selectedForm.appendChild(b); selectedForm.submit();
  });
  var table=document.getElementById('workers-table'); if(!table) return;
  var ids=[].slice.call(table.querySelectorAll('tbody tr[data-id]')).map(function(r){return r.dataset.id}).filter(Boolean);
  fetch('/admin/operaciones/personal/exit-reasons?workerIds='+encodeURIComponent(ids.join(',')),{credentials:'include'}).catch(function(){});
})();
</script>`;
}
function assignmentDateScript(req) {
  const selectedDate = selectedDateFromRequest(req);
  return `<script data-dispatch-date-filter-safe="true">
(function(){
  var selectedDate=${JSON.stringify(selectedDate)};
  var requestPanel=[].slice.call(document.querySelectorAll('.board-panel-head h2')).find(function(h){return /solicitudes/i.test(h.textContent||'');});
  if(requestPanel && !document.getElementById('assignmentDateFilter')){
    var form=document.createElement('form');
    form.id='assignmentDateFilter'; form.method='get'; form.action='/admin/operaciones/asignaciones'; form.className='filters'; form.style.borderBottom='1px solid #edf2f7';
    form.innerHTML='<div class="field"><label>Fecha de solicitudes</label><input type="date" name="fecha" value="'+selectedDate+'"></div><button class="btn btn-primary" type="submit">Aplicar fecha</button>';
    requestPanel.parentElement.insertAdjacentElement('afterend', form);
  }
  document.querySelectorAll('a[href^="/admin/operaciones/asignaciones?serviceRequestId="]').forEach(function(link){
    try{var url=new URL(link.href, window.location.origin); url.searchParams.set('fecha', selectedDate); link.href=url.pathname+'?'+url.searchParams.toString();}catch(e){}
  });
  document.querySelectorAll('form[action="/admin/operaciones/asignaciones"]').forEach(function(form){
    if(!form.querySelector('input[name="fecha"]')){var input=document.createElement('input'); input.type='hidden'; input.name='fecha'; input.value=selectedDate; form.appendChild(input);}
  });
})();
</script>`;
}
function patchWhatsappContext(output) {
  return output.replace(
    "body:JSON.stringify({phone,message})",
    "body:JSON.stringify({phone,message,context:{assignmentId:button.closest('.assigned-card')?.dataset.assignmentId||'',serviceRequestId:document.querySelector('input[name=\"serviceRequestId\"]')?.value||new URLSearchParams(window.location.search).get('serviceRequestId')||'',recipientName:button.closest('.assigned-card')?.dataset.workerName||'',messageType:'ASSIGNMENT_CONFIRMATION'}})"
  );
}
function installUiPatch() {
  if (express.response.__dispatchWorkerExitReasonSafeUi) return;
  const originalSend = express.response.send;
  express.response.send = function patchedSend(body) {
    let output = body;
    const pathname = pathOf(this.req);
    if (typeof output === 'string' && this.req?.method === 'GET' && pathname === `${BASE_PATH}/personal` && output.includes('</body>') && !output.includes(MARKER)) {
      output = output.replace('</body>', `${uiScript()}\n</body>`);
    }
    if (typeof output === 'string' && this.req?.method === 'GET' && pathname === `${BASE_PATH}/asignaciones` && output.includes('</body>')) {
      output = patchWhatsappContext(output);
      if (!output.includes('data-dispatch-date-filter-safe="true"')) output = output.replace('</body>', `${assignmentDateScript(this.req)}\n</body>`);
    }
    return originalSend.call(this, output);
  };
  express.response.__dispatchWorkerExitReasonSafeUi = true;
}

installRouterPatch();
installUiPatch();
