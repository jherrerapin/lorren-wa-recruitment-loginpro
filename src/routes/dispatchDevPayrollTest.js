import express from 'express';
import {
  DEV_TEST_REQUEST_SOURCE,
  assignDevTestWorker,
  createDevTestServiceRequests,
  defaultDevTestTimes,
  formatBogotaDateTimeLocal,
  loadDevTestWorkspace,
  saveDevTestAttendance
} from '../services/dispatchDevPayrollTest.js';
import {
  resolveTestWorkspaceFeatureAccess,
  setTestWorkspaceFeatureAccess
} from '../services/testWorkspaceFeatureAccess.js';
import { loadTestWorkspacePayrollReport } from '../services/testWorkspacePayrollReport.js';
import {
  getDispatchTestWhatsappStatusView,
  sendDispatchTestWhatsappMessage
} from '../services/dispatchWhatsappTestService.js';

const ACTIVE_DEV_TEST_ASSIGNMENT_STATUSES = ['DEV_TEST_ASSIGNED', 'DEV_TEST_CONFIRMED'];

function normalizeString(value, maxLength = 300) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function roleFromRequest(req) {
  return normalizeString(req.session?.userRole || req.userRole, 80)?.toLowerCase();
}

function requireDev(req, res, next) {
  if (!roleFromRequest(req)) return res.redirect('/login');
  if (roleFromRequest(req) !== 'dev') return res.status(403).send('Acceso restringido a DEV.');
  return next();
}

function requireTestWorkspaceAccess(prisma) {
  return async (req, res, next) => {
    if (!roleFromRequest(req)) return res.redirect('/login');
    try {
      const access = await resolveTestWorkspaceFeatureAccess(prisma, {
        userRole: roleFromRequest(req),
        userId: req.session?.userId || req.userId,
        username: req.session?.username || req.username
      });
      if (!access.allowed) return res.status(403).send('No tienes permiso para acceder al entorno de pruebas.');
      req.canAccessTestWorkspace = true;
      if (req.session) req.session.canAccessTestWorkspace = true;
      return next();
    } catch (error) {
      console.error('[TEST_WORKSPACE_ACCESS_FAILED]', error);
      return res.status(503).send('No fue posible comprobar el permiso del entorno de pruebas.');
    }
  };
}

function actor(req) {
  return {
    actorUsername: normalizeString(req.session?.username || req.username, 160) || 'TEST-WORKSPACE',
    actorRole: roleFromRequest(req) || 'admin',
    ipAddress: normalizeString(req.ip, 120),
    userAgent: normalizeString(req.get?.('user-agent'), 500)
  };
}

function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function redirectWorkspace(res, serviceRequestId, { message = null, error = null } = {}) {
  const params = new URLSearchParams();
  if (serviceRequestId) params.set('serviceRequestId', serviceRequestId);
  if (message) params.set('message', message);
  if (error) params.set('error', error);
  return res.redirect(`/admin/operaciones/pruebas?${params.toString()}`);
}

function normalizeWhatsappContext(context) {
  if (!context || typeof context !== 'object') return undefined;
  return {
    serviceRequestId: normalizeString(context.serviceRequestId, 120),
    assignmentId: normalizeString(context.assignmentId, 120),
    workerId: normalizeString(context.workerId, 120),
    recipientName: normalizeString(context.recipientName, 180),
    messageType: 'DISPATCH_DEV_TEST_CONFIRMATION_REQUEST'
  };
}

function publicError(error) {
  const messages = {
    dev_test_client_operation_required: 'Selecciona cliente y operación.',
    dev_test_client_not_found: 'El cliente ya no existe o está inactivo.',
    dev_test_operation_not_found: 'La operación seleccionada no pertenece al cliente.',
    dev_test_service_not_found: 'Selecciona un servicio válido.',
    dev_test_service_date_invalid: 'La fecha del servicio no es válida.',
    dev_test_start_time_invalid: 'La hora de inicio no es válida.',
    dev_test_end_time_invalid: 'La hora de salida programada no es válida.',
    dev_test_required_workers_invalid: 'Ingresa una cantidad válida de auxiliares.',
    dev_test_assignment_required: 'Selecciona una solicitud y un auxiliar.',
    dev_test_request_not_found: 'La solicitud no existe o no está marcada como prueba.',
    dev_test_worker_required: 'El auxiliar no existe o fue eliminado.',
    dev_test_assignment_not_found: 'La asignación no existe o no pertenece al entorno de prueba.',
    dev_test_arrival_invalid: 'La fecha y hora de entrada no son válidas.',
    dev_test_departure_invalid: 'La fecha y hora de salida no son válidas.',
    dev_test_departure_before_arrival: 'La salida debe ser posterior a la entrada.',
    dev_test_break_start_required: 'No puedes registrar regreso de almuerzo sin inicio.',
    dev_test_break_start_invalid: 'El inicio del almuerzo no es válido.',
    dev_test_break_start_outside_shift: 'El inicio del almuerzo debe estar dentro del turno.',
    dev_test_break_end_invalid: 'El regreso del almuerzo debe ser posterior al inicio y anterior a la salida.'
  };
  return messages[error?.message] || 'No fue posible completar la prueba de nómina.';
}

