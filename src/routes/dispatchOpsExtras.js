import express from 'express';

const TEMPLATE_KEY = 'DISPATCH_ASSIGNMENT_WHATSAPP';
const DEFAULT_ASSIGNMENT_TEMPLATE = 'Hola {{nombre}}, te confirmamos asignacion para {{fecha}} en {{operacion}}. Direccion: {{direccion}}. Horario: {{horaInicio}} - {{horaFin}}. Servicio: {{servicio}}. Cliente: {{cliente}}. Por favor confirma recibido.';

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

function redirectToAssignment(serviceRequestId, message) {
  const params = new URLSearchParams();
  if (serviceRequestId) params.set('serviceRequestId', serviceRequestId);
  if (message) params.set('message', message);
  return `/admin/operaciones/asignaciones?${params.toString()}`;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDateParam(value) {
  const rawValue = normalizeString(value);
  if (!rawValue) return todayIsoDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) return todayIsoDate();
  return rawValue;
}

function buildUtcDayRange(dateText) {
  const start = new Date(`${dateText}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

async function getTemplate(prisma) {
  const template = await prisma.dispatchMessageTemplate.findUnique({ where: { key: TEMPLATE_KEY } });
  return template?.content || DEFAULT_ASSIGNMENT_TEMPLATE;
}

export function dispatchOpsExtrasRouter(prisma) {
  const router = express.Router();

  router.get('/novedades', requireOps, async (req, res) => {
    const selectedDate = normalizeDateParam(req.query.fecha || req.query.date);
    const status = normalizeString(req.query.status) || 'OPEN';
    const { start, end } = buildUtcDayRange(selectedDate);
    const incidents = await prisma.dispatchIncident.findMany({
      where: {
        ...(status === 'ALL' ? {} : { status }),
        serviceRequest: { serviceDate: { gte: start, lt: end } }
      },
      include: {
        serviceRequest: true,
        worker: true,
        assignment: { include: { worker: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    return res.render('operacionesNovedades', {
      pageTitle: 'Novedades operativas',
      selectedDate,
      status,
      incidents,
      role: req.session?.userRole || req.userRole,
      canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
    });
  });

  router.get('/api/asignacion-template', requireOps, async (_req, res) => {
    const content = await getTemplate(prisma);
    return res.json({ key: TEMPLATE_KEY, content });
  });

  router.post('/asignaciones/template', requireOps, async (req, res) => {
    const content = normalizeString(req.body.content);
    if (!content) return res.status(400).json({ error: 'La plantilla no puede estar vacia.' });

    const username = req.session?.username || req.username || null;
    await prisma.dispatchMessageTemplate.upsert({
      where: { key: TEMPLATE_KEY },
      update: { content, updatedByUsername: username },
      create: { key: TEMPLATE_KEY, content, createdByUsername: username, updatedByUsername: username }
    });

    return res.json({ ok: true, content });
  });

  router.post('/asignaciones/novedades', requireOps, async (req, res) => {
    const serviceRequestId = normalizeString(req.body.serviceRequestId);
    const type = normalizeString(req.body.type);
    const description = normalizeString(req.body.description);
    const assignmentId = normalizeString(req.body.assignmentId);
    const workerId = normalizeString(req.body.workerId);

    if (!serviceRequestId || !type || !description) {
      return res.status(400).send('Solicitud, tipo y descripcion son requeridos.');
    }

    const serviceRequest = await prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true } });
    if (!serviceRequest) return res.status(404).send('Solicitud no encontrada');

    await prisma.dispatchIncident.create({
      data: {
        serviceRequestId,
        assignmentId: assignmentId || null,
        workerId: workerId || null,
        type,
        description,
        reportedBy: normalizeString(req.body.reportedBy),
        status: 'OPEN',
        createdByUsername: req.session?.username || req.username || null
      }
    });

    return res.redirect(redirectToAssignment(serviceRequestId, 'Novedad registrada.'));
  });

  router.post('/asignaciones/novedades/:incidentId/resolver', requireOps, async (req, res) => {
    const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true, serviceRequestId: true } });
    if (!incident) return res.status(404).send('Novedad no encontrada');

    await prisma.dispatchIncident.update({
      where: { id: incident.id },
      data: {
        status: 'RESOLVED',
        resolutionNote: normalizeString(req.body.resolutionNote),
        resolvedByUsername: req.session?.username || req.username || null,
        resolvedAt: new Date()
      }
    });

    return res.redirect(redirectToAssignment(incident.serviceRequestId, 'Novedad resuelta.'));
  });

  router.post('/novedades/:incidentId/resolver', requireOps, async (req, res) => {
    const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true } });
    if (!incident) return res.status(404).send('Novedad no encontrada');
    await prisma.dispatchIncident.update({
      where: { id: incident.id },
      data: {
        status: 'RESOLVED',
        resolutionNote: normalizeString(req.body.resolutionNote),
        resolvedByUsername: req.session?.username || req.username || null,
        resolvedAt: new Date()
      }
    });
    return res.redirect(`/admin/operaciones/novedades?fecha=${encodeURIComponent(normalizeDateParam(req.body.fecha))}&status=${encodeURIComponent(normalizeString(req.body.status) || 'OPEN')}`);
  });

  router.post('/asignaciones/novedades/:incidentId/reabrir', requireOps, async (req, res) => {
    const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true, serviceRequestId: true } });
    if (!incident) return res.status(404).send('Novedad no encontrada');

    await prisma.dispatchIncident.update({
      where: { id: incident.id },
      data: { status: 'OPEN', resolvedAt: null, resolvedByUsername: null, resolutionNote: null }
    });

    return res.redirect(redirectToAssignment(incident.serviceRequestId, 'Novedad reabierta.'));
  });

  router.post('/novedades/:incidentId/reabrir', requireOps, async (req, res) => {
    const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true } });
    if (!incident) return res.status(404).send('Novedad no encontrada');
    await prisma.dispatchIncident.update({ where: { id: incident.id }, data: { status: 'OPEN', resolvedAt: null, resolvedByUsername: null, resolutionNote: null } });
    return res.redirect(`/admin/operaciones/novedades?fecha=${encodeURIComponent(normalizeDateParam(req.body.fecha))}&status=${encodeURIComponent(normalizeString(req.body.status) || 'ALL')}`);
  });

  return router;
}
