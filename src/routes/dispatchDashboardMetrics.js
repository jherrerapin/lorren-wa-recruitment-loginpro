import express from 'express';

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

function todayIsoDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function normalizeDateParam(value) {
  const rawValue = normalizeString(value);
  if (!rawValue) return todayIsoDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) return todayIsoDate();
  const parsed = new Date(`${rawValue}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return todayIsoDate();
  return rawValue;
}

function buildUtcDayRange(dateText) {
  const start = new Date(`${dateText}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

async function buildOperationsDashboardMetrics(prisma, selectedDate) {
  const { start, end } = buildUtcDayRange(selectedDate);
  const whereForDate = {
    serviceDate: {
      gte: start,
      lt: end
    }
  };

  const [totalRequests, pendingRequests, completedRequests, openIncidents] = await Promise.all([
    prisma.dispatchServiceRequest.count({ where: whereForDate }),
    prisma.dispatchServiceRequest.count({
      where: {
        ...whereForDate,
        status: { in: ['PENDING_ASSIGNMENT', 'ASSIGNMENT_PARTIAL'] }
      }
    }),
    prisma.dispatchServiceRequest.count({
      where: {
        ...whereForDate,
        status: 'ASSIGNMENT_COMPLETE'
      }
    }),
    prisma.dispatchIncident.count({
      where: {
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        serviceRequest: whereForDate
      }
    })
  ]);

  return {
    totalRequests,
    pendingRequests,
    completedRequests,
    openIncidents
  };
}

async function renderOperationsDashboard(req, res, prisma) {
  const selectedDate = normalizeDateParam(req.query.fecha || req.query.date);
  const metrics = await buildOperationsDashboardMetrics(prisma, selectedDate);

  return res.render('operacionesDashboard', {
    pageTitle: 'Operaciones / Despacho',
    subtitle: 'Gestión operativa de solicitudes, asignaciones, novedades y reemplazos.',
    activeSection: 'dashboard',
    selectedDate,
    metrics,
    role: req.session?.userRole || req.userRole,
    canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
  });
}

export function dispatchDashboardMetricsRouter(prisma) {
  const router = express.Router();

  router.get('/', requireOps, async (req, res) => renderOperationsDashboard(req, res, prisma));
  router.get('/abrir', requireOps, async (req, res) => renderOperationsDashboard(req, res, prisma));

  return router;
}
