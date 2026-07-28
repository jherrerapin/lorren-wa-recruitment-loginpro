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
  return messages[error?.message] || 'No fue posible completar la prueba de nómina.';
}

export function dispatchDevPayrollTestRouter(prisma) {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: true, limit: '32kb' });

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
      await saveDevTestAttendance(prisma, {
        assignmentId: req.params.assignmentId,
        arrivalAt: req.body.arrivalAt,
        breakStartAt: req.body.breakStartAt,
        breakEndAt: req.body.breakEndAt,
        departureAt: req.body.departureAt,
        notes: req.body.notes
      }, actor(req));
      return redirectWorkspace(res, serviceRequestId, {
        message: 'Jornada manual guardada. Ya puedes abrir Nómina con datos de prueba.'
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
      await prisma.dispatchAssignment.delete({ where: { id: assignment.id } });
      return redirectWorkspace(res, serviceRequestId, { message: 'Asignación de prueba eliminada.' });
    } catch (error) {
      return redirectWorkspace(res, serviceRequestId, { error: publicError(error) });
    }
  });

  return router;
}
