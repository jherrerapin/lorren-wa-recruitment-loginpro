import express from 'express';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const BASE_PATH = '/admin/operaciones';
const TOGGLE_PATH_PATTERN = /^\/admin\/operaciones\/personal\/([^/]+)\/toggle$/;
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const DISPATCH_OWNED_SOURCES = ['MANUAL', 'EXCEL_IMPORT'];
const DISABLED_STATUSES = ['DISABLED', 'INACTIVE', 'ELIMINADO'];
const SCRIPT_MARKER = 'data-dispatch-deactivation-reasons="true"';

const RETIREMENT_REASONS = [
  { code: 'T01_HURTO', category: 'TERMINACION', label: 'Terminación de contrato por hurto' },
  { code: 'T02_AUSENCIAS', category: 'TERMINACION', label: 'Terminación de contrato por ausencias' },
  { code: 'T03_BAJO_RENDIMIENTO', category: 'TERMINACION', label: 'Terminación de contrato por bajo rendimiento' },
  { code: 'T04_PORTE_ARMAS', category: 'TERMINACION', label: 'Terminación de contrato por porte de armas' },
  { code: 'T05_ESTUPEFACIENTES', category: 'TERMINACION', label: 'Terminación de contrato por consumo y/o porte de estupefacientes' },
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

function db() {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length ? text : null;
}

function requestPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function isOpsUser(req = {}) {
  const username = normalizeString(req.session?.username || req.username);
  return Boolean(username?.startsWith('operaciones-despacho'));
}

function canUseOps(req = {}) {
  const role = req.session?.userRole || req.userRole;
  const canAccessDispatch = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch);
  return role === 'dev' || canAccessDispatch || isOpsUser(req);
}

function reasonByCode(code) {
  return RETIREMENT_REASONS.find((reason) => reason.code === code) || null;
}

function appendMessage(pathValue, message) {
  const [pathname, query = ''] = String(pathValue || '/admin/operaciones/personal').split('?');
  const params = new URLSearchParams(query);
  params.set('message', message);
  return `${pathname}?${params.toString()}`;
}

function safePersonalRedirect(req, fallback = '/admin/operaciones/personal') {
  const referer = req.get?.('referer');
  if (!referer) return fallback;
  try {
    const parsed = new URL(referer);
    const currentOrigin = `${req.protocol}://${req.get('host')}`;
    if (parsed.origin === currentOrigin && parsed.pathname.startsWith('/admin/operaciones/personal')) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch (_error) {}
  return fallback;
}

async function recalculateServiceRequestStatus(prismaClient, serviceRequestId) {
  const serviceRequest = await prismaClient.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { id: true, requiredWorkers: true }
  });
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

