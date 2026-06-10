import express from 'express';

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

export function dispatchWorkerStatsRouter(prisma) {
  const router = express.Router();

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
