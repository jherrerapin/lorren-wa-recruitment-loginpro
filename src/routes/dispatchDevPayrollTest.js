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
  closeDispatchTestWhatsappSession,
  getDispatchTestWhatsappStatusView,
  initDispatchTestWhatsappClient,
  sendDispatchTestWhatsappMessage
} from '../services/dispatchWhatsappWebTestService.js';

function normalizeString(value, maxLength = 300) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function requireDev(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (!role) return res.redirect('/login');
  if (role !== 'dev') return res.status(403).send('Acceso restringido a DEV.');
  return next();
}

function actor(req) {
  return {
    actorUsername: normalizeString(req.session?.username || req.username, 160) || 'DEV',
    actorRole: 'dev'
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

function payrollResultUrl(result) {
  const params = new URLSearchParams();
  const from = formatBogotaDateTimeLocal(result.arrivalAt).slice(0, 10);
  const to = formatBogotaDateTimeLocal(result.departureAt).slice(0, 10);
  const clientId = result.assignment?.serviceRequest?.operationPoint?.clientId || '';
  const workerId = result.assignment?.worker?.id || result.assignment?.workerId || '';
  params.set('periodType', 'CUSTOM');
  params.set('from', from);
  params.set('to', to || from);
  if (clientId) params.set('clientId', clientId);
  if (workerId) params.set('workerId', workerId);
  params.set('includeTest', 'true');
  params.set('success', 'Jornada manual guardada y calculada con datos de prueba.');
  return `/admin/operaciones/asistencia/nomina?${params.toString()}`;
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
    dev_test_assignment_required: 'Selecciona una solicitud y un auxiliar de prueba.',
    dev_test_request_not_found: 'La solicitud no existe o no está marcada como prueba.',
    dev_test_worker_required: 'Solo se pueden asignar auxiliares marcados como sujetos de prueba.',
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

async function recalculateTestRequestStatus(prisma, request) {
  const assignedCount = await prisma.dispatchAssignment.count({
    where: { serviceRequestId: request.id, status: 'DEV_TEST_ASSIGNED' }
  });
  const status = assignedCount === 0
    ? 'DEV_TEST_PENDING'
    : assignedCount >= request.requiredWorkers
      ? 'DEV_TEST_COMPLETE'
      : 'DEV_TEST_PARTIAL';
  await prisma.dispatchServiceRequest.update({ where: { id: request.id }, data: { status } });
  return status;
}

export function dispatchDevPayrollTestRouter(prisma) {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: true, limit: '32kb' });
  const jsonParser = express.json({ limit: '16kb', strict: true });

  router.use(requireDev);

  router.get('/', async (req, res) => {
    const workspace = await loadDevTestWorkspace(prisma, req.query || {});
    return res.render('operacionesPruebasNomina', {
      pageTitle: 'Pruebas DEV de asistencia y nómina',
      role: 'dev',
      workspace,
      message: normalizeString(req.query.message),
      error: normalizeString(req.query.error),
      formatBogotaDateTimeLocal,
      defaultDevTestTimes,
      testRequestSource: DEV_TEST_REQUEST_SOURCE
    });
  });

  router.get('/whatsapp', async (req, res) => {
    noStore(res);
    initDispatchTestWhatsappClient();
    const status = await getDispatchTestWhatsappStatusView({ autoStart: false });
    return res.render('operacionesWhatsappEstado', {
      pageTitle: 'WhatsApp de pruebas de despacho',
      role: 'dev',
      message: normalizeString(req.query?.message),
      isDev: true,
      technicalLastError: status.lastError || null,
      ...status,
      whatsappTitle: 'WhatsApp de pruebas de despacho',
      whatsappEyebrow: 'Entorno aislado DEV',
      whatsappDescription: 'Vincula una cuenta distinta a la línea operativa para probar envíos y confirmaciones de sujetos de prueba.',
      whatsappBasePath: '/admin/operaciones/pruebas/whatsapp',
      whatsappReturnHref: '/admin/operaciones/pruebas',
      whatsappReturnLabel: 'Volver a Pruebas DEV',
      whatsappAssignmentsHref: '/admin/operaciones/pruebas',
      whatsappAssignmentsLabel: 'Sujetos de prueba',
      whatsappCloseConfirm: '¿Cerrar únicamente la sesión de WhatsApp de pruebas? La cuenta operativa no se modificará.',
      whatsappQrInstruction: 'Escanea este QR desde la cuenta secundaria que usarás exclusivamente para las pruebas.'
    });
  });

  router.get('/whatsapp/estado', async (req, res) => {
    noStore(res);
    const shouldStart = !['0', 'false'].includes(String(req.query?.start || '').toLowerCase());
    const status = await getDispatchTestWhatsappStatusView({ autoStart: shouldStart });
    return res.json({ ok: true, isDev: true, technicalLastError: status.lastError || null, ...status });
  });

  router.post('/whatsapp/cerrar-sesion', async (_req, res) => {
    noStore(res);
    await closeDispatchTestWhatsappSession();
    const message = encodeURIComponent('Sesión de WhatsApp de pruebas cerrada. La cuenta operativa continúa sin cambios.');
    return res.redirect(`/admin/operaciones/pruebas/whatsapp?message=${message}`);
  });

  router.post('/whatsapp/enviar', jsonParser, async (req, res) => {
    noStore(res);
    try {
      const result = await sendDispatchTestWhatsappMessage({
        phone: req.body?.phone,
        message: req.body?.message,
        context: normalizeWhatsappContext(req.body?.context)
      });
      return res.json({ ok: true, providerMessageId: result.providerMessageId, phone: result.phone });
    } catch (error) {
      const statusCode = error?.statusCode === 503 ? 503 : 400;
      return res.status(statusCode).json({ ok: false, message: error?.message || 'No se pudo enviar el WhatsApp de prueba.' });
    }
  });

  router.post('/solicitudes', formParser, async (req, res) => {
    try {
      const result = await createDevTestServiceRequests(prisma, req.body, actor(req));
      const firstId = result.created[0]?.id || null;
      return redirectWorkspace(res, firstId, {
        message: `${result.created.length} solicitud(es) de prueba creadas. No se ejecutó autoasignación ni notificaciones.`
      });
    } catch (error) {
      return redirectWorkspace(res, null, { error: publicError(error) });
    }
  });

  router.post('/solicitudes/:serviceRequestId/asignar', formParser, async (req, res) => {
    try {
      await assignDevTestWorker(prisma, {
        serviceRequestId: req.params.serviceRequestId,
        workerId: req.body.workerId
      }, actor(req));
      return redirectWorkspace(res, req.params.serviceRequestId, {
        message: 'Sujeto de prueba asignado y confirmado.'
      });
    } catch (error) {
      return redirectWorkspace(res, req.params.serviceRequestId, { error: publicError(error) });
    }
  });

  router.post('/asignaciones/:assignmentId/jornada', formParser, async (req, res) => {
    const serviceRequestId = normalizeString(req.body.serviceRequestId, 120);
    try {
      const result = await saveDevTestAttendance(prisma, {
        assignmentId: req.params.assignmentId,
        arrivalAt: req.body.arrivalAt,
        breakStartAt: req.body.breakStartAt,
        breakEndAt: req.body.breakEndAt,
        departureAt: req.body.departureAt,
        notes: req.body.notes
      }, actor(req));
      return res.redirect(payrollResultUrl(result));
    } catch (error) {
      return redirectWorkspace(res, serviceRequestId, { error: publicError(error) });
    }
  });

  router.post('/asignaciones/:assignmentId/quitar', formParser, async (req, res) => {
    const serviceRequestId = normalizeString(req.body.serviceRequestId, 120);
    try {
      const assignment = await prisma.dispatchAssignment.findUnique({
        where: { id: req.params.assignmentId },
        include: { serviceRequest: true, worker: true, attendanceSession: true }
      });
      if (!assignment || assignment.serviceRequest?.source !== DEV_TEST_REQUEST_SOURCE || assignment.worker?.isTestProfile !== true) {
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
        where: { assignmentId: assignment.id, status: { in: ['PENDING', 'DELIVERY_UNKNOWN', 'CONFIRMED_REPLY_PENDING'] } },
        data: { status: 'EXPIRED' }
      });
      await prisma.dispatchAssignment.delete({ where: { id: assignment.id } });
      await recalculateTestRequestStatus(prisma, assignment.serviceRequest);
      return redirectWorkspace(res, serviceRequestId, { message: 'Asignación de prueba eliminada.' });
    } catch (error) {
      return redirectWorkspace(res, serviceRequestId, { error: publicError(error) });
    }
  });

  return router;
}