async function cancelWorkerActiveAssignments(prismaClient, workerId, reasonLabel) {
  const activeAssignments = await prismaClient.dispatchAssignment.findMany({
    where: { workerId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
    select: { id: true, serviceRequestId: true, status: true }
  });
  if (!activeAssignments.length) return [];

  const affectedRequestIds = [...new Set(activeAssignments.map((assignment) => assignment.serviceRequestId))];
  await prismaClient.$transaction(
    activeAssignments.map((assignment) => prismaClient.dispatchAssignment.update({
      where: { id: assignment.id },
      data: {
        status: assignment.status === CONFIRMED_ASSIGNMENT_STATUS ? 'NO_CONFIRMO' : 'CANCELLED',
        notes: `Auxiliar desactivado desde el módulo de personal. Causal: ${reasonLabel}.`
      }
    }))
  );

  await Promise.all(affectedRequestIds.map((id) => recalculateServiceRequestStatus(prismaClient, id)));
  return affectedRequestIds;
}

async function saveDeactivation(prismaClient, worker, req) {
  const reason = reasonByCode(normalizeString(req.body?.deactivationReasonCode));
  if (!reason) {
    const error = new Error('Debes seleccionar una causal de retiro para desactivar el auxiliar.');
    error.statusCode = 400;
    throw error;
  }

  const note = normalizeString(req.body?.deactivationNote);
  const actor = normalizeString(req.session?.username || req.username);
  const previousStatus = worker.operationalStatus || null;
  const now = new Date();

  await prismaClient.$transaction(async (tx) => {
    await tx.dispatchWorker.update({
      where: { id: worker.id },
      data: { operationalStatus: 'DISABLED' }
    });
    await tx.$executeRaw`
      UPDATE "DispatchWorker"
      SET "deactivationReasonCode" = ${reason.code},
          "deactivationReasonLabel" = ${reason.label},
          "deactivationCategory" = ${reason.category},
          "deactivationNote" = ${note},
          "deactivatedAt" = ${now},
          "deactivatedByUsername" = ${actor}
      WHERE "id" = ${worker.id}
    `;
    await tx.$executeRaw`
      INSERT INTO "DispatchWorkerDeactivationEvent"
        ("id", "workerId", "reasonCode", "reasonLabel", "category", "note", "previousStatus", "newStatus", "createdByUsername", "createdAt")
      VALUES
        (${randomUUID()}, ${worker.id}, ${reason.code}, ${reason.label}, ${reason.category}, ${note}, ${previousStatus}, 'DISABLED', ${actor}, ${now})
    `;
  });

  return reason;
}

async function reactivateWorker(prismaClient, worker) {
  await prismaClient.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: 'CONTRATADO' } });
  await prismaClient.$executeRaw`
    UPDATE "DispatchWorker"
    SET "deactivationReasonCode" = NULL,
        "deactivationReasonLabel" = NULL,
        "deactivationCategory" = NULL,
        "deactivationNote" = NULL,
        "deactivatedAt" = NULL,
        "deactivatedByUsername" = NULL
    WHERE "id" = ${worker.id}
  `;
}

async function handleWorkerToggle(req, res, next, workerId) {
  if (!canUseOps(req)) return res.status(403).send('Módulo no habilitado para este usuario');
  const prismaClient = db();
  const worker = await prismaClient.dispatchWorker.findFirst({
    where: { id: workerId, source: { in: DISPATCH_OWNED_SOURCES } },
    select: { id: true, fullName: true, operationalStatus: true }
  });
  if (!worker) return res.status(404).send('Auxiliar no encontrado o no editable desde este módulo');

  const backUrl = safePersonalRedirect(req, '/admin/operaciones/personal');
  const isCurrentlyActive = worker.operationalStatus === 'CONTRATADO';

  try {
    if (isCurrentlyActive) {
      const reason = await saveDeactivation(prismaClient, worker, req);
      const affectedRequestIds = await cancelWorkerActiveAssignments(prismaClient, worker.id, reason.label);
      const affectedCount = affectedRequestIds.length;
      const warningNote = affectedCount > 0
        ? ` Se cancelaron sus asignaciones activas en ${affectedCount} solicitud${affectedCount !== 1 ? 'es' : ''}. Revisa y asigna reemplazos.`
        : '';
      return res.redirect(`/admin/operaciones/personal?status=DISABLED&message=${encodeURIComponent(`Auxiliar desactivado. Causal: ${reason.label}.${warningNote} Puedes reactivarlo desde aquí.`)}`);
    }

    await reactivateWorker(prismaClient, worker);
    return res.redirect(appendMessage(backUrl, 'Auxiliar reactivado. Ya aparece disponible para asignaciones.'));
  } catch (error) {
    if (error.statusCode === 400) return res.redirect(appendMessage(backUrl, error.message));
    return next(error);
  }
}

