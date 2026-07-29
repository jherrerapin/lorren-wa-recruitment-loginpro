import express from 'express';
import { loadPayrollReport } from '../modules/dispatch-payroll/application/payrollReport.js';
import {
  PAYROLL_CONCEPT_CODES,
  formatPayrollMinutes
} from '../modules/dispatch-payroll/domain/payrollConceptEngine.js';
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
} from '../services/dispatchTestWhatsappWebService.js';

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

function redirectWorkspace(res, serviceRequestId, { message = null, error = null } = {}) {
  const params = new URLSearchParams();
  if (serviceRequestId) params.set('serviceRequestId', serviceRequestId);
  if (message) params.set('message', message);
  if (error) params.set('error', error);
  return res.redirect(`/admin/operaciones/pruebas?${params.toString()}`);
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
  return messages[error?.message] || error?.message || 'No fue posible completar la prueba.';
}

function bogotaDateKey(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function payrollPreviewRange(request) {
  if (!request) return null;
  const dates = [bogotaDateKey(request.serviceDate)];
  for (const assignment of request.assignments || []) {
    const session = assignment.attendanceSession;
    dates.push(bogotaDateKey(session?.arrivalReportedAt));
    dates.push(bogotaDateKey(session?.departureReportedAt));
  }
  const validDates = dates.filter(Boolean).sort();
  return validDates.length ? { from: validDates[0], to: validDates[validDates.length - 1] } : null;
}

function summarizePreviewRows(rows = []) {
  const conceptMinutes = Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, 0]));
  const totals = {
    workers: rows.length,
    totalMinutes: 0,
    ordinaryMinutes: 0,
    overtimeMinutes: 0,
    workersWithNovelties: 0,
    conceptMinutes
  };
  for (const row of rows) {
    totals.totalMinutes += Number(row.totalMinutes) || 0;
    totals.ordinaryMinutes += Number(row.ordinaryMinutes) || 0;
    totals.overtimeMinutes += Number(row.overtimeMinutes) || 0;
    if (!row.exportable) totals.workersWithNovelties += 1;
    for (const code of PAYROLL_CONCEPT_CODES) conceptMinutes[code] += Number(row.conceptMinutes?.[code]) || 0;
  }
  return totals;
}

async function loadSelectedPayrollPreview(prisma, workspace) {
  const request = workspace.selectedRequest;
  const range = payrollPreviewRange(request);
  if (!request || !range) return null;
  const report = await loadPayrollReport(prisma, {
    periodType: 'CUSTOM',
    from: range.from,
    to: range.to,
    operationPointId: request.operationPointId,
    includeTest: 'true'
  }, { allowTestData: true });
  const selectedWorkerIds = new Set((request.assignments || []).map((assignment) => assignment.workerId));
  const rows = report.rows.filter((row) => selectedWorkerIds.has(row.workerId));
  return {
    ...report,
    rows,
    totals: summarizePreviewRows(rows),
    period: { ...report.period, ...range },
    recordedSessions: (request.assignments || []).filter((assignment) => {
      const session = assignment.attendanceSession;
      return Boolean(session?.arrivalReportedAt && session?.departureReportedAt);
    }).length
  };
}

async function recalculateTestRequestStatus(prisma, request) {
  const assignedCount = await prisma.dispatchAssignment.count({
    where: {
      serviceRequestId: request.id,
      status: { in: ['DEV_TEST_ASSIGNED', 'DEV_TEST_CONFIRMED'] }
    }
  });
  const status = assignedCount === 0
    ? 'DEV_TEST_PENDING'
    : assignedCount >= request.requiredWorkers
      ? 'DEV_TEST_COMPLETE'
      : 'DEV_TEST_PARTIAL';
  await prisma.dispatchServiceRequest.update({ where: { id: request.id }, data: { status } });
  return status;
}

