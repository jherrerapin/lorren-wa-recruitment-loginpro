import express from 'express';
import { updateDispatchAttendancePointConfig } from '../modules/dispatch-attendance/application/updatePointConfig.js';

const CONFIG_ERROR_MESSAGES = Object.freeze({
  attendance_operation_point_not_found: 'La operación no existe o no pertenece al cliente.',
  attendance_point_inactive: 'Activa primero la operación antes de habilitar su asistencia.',
  attendance_geofence_coordinates_required: 'Selecciona la ubicación exacta del punto en el mapa antes de habilitar la asistencia.',
  attendance_photo_policy_not_allowed: 'Selecciona una política de fotografía válida.',
  attendance_timezone_not_allowed: 'Selecciona una zona horaria válida.'
});

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