async function deactivationStatsPayload(workerIds = []) {
  const prismaClient = db();
  const statsRows = await prismaClient.$queryRaw`
    SELECT "reasonCode", "reasonLabel", "category", COUNT(*)::int AS "count"
    FROM "DispatchWorkerDeactivationEvent"
    GROUP BY "reasonCode", "reasonLabel", "category"
    ORDER BY "count" DESC, "reasonLabel" ASC
  `;

  let currentRows = [];
  if (workerIds.length) {
    currentRows = await prismaClient.$queryRaw`
      SELECT "id", "deactivationReasonCode", "deactivationReasonLabel", "deactivationCategory", "deactivationNote", "deactivatedAt", "deactivatedByUsername"
      FROM "DispatchWorker"
      WHERE "id" = ANY(${workerIds})
    `;
  }

  return {
    reasons: RETIREMENT_REASONS,
    stats: statsRows.map((row) => ({ ...row, count: Number(row.count || 0) })),
    workers: currentRows.reduce((acc, row) => {
      acc[row.id] = {
        code: row.deactivationReasonCode,
        label: row.deactivationReasonLabel,
        category: row.deactivationCategory,
        note: row.deactivationNote,
        deactivatedAt: row.deactivatedAt,
        by: row.deactivatedByUsername
      };
      return acc;
    }, {})
  };
}