function normalizeWorkspaceAvailability(workspace) {
  const assignedWorkerIds = new Set((workspace.selectedRequest?.assignments || [])
    .filter((assignment) => ACTIVE_DEV_TEST_ASSIGNMENT_STATUSES.includes(assignment.status))
    .map((assignment) => assignment.workerId));
  return {
    ...workspace,
    availableWorkers: (workspace.workers || []).filter((worker) => !assignedWorkerIds.has(worker.id))
  };
}

async function recalculateTestRequestStatus(prisma, request) {
  const assignedCount = await prisma.dispatchAssignment.count({
    where: { serviceRequestId: request.id, status: { in: ACTIVE_DEV_TEST_ASSIGNMENT_STATUSES } }
  });
  const status = assignedCount === 0
    ? 'DEV_TEST_PENDING'
    : assignedCount >= request.requiredWorkers ? 'DEV_TEST_COMPLETE' : 'DEV_TEST_PARTIAL';
  await prisma.dispatchServiceRequest.update({ where: { id: request.id }, data: { status } });
  return status;
}

export function dispatchDevPayrollTestRouter(prisma) {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: true, limit: '32kb' });
  const jsonParser = express.json({ limit: '16kb', strict: true });

  router.get('/api/users/:userId/access', requireDev, async (req, res) => {
    noStore(res);
    try {
      const access = await resolveTestWorkspaceFeatureAccess(prisma, {
        userRole: 'admin', userId: req.params.userId, username: null
      });
      return res.json({ ok: true, enabled: access.allowed, userId: access.userId });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'test_workspace_access_failed' });
    }
  });

  router.post('/api/users/:userId/access', requireDev, jsonParser, async (req, res) => {
    noStore(res);
    try {
      const result = await setTestWorkspaceFeatureAccess(prisma, {
        targetUserId: req.params.userId,
        enabled: req.body?.enabled === true,
        ...actor(req)
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'test_workspace_access_failed' });
    }
  });

  router.post('/api/users/by-username/:username/access', requireDev, jsonParser, async (req, res) => {
    noStore(res);
    const username = normalizeString(req.params.username, 160);
    const user = username ? await prisma.appUser.findUnique({ where: { username }, select: { id: true } }) : null;
    if (!user) return res.status(404).json({ ok: false, error: 'test_workspace_access_user_not_found' });
    try {
      const result = await setTestWorkspaceFeatureAccess(prisma, {
        targetUserId: user.id,
        enabled: req.body?.enabled === true,
        ...actor(req)
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'test_workspace_access_failed' });
    }
  });

  router.use(requireTestWorkspaceAccess(prisma));

  router.get('/', async (req, res) => {
    try {
      const workspace = normalizeWorkspaceAvailability(await loadDevTestWorkspace(prisma, req.query || {}));
      workspace.testReport = await loadTestWorkspacePayrollReport(prisma, workspace.selectedRequest);
      const role = roleFromRequest(req);
      return res.render('operacionesPruebasNomina', {
        pageTitle: 'Entorno de pruebas de asistencia y nómina',
        role,
        canUseTestWhatsapp: role === 'dev',
        canOpenOperationalPayroll: role === 'dev',
        workspace,
        message: normalizeString(req.query.message),
        error: normalizeString(req.query.error),
        formatBogotaDateTimeLocal,
        defaultDevTestTimes,
        testRequestSource: DEV_TEST_REQUEST_SOURCE
      });
    } catch (error) {
      console.error('[TEST_WORKSPACE_LOAD_FAILED]', error);
      return res.status(500).send('No fue posible cargar el entorno de pruebas.');
    }
  });

  router.get('/whatsapp', requireDev, async (req, res) => {
    noStore(res);
    const status = await getDispatchTestWhatsappStatusView();
    return res.render('operacionesWhatsappEstado', {
      pageTitle: 'WhatsApp de pruebas de despacho', role: 'dev', message: normalizeString(req.query?.message),
      isDev: true, technicalLastError: status.lastError || null, ...status,
      whatsappTitle: 'WhatsApp oficial de pruebas de despacho', whatsappEyebrow: 'Entorno aislado DEV',
      whatsappDescription: 'Integración oficial de prueba con un Phone Number ID distinto al operativo. No usa QR, navegador automatizado ni dispositivos vinculados.',
      whatsappBasePath: '/admin/operaciones/pruebas/whatsapp', whatsappReturnHref: '/admin/operaciones/pruebas',
      whatsappReturnLabel: 'Volver al entorno de pruebas', whatsappAssignmentsHref: '/admin/operaciones/pruebas',
      whatsappAssignmentsLabel: 'Asignaciones de prueba'
    });
  });

  router.get('/whatsapp/estado', requireDev, async (_req, res) => {
    noStore(res);
    const status = await getDispatchTestWhatsappStatusView();
    return res.json({ ok: true, isDev: true, technicalLastError: status.lastError || null, ...status });
  });

  router.post('/whatsapp/enviar', requireDev, jsonParser, async (req, res) => {
    noStore(res);
    try {
      const result = await sendDispatchTestWhatsappMessage({
        phone: req.body?.phone, context: normalizeWhatsappContext(req.body?.context)
      });
      return res.json({
        ok: true,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        phone: result.phone,
        templateName: result.templateName
      });
    } catch (error) {
      const rawStatusCode = Number(error?.statusCode || 0);
      const statusCode = rawStatusCode >= 400 && rawStatusCode <= 599 ? rawStatusCode : 500;
      return res.status(statusCode).json({ ok: false, message: error?.message || 'No se pudo enviar el WhatsApp de prueba.' });
    }
  });

  router.post('/solicitudes', formParser, async (req, res) => {
    try {
      const result = await createDevTestServiceRequests(prisma, req.body, actor(req));
      return redirectWorkspace(res, result.created[0]?.id || null, {
        message: `${result.created.length} solicitud(es) de prueba creadas. No se ejecutó autoasignación ni notificaciones.`
      });
    } catch (error) {
      return redirectWorkspace(res, null, { error: publicError(error) });
    }
  });

  router.post('/solicitudes/:serviceRequestId/asignar', formParser, async (req, res) => {
    try {
      await assignDevTestWorker(prisma, { serviceRequestId: req.params.serviceRequestId, workerId: req.body.workerId }, actor(req));
      const request = await prisma.dispatchServiceRequest.findUnique({ where: { id: req.params.serviceRequestId } });
      if (request?.source === DEV_TEST_REQUEST_SOURCE) await recalculateTestRequestStatus(prisma, request);
      return redirectWorkspace(res, req.params.serviceRequestId, { message: 'Auxiliar asignado dentro del entorno aislado de pruebas.' });
    } catch (error) {
      return redirectWorkspace(res, req.params.serviceRequestId, { error: publicError(error) });
    }
  });

  router.post('/asignaciones/:assignmentId/jornada', formParser, async (req, res) => {
    const serviceRequestId = normalizeString(req.body.serviceRequestId, 120);
    try {
      await saveDevTestAttendance(prisma, {
        assignmentId: req.params.assignmentId,
        arrivalAt: req.body.arrivalAt,
        breakStartAt: req.body.breakStartAt,
        breakEndAt: req.body.breakEndAt,
        departureAt: req.body.departureAt,
        notes: req.body.notes
      }, actor(req));
      return redirectWorkspace(res, serviceRequestId, {
        message: 'Jornada aislada guardada. El cálculo se actualizó dentro del entorno de pruebas.'
      });
    } catch (error) {
      return redirectWorkspace(res, serviceRequestId, { error: publicError(error) });
    }
  });

  router.post('/asignaciones/:assignmentId/quitar', formParser, async (req, res) => {
    const serviceRequestId = normalizeString(req.body.serviceRequestId, 120);
    try {
      const assignment = await prisma.dispatchAssignment.findUnique({
        where: { id: req.params.assignmentId }, include: { serviceRequest: true, worker: true, attendanceSession: true }
      });
      if (
        !assignment
        || assignment.serviceRequest?.source !== DEV_TEST_REQUEST_SOURCE
        || !ACTIVE_DEV_TEST_ASSIGNMENT_STATUSES.includes(assignment.status)
      ) {
        throw new Error('dev_test_assignment_not_found');
      }
      if (assignment.attendanceSession) {
        const session = assignment.attendanceSession;
        await prisma.$transaction([
          prisma.dispatchAttendanceReview.deleteMany({ where: { attendanceSessionId: session.id } }),
          prisma.dispatchAttendanceMark.deleteMany({ where: { attendanceSessionId: session.id } }),
          prisma.dispatchAttendanceSession.delete({ where: { id: session.id } })
        ]);
      }
      await prisma.dispatchWhatsappConfirmation.updateMany({
        where: {
          assignmentId: assignment.id,
          status: { in: ['PENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN', 'CONFIRMED_REPLY_PENDING'] }
        },
        data: { status: 'EXPIRED' }
      });
      await prisma.dispatchAssignment.delete({ where: { id: assignment.id } });
      await recalculateTestRequestStatus(prisma, assignment.serviceRequest);
      return redirectWorkspace(res, serviceRequestId, { message: 'Asignación de prueba eliminada. El auxiliar real no fue modificado.' });
    } catch (error) {
      return redirectWorkspace(res, serviceRequestId, { error: publicError(error) });
    }
  });

  return router;
}
