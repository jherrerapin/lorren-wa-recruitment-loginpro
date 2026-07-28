import express from 'express';
import { updateDispatchAttendancePointConfig } from '../modules/dispatch-attendance/application/updatePointConfig.js';
import {
  getDispatchTestGeofenceBypassStatus,
  setDispatchTestGeofenceBypass
} from '../services/dispatchTestGeofenceBypass.js';

const CONFIG_ERROR_MESSAGES = Object.freeze({
  attendance_operation_point_not_found: 'La operación no existe o no pertenece al cliente.',
  attendance_point_inactive: 'Activa primero la operación antes de habilitar su asistencia.',
  attendance_geofence_coordinates_required: 'Selecciona la ubicación exacta del punto en el mapa antes de habilitar la asistencia.',
  attendance_photo_policy_not_allowed: 'Selecciona una política de fotografía válida.',
  attendance_timezone_not_allowed: 'Selecciona una zona horaria válida.'
});

const TEST_BYPASS_HEADER = 'attendance-test-bypass';

export function explicitAttendanceCheckbox(body, fieldName) {
  const fallbackName = `${fieldName}Fallback`;
  if (body?.[fallbackName] !== 'false') throw new Error(`${fieldName}_fallback_invalid`);
  const value = body?.[fieldName];
  if (value === undefined) return 'false';
  if (value !== 'true') throw new Error(`${fieldName}_invalid`);
  return 'true';
}

function clientOperationsPath(clientId, message) {
  const suffix = message ? `?message=${encodeURIComponent(message)}` : '';
  return `/admin/operaciones/clientes/${encodeURIComponent(clientId)}/operaciones${suffix}`;
}

function currentRole(req) {
  return req.session?.userRole || req.userRole || null;
}

function currentUsername(req) {
  return req.session?.username || req.username || null;
}

function isTestBypassRequest(req) {
  return currentRole(req) === 'dev' && req.get?.('x-requested-with') === TEST_BYPASS_HEADER;
}

function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

export function attendancePointConfigurationErrorMessage(error) {
  const code = typeof error?.message === 'string' ? error.message : '';
  if (CONFIG_ERROR_MESSAGES[code]) return CONFIG_ERROR_MESSAGES[code];
  if (code.endsWith('_invalid') || code.endsWith('_required') || code.endsWith('_not_allowed')) {
    return 'Revisa los valores de asistencia e intenta nuevamente.';
  }
  return 'No fue posible guardar la configuración de asistencia.';
}

export function dispatchAttendancePointConfigRouter(prisma) {
  const router = express.Router({ mergeParams: true });
  const testBypassJson = express.json({ limit: '2kb', strict: true, type: 'application/json' });

  router.get('/prueba-geocerca', async (req, res) => {
    noStore(res);
    if (!isTestBypassRequest(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    try {
      const status = await getDispatchTestGeofenceBypassStatus(prisma, {
        clientId: req.params.clientId,
        operationPointId: req.params.operationId
      });
      return res.status(200).json({ ok: true, eligible: status.eligible, enabled: status.enabled });
    } catch (error) {
      console.warn('[ATTENDANCE_TEST_GEOFENCE_STATUS]', error?.message || error);
      return res.status(404).json({ ok: false, error: 'test_operation_not_available' });
    }
  });

  router.post('/prueba-geocerca', testBypassJson, async (req, res) => {
    noStore(res);
    if (!isTestBypassRequest(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'test_geofence_bypass_value_invalid' });
    }
    try {
      const status = await setDispatchTestGeofenceBypass(prisma, {
        clientId: req.params.clientId,
        operationPointId: req.params.operationId,
        enabled: req.body.enabled,
        actorUsername: currentUsername(req),
        actorRole: currentRole(req),
        ipAddress: req.ip,
        userAgent: req.get?.('user-agent')
      });
      return res.status(200).json({ ok: true, eligible: status.eligible, enabled: status.enabled });
    } catch (error) {
      const code = typeof error?.message === 'string' ? error.message : 'test_geofence_bypass_failed';
      console.warn('[ATTENDANCE_TEST_GEOFENCE_UPDATE]', code);
      return res.status(code === 'dispatch_test_geofence_bypass_not_allowed' ? 403 : 400).json({
        ok: false,
        error: code
      });
    }
  });

  router.post('/', async (req, res) => {
    const clientId = req.params.clientId;
    const operationPointId = req.params.operationId;

    try {
      const attendanceEnabled = explicitAttendanceCheckbox(req.body, 'attendanceEnabled');
      await updateDispatchAttendancePointConfig(prisma, {
        clientId,
        operationPointId,
        attendanceEnabled,
        attendanceLatitude: req.body.attendanceLatitude,
        attendanceLongitude: req.body.attendanceLongitude,
        attendanceTimezone: req.body.attendanceTimezone,
        attendancePhotoPolicy: req.body.attendancePhotoPolicy,
        manualAttendanceAllowed: explicitAttendanceCheckbox(req.body, 'manualAttendanceAllowed')
      });
      const message = attendanceEnabled === 'true'
        ? 'Configuración de asistencia guardada.'
        : 'Configuración de asistencia guardada. La marcación quedó deshabilitada para este punto.';
      return res.redirect(clientOperationsPath(clientId, message));
    } catch (error) {
      console.warn('[ATTENDANCE_POINT_CONFIG]', error?.message || error);
      return res.redirect(clientOperationsPath(clientId, attendancePointConfigurationErrorMessage(error)));
    }
  });

  return router;
}