function installDispatchDeactivationRouter() {
  if (express.__dispatchWorkerDeactivationRouterInstalled) return;
  const originalRouter = express.Router;
  express.Router = function patchedRouter(...args) {
    const router = originalRouter.apply(express, args);
    router.use(async (req, res, next) => {
      const path = requestPath(req);

      if (req.method === 'POST') {
        const match = path.match(TOGGLE_PATH_PATTERN);
        if (match) return handleWorkerToggle(req, res, next, decodeURIComponent(match[1]));
      }

      if (req.method === 'GET' && path === `${BASE_PATH}/personal/deactivation-reasons`) {
        if (!canUseOps(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
        const workerIds = String(req.query?.workerIds || '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 500);
        const payload = await deactivationStatsPayload(workerIds);
        return res.json({ ok: true, ...payload });
      }

      return next();
    });
    return router;
  };
  Object.assign(express.Router, originalRouter);
  express.__dispatchWorkerDeactivationRouterInstalled = true;
}

function renderDeactivationUiScript() {
  const reasonsJson = JSON.stringify(RETIREMENT_REASONS);
  return `<script data-dispatch-deactivation-reasons="true">
(function(){
  var reasons = ${reasonsJson};
  function normalize(value){ return String(value || '').trim().toLowerCase(); }
  function html(value){ return String(value || '').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function optionHtml(){ return reasons.map(function(reason){ return '<option value="'+html(reason.code)+'">'+html(reason.label)+'</option>'; }).join(''); }
  function ensureModal(){
    var existing = document.getElementById('deactivation-reason-modal');
    if (existing) return existing;
    var modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'deactivation-reason-modal';
    modal.innerHTML = '<div class="modal"><h3>Desactivar auxiliar</h3><p>Selecciona la causal de retiro. Esta información alimentará las estadísticas del módulo de despacho.</p><div class="field" style="margin-bottom:12px"><label for="deactivationReasonCode">Causal de retiro *</label><select id="deactivationReasonCode" required><option value="">Selecciona una causal</option>'+optionHtml()+'</select></div><div class="field" style="margin-bottom:16px"><label for="deactivationNote">Nota opcional</label><textarea id="deactivationNote" rows="3" style="width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-family:inherit" placeholder="Detalle adicional del caso..."></textarea></div><div class="modal-actions"><button type="button" class="btn btn-secondary" id="cancel-deactivation-reason">Cancelar</button><button type="button" class="btn btn-danger" id="confirm-deactivation-reason">Desactivar auxiliar</button></div></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(event){ if(event.target === modal) modal.classList.remove('open'); });
    document.getElementById('cancel-deactivation-reason').addEventListener('click', function(){ modal.classList.remove('open'); });
    return modal;
  }
  var selectedForm = null;
  document.querySelectorAll('form[action*="/admin/operaciones/personal/"][action$="/toggle"]').forEach(function(form){
    var button = form.querySelector('button[type="submit"]');
    if (!button || normalize(button.textContent) !== 'desactivar') return;
    form.addEventListener('submit', function(event){
      event.preventDefault();
      selectedForm = form;
      var modal = ensureModal();
      var select = document.getElementById('deactivationReasonCode');
      var note = document.getElementById('deactivationNote');
      select.value = '';
      note.value = '';
      modal.classList.add('open');
      select.focus();
    });
  });
  document.addEventListener('click', function(event){
    if (event.target && event.target.id === 'confirm-deactivation-reason') {
      var select = document.getElementById('deactivationReasonCode');
      var note = document.getElementById('deactivationNote');
      if (!select.value) { select.focus(); return; }
      if (!selectedForm) return;
      selectedForm.querySelectorAll('input[name="deactivationReasonCode"],input[name="deactivationNote"]').forEach(function(input){ input.remove(); });
      var reasonInput = document.createElement('input');
      reasonInput.type = 'hidden'; reasonInput.name = 'deactivationReasonCode'; reasonInput.value = select.value;
      var noteInput = document.createElement('input');
      noteInput.type = 'hidden'; noteInput.name = 'deactivationNote'; noteInput.value = note.value || '';
      selectedForm.appendChild(reasonInput); selectedForm.appendChild(noteInput);
      selectedForm.submit();
    }
  });
  function loadStats(){
    var table = document.getElementById('workers-table');
    if (!table) return;
    var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr[data-id]'));
    var ids = rows.map(function(row){ return row.dataset.id; }).filter(Boolean);
    fetch('/admin/operaciones/personal/deactivation-reasons?workerIds=' + encodeURIComponent(ids.join(',')), { credentials: 'include' })
      .then(function(response){ return response.json(); })
      .then(function(payload){
        if (!payload || !payload.ok) return;
        var workers = payload.workers || {};
        var disabledRows = rows.filter(function(row){ return workers[row.dataset.id] && workers[row.dataset.id].label; });
        if (disabledRows.length) {
          var header = table.querySelector('thead tr');
          var actionHeader = header ? header.lastElementChild : null;
          if (header && !header.querySelector('[data-reason-header]')) {
            var th = document.createElement('th'); th.textContent = 'Causal retiro'; th.setAttribute('data-reason-header', 'true'); header.insertBefore(th, actionHeader);
          }
          disabledRows.forEach(function(row){
            if (row.querySelector('[data-reason-cell]')) return;
            var data = workers[row.dataset.id] || {};
            var td = document.createElement('td'); td.setAttribute('data-reason-cell', 'true');
            td.innerHTML = '<span class="pill pill-red">'+html(data.label)+'</span>' + (data.note ? '<br><span class="muted">'+html(data.note)+'</span>' : '');
            row.insertBefore(td, row.lastElementChild);
          });
        }
        if (payload.stats && payload.stats.length && !document.getElementById('deactivation-stats-card')) {
          var panel = document.querySelector('.panel');
          var card = document.createElement('section');
          card.className = 'filters-card';
          card.id = 'deactivation-stats-card';
          card.innerHTML = '<div class="filters-head"><h2>Causales de retiro</h2><p>Resumen histórico de auxiliares desactivados por causal.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap">'+payload.stats.slice(0,6).map(function(item){ return '<span class="pill pill-red">'+html(item.reasonLabel)+' · '+Number(item.count || 0)+'</span>'; }).join('')+'</div>';
          if (panel) panel.parentNode.insertBefore(card, panel);
        }
      })
      .catch(function(){});
  }
  loadStats();
})();
</script>`;
}

function installDeactivationUiInjection() {
  if (express.response.__dispatchDeactivationUiInstalled) return;
  const originalSend = express.response.send;
  express.response.send = function sendWithDeactivationUi(body) {
    let output = body;
    if (typeof output === 'string' && requestPath(this.req) === `${BASE_PATH}/personal` && this.req.method === 'GET' && output.includes('</body>') && !output.includes(SCRIPT_MARKER)) {
      output = output.replace('</body>', `${renderDeactivationUiScript()}\n</body>`);
    }
    return originalSend.call(this, output);
  };
  express.response.__dispatchDeactivationUiInstalled = true;
}

installDispatchDeactivationRouter();
installDeactivationUiInjection();
