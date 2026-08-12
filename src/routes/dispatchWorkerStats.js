import express from 'express';
import {
  DISPATCH_TEST_RESET_CONFIRMATION,
  resetDispatchTestEnvironment,
  resetDispatchTestEnvironmentOnce
} from '../services/dispatchTestEnvironmentReset.js';
import { dispatchAssignmentDateGuard } from './dispatchAssignmentDateGuard.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const NO_CONFIRM_STATUS = 'NO_CONFIRMO';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isOpsUser(req) {
  const username = normalizeString(req.session?.username || req.username);
  return Boolean(username?.startsWith('operaciones-despacho'));
}

function canUseOps(req) {
  const role = req.session?.userRole || req.userRole;
  const canAccessDispatch = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch);
  return role === 'dev' || canAccessDispatch || isOpsUser(req);
}

function requireOps(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (!role) return res.redirect('/login');
  if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario');
  return next();
}

function requireDev(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (role !== 'dev') return res.status(403).send('Acceso restringido a DEV');
  return next();
}

function uniqueCount(values = []) {
  return new Set(values.filter(Boolean)).size;
}

function topOperation(assignments = []) {
  const counter = new Map();
  for (const assignment of assignments) {
    const name = assignment.serviceRequest?.operationPointName || 'Sin operación';
    counter.set(name, (counter.get(name) || 0) + 1);
  }
  return [...counter.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function buildWorkerStats(assignments = []) {
  const total = assignments.length;
  const confirmed = assignments.filter((assignment) => assignment.status === CONFIRMED_ASSIGNMENT_STATUS).length;
  const noConfirmo = assignments.filter((assignment) => assignment.status === NO_CONFIRM_STATUS).length;
  const active = assignments.filter((assignment) => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)).length;
  const inactive = Math.max(0, total - active);
  const confirmationRate = total ? Math.round((confirmed / total) * 100) : 0;
  const lastAssignmentAt = assignments[0]?.createdAt || null;
  const lastServiceDate = assignments[0]?.serviceRequest?.serviceDate || null;
  const clientsCount = uniqueCount(assignments.map((assignment) => assignment.serviceRequest?.clientName));
  const operationsCount = uniqueCount(assignments.map((assignment) => assignment.serviceRequest?.operationPointName));

  return {
    total,
    confirmed,
    noConfirmo,
    active,
    inactive,
    confirmationRate,
    lastAssignmentAt,
    lastServiceDate,
    clientsCount,
    operationsCount,
    topOperation: topOperation(assignments)
  };
}

function resetSummaryMessage(result = {}) {
  const removed = [
    `${Number(result.assignments || 0)} asignaciones`,
    `${Number(result.serviceRequests || 0)} solicitudes`,
    `${Number(result.attendanceMarks || 0)} marcaciones`,
    `${Number(result.attendanceSessions || 0)} sesiones de asistencia`,
    `${Number(result.portalSessions || 0)} sesiones del portal`,
    `${Number(result.devices || 0)} dispositivos`,
    `${Number(result.auditEvents || 0)} registros biométricos/auditoría`,
    `${Number(result.evidenceDeleted || 0)} evidencias fotográficas`
  ];
  const evidenceWarning = Number(result.evidenceFailed || 0) > 0
    ? ` ${result.evidenceFailed} evidencia(s) no pudieron eliminarse de R2.`
    : '';
  return `Entorno de prueba reiniciado: ${removed.join(', ')}.${evidenceWarning}`;
}

function injectTestResetControls(html) {
  if (typeof html !== 'string' || html.includes('/admin/operaciones/pruebas/reiniciar')) return html;
  const button = '<button type="button" class="btn btn-danger-outline" id="open-test-reset">Reiniciar entorno de prueba</button>';
  const syncFormPattern = /(<form\s+method=["']post["']\s+action=["']\/admin\/operaciones\/sync-contratados["'][^>]*>[\s\S]*?<\/form>)/i;
  let output = syncFormPattern.test(html)
    ? html.replace(syncFormPattern, `$1\n          ${button}`)
    : html;
  if (output === html) return html;

  const modal = `
  <div class="modal-overlay" id="modal-test-reset">
    <div class="modal">
      <h3>Reiniciar entorno de prueba</h3>
      <p>Se conservarán el sujeto y el cliente marcados como prueba. Se eliminarán sus solicitudes, asignaciones, historial, asistencia, rostro registrado, dispositivos, sesiones del portal y fotografías.</p>
      <p>Escribe <strong>${DISPATCH_TEST_RESET_CONFIRMATION}</strong> para confirmar.</p>
      <form method="post" action="/admin/operaciones/pruebas/reiniciar" id="test-reset-form">
        <input id="test-reset-confirmation" name="confirmation" type="text" autocomplete="off" spellcheck="false" style="width:100%;border:1px solid #e1e4e8;border-radius:10px;padding:11px 12px;margin-bottom:16px;font-size:14px" />
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="cancel-test-reset">Cancelar</button>
          <button type="submit" class="btn btn-danger" id="confirm-test-reset" disabled>Eliminar actividad de prueba</button>
        </div>
      </form>
    </div>
  </div>
  <script>
    (() => {
      const openButton = document.getElementById('open-test-reset');
      const modal = document.getElementById('modal-test-reset');
      const cancelButton = document.getElementById('cancel-test-reset');
      const input = document.getElementById('test-reset-confirmation');
      const confirmButton = document.getElementById('confirm-test-reset');
      const expected = '${DISPATCH_TEST_RESET_CONFIRMATION}';
      const close = () => { modal?.classList.remove('open'); if (input) input.value = ''; if (confirmButton) confirmButton.disabled = true; };
      openButton?.addEventListener('click', () => { modal?.classList.add('open'); input?.focus(); });
      cancelButton?.addEventListener('click', close);
      modal?.addEventListener('click', (event) => { if (event.target === modal) close(); });
      input?.addEventListener('input', () => { if (confirmButton) confirmButton.disabled = input.value.trim() !== expected; });
    })();
  </script>`;
  return output.replace(/<\/body>/i, `${modal}\n</body>`);
}

function installTestResetRenderGate(res, next) {
  const originalRender = res.render.bind(res);
  res.render = (view, locals, callback) => {
    let renderLocals = locals || {};
    let renderCallback = callback;
    if (typeof locals === 'function') {
      renderCallback = locals;
      renderLocals = {};
    }
    if (view !== 'operacionesPersonal') return originalRender(view, renderLocals, renderCallback);
    return originalRender(view, renderLocals, (error, html) => {
      if (error) {
        if (typeof renderCallback === 'function') return renderCallback(error);
        return next(error);
      }
      const output = injectTestResetControls(html);
      if (typeof renderCallback === 'function') return renderCallback(null, output);
      return res.send(output);
    });
  };
}

export function dispatchWorkerStatsRouter(prisma) {
  const router = express.Router();

  router.use('/asignaciones', requireOps, dispatchAssignmentDateGuard(prisma));

  router.get('/personal', requireOps, async (req, res, next) => {
    const role = req.session?.userRole || req.userRole;
    if (role !== 'dev') return next();
    installTestResetRenderGate(res, next);
    try {
      const result = await resetDispatchTestEnvironmentOnce(prisma);
      if (!result.skipped) req.query.message = resetSummaryMessage(result);
    } catch (error) {
      console.error('[DISPATCH_TEST_ENVIRONMENT_AUTO_RESET_FAILED]', {
        code: typeof error?.message === 'string' ? error.message : 'unknown'
      });
      req.query.message = 'No fue posible reiniciar automáticamente el entorno de prueba. Usa el botón de reinicio e intenta nuevamente.';
    }
    return next();
  });

  router.post(
    '/pruebas/reiniciar',
    requireOps,
    requireDev,
    express.urlencoded({ extended: false }),
    async (req, res) => {
      if (normalizeString(req.body?.confirmation) !== DISPATCH_TEST_RESET_CONFIRMATION) {
        return res.status(400).send(`Escribe ${DISPATCH_TEST_RESET_CONFIRMATION} para confirmar.`);
      }
      const result = await resetDispatchTestEnvironment(prisma);
      return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent(resetSummaryMessage(result))}`);
    }
  );

  router.get('/personal/:workerId/historial', requireOps, async (req, res) => {
    const worker = await prisma.dispatchWorker.findUnique({
      where: { id: req.params.workerId },
      include: {
        cities: { include: { city: true } },
        vacancies: { include: { vacancy: true } }
      }
    });

    if (!worker) return res.status(404).send('Auxiliar no encontrado');

    const assignments = await prisma.dispatchAssignment.findMany({
      where: { workerId: worker.id },
      include: {
        serviceRequest: {
          include: { service: true }
        }
      },
      orderBy: [{ createdAt: 'desc' }]
    });

    return res.render('operacionesPersonalHistorial', {
      worker,
      assignments,
      stats: buildWorkerStats(assignments),
      activeStatuses: ACTIVE_ASSIGNMENT_STATUSES,
      role: req.session?.userRole || req.userRole,
      canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch),
      message: normalizeString(req.query.message)
    });
  });

  return router;
}
