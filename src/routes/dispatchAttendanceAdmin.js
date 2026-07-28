import express from 'express';
import {
  loadAttendanceAdminBoard,
  registerManualAttendance
} from '../modules/dispatch-attendance/application/adminAttendance.js';
import {
  enrichAttendanceBoardWithWorkday,
  reviewAttendanceWorkdaySession
} from '../modules/dispatch-attendance/application/attendanceAdminWorkday.js';
import { getSignedDownloadUrl } from '../services/storage.js';
import { dispatchPayrollRouter } from './dispatchPayroll.js';

const SAFE_FILTER_KEYS = Object.freeze(['from', 'to', 'status', 'client', 'q']);

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

function safeHtmlAttributeState(value, fallback = '') {
  const normalized = normalizeString(value);
  if (!normalized) return fallback;
  return normalized.replace(/[&<>"'`]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
}

function sanitizeBoardFilterState(board) {
  return {
    ...board,
    range: {
      from: safeHtmlAttributeState(board?.range?.from),
      to: safeHtmlAttributeState(board?.range?.to)
    },
    filters: {
      status: safeHtmlAttributeState(board?.filters?.status, 'ALL'),
      client: safeHtmlAttributeState(board?.filters?.client, 'ALL'),
      q: safeHtmlAttributeState(board?.filters?.q)
    }
  };
}

function actorFromRequest(req) {
  return {
    actorUsername: normalizeString(req.session?.username || req.username) || 'operaciones',
    actorRole: normalizeString(req.session?.userRole || req.userRole)
  };
}

function safeReturnParams(source = {}) {
  const params = new URLSearchParams();
  SAFE_FILTER_KEYS.forEach((key) => {
    const value = safeHtmlAttributeState(source?.[key]);
    if (value) params.set(key, value);
  });
  return params;
}

function redirectToBoard(res, source, { success = null, error = null } = {}) {
  const params = safeReturnParams(source);
  if (success) params.set('success', success);
  if (error) params.set('error', error);
  const query = params.toString();
  return res.redirect(`/admin/operaciones/asistencia${query ? `?${query}` : ''}`);
}

function publicErrorMessage(error) {
  const code = typeof error?.message === 'string' ? error.message : '';
  const messages = {
    attendance_review_session_not_found: 'La marcación ya no existe o fue eliminada.',
    attendance_review_arrival_required: 'No existe una llegada reportada para revisar.',
    attendance_review_departure_required: 'No existe una salida reportada para revisar.',
    attendance_review_break_end_required: 'El almuerzo quedó abierto. Debe registrarse su final antes de validar la jornada.',
    attendance_review_action_invalid: 'La acción seleccionada no es válida.',
    attendance_review_status_invalid: 'Selecciona si la llegada fue a tiempo o tarde.',
    attendance_review_reason_required: 'Escribe el motivo de la decisión.',
    attendance_review_reason_too_short: 'El motivo debe tener al menos 5 caracteres.',
    attendance_manual_assignment_not_found: 'La asignación ya no existe.',
    attendance_manual_assignment_inactive: 'La asignación ya no está activa.',
    attendance_manual_not_allowed: 'Este punto no permite registrar asistencia manual.',
    attendance_manual_arrival_exists: 'Esta asignación ya tiene una llegada registrada.',
    attendance_manual_status_invalid: 'Selecciona si la llegada fue a tiempo o tarde.',
    attendance_manual_reason_required: 'Escribe el motivo de la marcación manual.',
    attendance_manual_reason_too_short: 'El motivo debe tener al menos 5 caracteres.',
    attendance_work_break_end_before_start: 'El fin del almuerzo no puede ser anterior a su inicio.',
    attendance_work_departure_before_arrival: 'La salida no puede ser anterior a la entrada.',
    service_start_time_required: 'La solicitud no tiene una hora de inicio válida.',
    service_start_time_invalid: 'La hora de inicio de la solicitud no es válida.'
  };
  return messages[code] || 'No fue posible completar la acción de asistencia.';
}

function applyNoStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function validAttendanceEvidenceKey(value) {
  return typeof value === 'string'
    && /^attendance\/[A-Za-z0-9_-]{1,120}\/[A-Za-z0-9_-]{1,120}\/(?:arrival|departure)\/[A-Za-z0-9_.-]{1,180}$/.test(value);
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function automaticLateReason(minutesLate) {
  const minutes = Math.max(0, Number.isFinite(minutesLate) ? Math.floor(minutesLate) : 0);
  if (minutes === 1) return 'Llegada tarde por 1 minuto frente a la hora programada.';
  if (minutes > 1) return `Llegada tarde por ${minutes} minutos frente a la hora programada.`;
  return 'Llegada clasificada como tarde.';
}

function isAutomaticLateReason(value) {
  return /^Llegada (?:tarde por \d+ minutos? frente a la hora programada|clasificada como tarde)\.$/.test(value);
}

export async function resolveAttendanceReviewReason(prisma, input = {}) {
  const action = normalizeString(input.action)?.toUpperCase();
  const attendanceStatus = normalizeString(input.attendanceStatus)?.toUpperCase();
  const providedReason = normalizeString(input.reason);

  if (action !== 'VALIDATE') return input.reason;
  if (attendanceStatus === 'ON_TIME') {
    return providedReason && providedReason.length >= 5
      ? providedReason.slice(0, 500)
      : 'Validación de llegada a tiempo.';
  }
  if (attendanceStatus !== 'LATE') return input.reason;

  let minutesLate = 0;
  if (prisma?.dispatchAttendanceSession && typeof prisma.dispatchAttendanceSession.findUnique === 'function') {
    const session = await prisma.dispatchAttendanceSession.findUnique({
      where: { id: input.sessionId },
      select: { arrivalReportedAt: true, expectedStartAt: true }
    });
    const arrivalAt = session?.arrivalReportedAt instanceof Date
      ? session.arrivalReportedAt
      : new Date(session?.arrivalReportedAt || Number.NaN);
    const expectedStartAt = session?.expectedStartAt instanceof Date
      ? session.expectedStartAt
      : new Date(session?.expectedStartAt || Number.NaN);
    if (validDate(arrivalAt) && validDate(expectedStartAt)) {
      minutesLate = Math.max(0, Math.floor((arrivalAt.getTime() - expectedStartAt.getTime()) / 60_000));
    }
  }

  const automaticReason = automaticLateReason(minutesLate);
  if (providedReason && providedReason.length >= 5 && !isAutomaticLateReason(providedReason)) {
    const observation = providedReason.slice(0, 350);
    return `${automaticReason} Observación administrativa: ${observation}`.slice(0, 500);
  }
  return automaticReason;
}

export function dispatchAttendanceAdminRouter(prisma) {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: false, limit: '16kb' });

  router.use('/nomina', dispatchPayrollRouter(prisma));

  router.get('/', async (req, res) => {
    applyNoStore(res);
    try {
      const baseBoard = await loadAttendanceAdminBoard(prisma, req.query || {});
      const enrichedBoard = await enrichAttendanceBoardWithWorkday(prisma, baseBoard);
      const board = sanitizeBoardFilterState(enrichedBoard);
      return res.render('operacionesAsistencia', {
        pageTitle: 'Asistencia operativa',
        role: req.session?.userRole || req.userRole,
        board,
        success: normalizeString(req.query?.success),
        error: normalizeString(req.query?.error)
      });
    } catch (error) {
      console.error('[ATTENDANCE_ADMIN_BOARD_FAILED]', error);
      return res.status(500).render('operacionesAsistencia', {
        pageTitle: 'Asistencia operativa',
        role: req.session?.userRole || req.userRole,
        board: {
          range: { from: '', to: '' },
          filters: { status: 'ALL', client: 'ALL', q: '' },
          clients: [], rows: [],
          metrics: { total: 0, pendingReview: 0, autoValidated: 0, manualValidated: 0, late: 0, rejected: 0, noShow: 0 }
        },
        success: null,
        error: 'No fue posible cargar el panel de asistencia.'
      });
    }
  });

  router.post('/sessions/:sessionId/review', formParser, async (req, res) => {
    try {
      const reason = await resolveAttendanceReviewReason(prisma, {
        sessionId: req.params.sessionId,
        action: req.body.action,
        attendanceStatus: req.body.attendanceStatus,
        reason: req.body.reason
      });
      await reviewAttendanceWorkdaySession(prisma, {
        sessionId: req.params.sessionId,
        action: req.body.action,
        attendanceStatus: req.body.attendanceStatus,
        recognizeEarlyArrival: req.body.recognizeEarlyArrival === 'true',
        reason,
        notes: req.body.notes,
        ...actorFromRequest(req)
      });
      return redirectToBoard(res, req.body, { success: 'La decisión y el tiempo trabajado quedaron guardados con auditoría.' });
    } catch (error) {
      console.warn('[ATTENDANCE_ADMIN_REVIEW_FAILED]', { code: error?.message, sessionId: req.params.sessionId });
      return redirectToBoard(res, req.body, { error: publicErrorMessage(error) });
    }
  });

  router.post('/assignments/:assignmentId/manual', formParser, async (req, res) => {
    try {
      await registerManualAttendance(prisma, {
        assignmentId: req.params.assignmentId,
        attendanceStatus: req.body.attendanceStatus,
        reportedAt: req.body.reportedAt,
        reason: req.body.reason,
        notes: req.body.notes,
        ...actorFromRequest(req)
      });
      return redirectToBoard(res, req.body, { success: 'La asistencia manual quedó registrada con auditoría.' });
    } catch (error) {
      console.warn('[ATTENDANCE_ADMIN_MANUAL_FAILED]', { code: error?.message, assignmentId: req.params.assignmentId });
      return redirectToBoard(res, req.body, { error: publicErrorMessage(error) });
    }
  });

  router.get('/evidence/:markId', async (req, res) => {
    applyNoStore(res);
    try {
      const mark = await prisma.dispatchAttendanceMark.findUnique({
        where: { id: req.params.markId },
        select: {
          evidenceStorageKey: true,
          evidenceMimeType: true,
          attendanceSession: { select: { assignment: { select: { id: true } } } }
        }
      });
      if (!mark?.attendanceSession?.assignment?.id
        || !validAttendanceEvidenceKey(mark.evidenceStorageKey)
        || !String(mark.evidenceMimeType || '').startsWith('image/')) {
        return res.status(404).send('Evidencia no encontrada');
      }
      const url = await getSignedDownloadUrl(mark.evidenceStorageKey);
      return res.redirect(302, url);
    } catch (error) {
      console.error('[ATTENDANCE_ADMIN_EVIDENCE_FAILED]', { code: error?.message, markId: req.params.markId });
      return res.status(503).send('La evidencia no está disponible temporalmente.');
    }
  });

  return router;
}