function whatsappViewLocals(status) {
  return {
    pageTitle: 'WhatsApp de prueba',
    role: 'dev',
    message: null,
    whatsappTitle: 'WhatsApp de prueba',
    whatsappEyebrow: 'Entorno DEV aislado',
    whatsappDescription: 'Vincula una segunda cuenta para probar envíos y confirmaciones sin utilizar la línea operativa de despacho.',
    statusEndpoint: '/admin/operaciones/pruebas/whatsapp/estado',
    closeSessionEndpoint: '/admin/operaciones/pruebas/whatsapp/cerrar-sesion',
    backUrl: '/admin/operaciones/pruebas',
    backLabel: 'Volver a pruebas',
    assignmentUrl: '/admin/operaciones/pruebas',
    assignmentLabel: 'Solicitudes de prueba',
    ...status
  };
}

export function dispatchDevPayrollTestRouter(prisma) {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: true, limit: '32kb' });

  router.use(requireDev);

  router.get('/', async (req, res) => {
    const workspace = await loadDevTestWorkspace(prisma, req.query || {});
    const [payrollPreview, testWhatsappStatus] = await Promise.all([
      loadSelectedPayrollPreview(prisma, workspace),
      getDispatchTestWhatsappStatusView({ autoStart: false })
    ]);
    return res.render('operacionesPruebasNomina', {
      pageTitle: 'Pruebas DEV de asistencia y nómina',
      role: 'dev',
      workspace,
      payrollPreview,
      conceptCodes: PAYROLL_CONCEPT_CODES,
      formatPayrollMinutes,
      testWhatsappStatus,
      message: normalizeString(req.query.message),
      error: normalizeString(req.query.error),
      formatBogotaDateTimeLocal,
      defaultDevTestTimes,
      testRequestSource: DEV_TEST_REQUEST_SOURCE
    });
  });

  router.get('/whatsapp', async (req, res) => {
    initDispatchTestWhatsappClient();
    const status = await getDispatchTestWhatsappStatusView({ autoStart: false });
    return res.render('operacionesWhatsappEstado', {
      ...whatsappViewLocals(status),
      message: normalizeString(req.query.message)
    });
  });

  router.get('/whatsapp/estado', async (_req, res) => {
    return res.json({ ok: true, ...await getDispatchTestWhatsappStatusView({ autoStart: true }) });
  });

  router.post('/whatsapp/cerrar-sesion', async (_req, res) => {
    await closeDispatchTestWhatsappSession();
    return res.redirect(`/admin/operaciones/pruebas/whatsapp?message=${encodeURIComponent('Sesión de WhatsApp de prueba cerrada.')}`);
  });

  router.post('/whatsapp/enviar', formParser, async (req, res) => {
    const serviceRequestId = normalizeString(req.body.serviceRequestId, 120);
    try {
      await sendDispatchTestWhatsappMessage({
        phone: req.body.phone,
        message: req.body.message,
        context: {
          assignmentId: req.body.assignmentId,
          serviceRequestId,
          workerId: req.body.workerId
        }
      });
      return redirectWorkspace(res, serviceRequestId, {
        message: 'Mensaje enviado desde la cuenta WhatsApp de prueba. La respuesta del sujeto actualizará la confirmación aislada.'
      });
    } catch (error) {
      return redirectWorkspace(res, serviceRequestId, { error: publicError(error) });
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
        message: 'Sujeto de prueba asignado.'
      });
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
        message: 'Jornada guardada y calculada. El resultado aparece en el resumen de Nómina de esta misma pantalla.'
      });
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
      await prisma.dispatchWhatsappConfirmation.deleteMany({ where: { assignmentId: assignment.id, status: { startsWith: 'DEV_TEST_' } } });
      await prisma.dispatchAssignment.delete({ where: { id: assignment.id } });
      await recalculateTestRequestStatus(prisma, assignment.serviceRequest);
      return redirectWorkspace(res, serviceRequestId, { message: 'Asignación de prueba eliminada.' });
    } catch (error) {
      return redirectWorkspace(res, serviceRequestId, { error: publicError(error) });
    }
  });

  return router;
}
