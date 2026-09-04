import { createHash } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { workerPortalRouter as coreWorkerPortalRouter, applyWorkerPortalSecurityHeaders } from './workerPortalCore.js';
import { createWorkerPortalSessionHandoffRouter } from './workerPortalSessionHandoff.js';
import { resolveWorkerPortalSession } from '../modules/dispatch-attendance/application/activateWorkerPortalSession.js';
import { createPrismaWorkerPortalSessionRepository } from '../modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import { resolveAttendanceOperationGeofence } from '../modules/dispatch-attendance/application/attendanceGeofenceResolver.js';
import { ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } from '../modules/dispatch-attendance/application/registerArrival.js';
import {
  registerCrewArrivalForLeader,
  registerCrewMarkForLeader
} from '../modules/dispatch-attendance/application/registerCrewArrival.js';
import {
  issueCrewPresenceCredential,
  verifyCrewPresenceBundle,
  verifyNativeAttendanceLocationProof
} from '../modules/dispatch-attendance/application/crewPresenceCredential.js';
import {
  CREW_BLUETOOTH_OPERATION_CHARACTERISTIC_UUID,
  CREW_BLUETOOTH_SERVICE_UUID,
  loadCrewAttendancePortalContexts
} from '../modules/dispatch-attendance/application/crewAttendanceConfig.js';
import { MAX_ATTENDANCE_EVIDENCE_BYTES } from '../services/attendanceEvidenceStorage.js';
import { sendDispatchAttendanceFailureAdminAlert } from '../services/dispatchWhatsappAdminAlerts.js';
import {
  ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
  WORKER_BIOMETRIC_ACTION,
  WORKER_BIOMETRIC_ENTITY_TYPE,
  WORKER_BIOMETRIC_EVIDENCE_VERSION,
  assertWorkerBiometricAttemptAllowed,
  assessWorkerBiometric,
  enrollWorkerBiometric,
  getWorkerBiometricEnrollment,
  isWorkerBiometricVerificationUsable,
  issueWorkerBiometricChallenge
} from '../services/workerBiometricService.js';

export * from './workerPortalCore.js';

const HUMAN_CDN_ORIGIN = 'https://cdn.jsdelivr.net';
const WORKER_PORTAL_REQUEST_HEADER = 'worker-portal';
const NATIVE_ANDROID_USER_AGENT_TOKEN = 'LorrenNative/1';
const ONLINE_WEB_CAPTURE_MODE = 'ONLINE_WEB';
const OFFLINE_WEB_CAPTURE_MODE = 'OFFLINE_WEB';
const BIOMETRIC_MARK_TYPES = new Set(['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);
const CREW_MARK_CHALLENGE_PREFIX = 'lorren-mark-v1';
const CREW_PHONE_EXCEPTION_ENTITY_TYPE = 'DISPATCH_CREW_PHONE_EXCEPTION';
const CREW_PHONE_EXCEPTION_ACTION = 'CREW_PHONE_EXCEPTION_DECLARED';
const CREW_PHONE_EXCEPTION_REASON = 'NO_PHONE_AVAILABLE';
const ATTENDANCE_MARK_FAILURE_ENTITY_TYPE = 'DISPATCH_ATTENDANCE_MARK_FAILURE';
const ATTENDANCE_MARK_FAILURE_ACTION = 'MARK_ATTEMPT_FAILED';
const ATTENDANCE_MARK_FAILURE_MAX_CLIENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ATTENDANCE_MARK_FAILURE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const ATTENDANCE_MARK_FAILURE_CATALOG = Object.freeze({
  mark_request_invalid: { phaseLabel: 'Registro', descriptionEs: 'El servidor rechazó el intento porque faltaban datos obligatorios de la marcación o alguno era inválido.' },
  mark_temporarily_unavailable: { phaseLabel: 'Registro', descriptionEs: 'El servidor no pudo validar la marcación por un fallo temporal interno.' },
  assignment_not_available: { phaseLabel: 'Asignación', descriptionEs: 'La asignación ya no estaba habilitada para marcar en el momento del intento.' },
  attendance_not_enabled: { phaseLabel: 'Asignación', descriptionEs: 'La operación tenía deshabilitado el registro de asistencia cuando se intentó marcar.' },
  arrival_window_not_open: { phaseLabel: 'Horario', descriptionEs: 'El intento de entrada se hizo antes de que abriera la ventana permitida para marcar.' },
  arrival_already_registered: { phaseLabel: 'Secuencia', descriptionEs: 'La entrada ya estaba registrada cuando se intentó marcarla nuevamente.' },
  departure_arrival_required: { phaseLabel: 'Secuencia', descriptionEs: 'Se intentó registrar la salida sin una entrada previa registrada.' },
  departure_already_registered: { phaseLabel: 'Secuencia', descriptionEs: 'La salida ya estaba registrada cuando se intentó marcarla nuevamente.' },
  departure_before_arrival: { phaseLabel: 'Secuencia', descriptionEs: 'La hora recibida para la salida era anterior a la entrada registrada.' },
  departure_break_end_required: { phaseLabel: 'Secuencia', descriptionEs: 'Se intentó registrar la salida mientras el almuerzo seguía abierto.' },
  break_arrival_required: { phaseLabel: 'Secuencia', descriptionEs: 'Se intentó iniciar el almuerzo sin una entrada previa registrada.' },
  break_after_departure: { phaseLabel: 'Secuencia', descriptionEs: 'Se intentó registrar almuerzo después de que la salida ya estaba registrada.' },
  break_before_arrival: { phaseLabel: 'Secuencia', descriptionEs: 'La hora recibida para el almuerzo era anterior a la entrada registrada.' },
  break_already_started: { phaseLabel: 'Secuencia', descriptionEs: 'El inicio de almuerzo ya estaba registrado cuando se intentó marcarlo nuevamente.' },
  break_start_required: { phaseLabel: 'Secuencia', descriptionEs: 'Se intentó finalizar el almuerzo sin un inicio de almuerzo registrado.' },
  break_already_completed: { phaseLabel: 'Secuencia', descriptionEs: 'El fin de almuerzo ya estaba registrado cuando se intentó marcarlo nuevamente.' },
  break_end_before_start: { phaseLabel: 'Secuencia', descriptionEs: 'La hora recibida para finalizar el almuerzo era anterior al inicio de almuerzo.' },
  offline_capture_expired: { phaseLabel: 'Sincronización', descriptionEs: 'La marcación guardada sin conexión llegó al servidor después del plazo permitido para sincronizarla.' },
  offline_capture_time_invalid: { phaseLabel: 'Sincronización', descriptionEs: 'La hora guardada por el dispositivo para la marcación sin conexión no fue válida.' },
  operation_geofence_required: { phaseLabel: 'Ubicación', descriptionEs: 'La operación no tenía una geocerca válida configurada y el servidor no permitió completar la marcación.' },
  location_accuracy_insufficient: { phaseLabel: 'Ubicación', descriptionEs: 'El servidor rechazó el intento porque la precisión reportada por el GPS no cumplía el mínimo requerido.' },
  outside_operation_range: { phaseLabel: 'Ubicación', descriptionEs: 'El servidor calculó que la ubicación recibida estaba fuera de la geocerca permitida de la operación.' },
  attendance_native_location_required: { phaseLabel: 'Ubicación', descriptionEs: 'La aplicación no entregó una ubicación nativa firmada válida para ese intento.' },
  attendance_native_location_invalid: { phaseLabel: 'Ubicación', descriptionEs: 'El servidor recibió una prueba de ubicación nativa que no pudo validar para esa marcación.' },
  attendance_native_location_identity_invalid: { phaseLabel: 'Ubicación', descriptionEs: 'La prueba de ubicación nativa no correspondía al dispositivo autorizado del auxiliar.' },
  attendance_native_location_time_mismatch: { phaseLabel: 'Ubicación', descriptionEs: 'La prueba de ubicación nativa había perdido vigencia cuando el servidor intentó validarla.' },
  attendance_mock_location_detected: { phaseLabel: 'Ubicación', descriptionEs: 'Android informó que la ubicación del dispositivo estaba siendo simulada en ese intento.' },
  native_location_temporarily_unavailable: { phaseLabel: 'Ubicación', descriptionEs: 'El servidor no pudo validar temporalmente la prueba de ubicación segura enviada por Android.' },
  biometric_verification_required: { phaseLabel: 'Biometría', descriptionEs: 'La validación facial necesaria para esa marcación había vencido, ya se había usado o no correspondía al intento.' },
  online_biometric_required: { phaseLabel: 'Conexión', descriptionEs: 'La marcación requería validación facial en línea y no pudo continuar en esas condiciones.' },
  biometric_enrollment_required: { phaseLabel: 'Biometría', descriptionEs: 'El auxiliar no tenía un registro facial vigente para continuar con la marcación.' },
  biometric_verification_rejected: { phaseLabel: 'Biometría', descriptionEs: 'La comparación facial terminó y no confirmó la identidad requerida para completar la marcación.' },
  attendance_biometric_antispoof_low: { phaseLabel: 'Biometría', descriptionEs: 'La validación facial no confirmó suficientemente que la captura proviniera de un rostro real.' },
  attendance_biometric_liveness_low: { phaseLabel: 'Biometría', descriptionEs: 'La validación facial no confirmó suficiente presencia en vivo durante las muestras.' },
  attendance_biometric_samples_inconsistent: { phaseLabel: 'Biometría', descriptionEs: 'Las muestras faciales del intento cambiaron demasiado entre sí y no pudieron validarse.' },
  attendance_biometric_rate_limited: { phaseLabel: 'Biometría', descriptionEs: 'El sistema bloqueó temporalmente nuevos intentos faciales por varios fallos consecutivos.' },
  biometric_temporarily_unavailable: { phaseLabel: 'Biometría', descriptionEs: 'El servicio de validación facial no estuvo disponible temporalmente durante el intento.' },
  crew_group_not_available: { phaseLabel: 'Bluetooth', descriptionEs: 'La marcación grupal no pudo continuar porque la cuadrilla o el dispositivo Bluetooth no coincidían con la operación.' },
  client_location_permission_denied: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'El sistema del teléfono o navegador rechazó el permiso de ubicación antes de poder continuar con la marcación.' },
  client_location_position_unavailable: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'El teléfono informó que la ubicación no estaba disponible en ese intento y no entregó coordenadas para enviar al servidor.' },
  client_location_timeout: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'El GPS agotó 20 segundos sin entregar una ubicación para la marcación.' },
  client_location_unsupported: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'El navegador del dispositivo no ofrecía acceso a geolocalización cuando se intentó marcar.' },
  client_native_location_unavailable: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'Android no pudo obtener una ubicación válida antes de enviar la marcación al servidor.' },
  client_native_location_proof_failed: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'Android obtuvo la ubicación, pero no pudo generar la prueba segura necesaria para ese intento.' },
  client_native_location_credential_required: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'El dispositivo todavía no tenía preparada la credencial necesaria para proteger la ubicación del intento.' },
  client_native_permissions_required: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'Android indicó que faltaba autorizar el permiso de ubicación requerido para continuar.' },
  client_mock_location_detected: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'Android detectó una ubicación simulada antes de que la marcación pudiera enviarse.' },
  client_native_bridge_unavailable: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'La pantalla de marcación no pudo comunicarse con el componente nativo de Android que entrega la ubicación segura.' },
  client_native_bridge_invalid_response: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'El componente nativo de Android respondió con datos inválidos al solicitar la ubicación segura del intento.' },
  client_native_bridge_failed: { clientReportable: true, phaseLabel: 'Ubicación', descriptionEs: 'La comunicación con el componente nativo de Android falló al solicitar la ubicación segura del intento.' },
  client_camera_unavailable: { clientReportable: true, phaseLabel: 'Cámara', descriptionEs: 'La cámara frontal no pudo abrirse para iniciar la validación de identidad de la marcación.' },
  client_camera_permission_denied: { clientReportable: true, phaseLabel: 'Cámara', descriptionEs: 'El permiso de cámara estaba bloqueado o fue rechazado en el teléfono o navegador del auxiliar.' },
  client_camera_in_use: { clientReportable: true, phaseLabel: 'Cámara', descriptionEs: 'La cámara estaba siendo utilizada por otra aplicación o el teléfono no pudo entregarla al navegador.' },
  client_camera_not_found: { clientReportable: true, phaseLabel: 'Cámara', descriptionEs: 'El teléfono o navegador no encontró una cámara disponible para la marcación.' },
  client_camera_constraints_unsupported: { clientReportable: true, phaseLabel: 'Cámara', descriptionEs: 'La cámara de ese teléfono no pudo iniciar con una configuración compatible con el portal.' },
  client_camera_start_aborted: { clientReportable: true, phaseLabel: 'Cámara', descriptionEs: 'El teléfono interrumpió la apertura de la cámara antes de entregar imagen al portal.' },
  client_camera_security_blocked: { clientReportable: true, phaseLabel: 'Cámara', descriptionEs: 'La configuración de seguridad del navegador bloqueó el acceso a la cámara.' },
  client_camera_stream_unavailable: { clientReportable: true, phaseLabel: 'Cámara', descriptionEs: 'La cámara se abrió, pero no entregó una imagen utilizable para la validación del intento.' },
  client_camera_stream_muted: { clientReportable: true, phaseLabel: 'Cámara', descriptionEs: 'El teléfono pausó la cámara mientras se realizaba la validación del intento.' },
  client_biometric_page_not_visible: { clientReportable: true, phaseLabel: 'Biometría', descriptionEs: 'La validación facial se interrumpió porque la pantalla dejó de estar visible durante el intento.' },
  client_biometric_runtime_preparing: { clientReportable: true, phaseLabel: 'Biometría', descriptionEs: 'El motor de reconocimiento facial todavía no estaba listo cuando se inició la validación del intento.' },
  client_biometric_runtime_unavailable: { clientReportable: true, phaseLabel: 'Biometría', descriptionEs: 'El motor de reconocimiento facial no pudo quedar listo en el dispositivo para ese intento.' },
  client_biometric_detection_timeout: { clientReportable: true, phaseLabel: 'Biometría', descriptionEs: 'El análisis facial agotó el tiempo disponible sin detectar una condición válida para continuar.' },
  client_biometric_capture_timeout: { clientReportable: true, phaseLabel: 'Biometría', descriptionEs: 'La cámara no consiguió una captura facial estable dentro del tiempo disponible para el intento.' },
  client_biometric_baseline_timeout: { clientReportable: true, phaseLabel: 'Biometría', descriptionEs: 'No se obtuvieron las muestras frontales necesarias para iniciar la comprobación facial.' },
  client_biometric_challenge_timeout: { clientReportable: true, phaseLabel: 'Biometría', descriptionEs: 'No se confirmó el movimiento facial solicitado dentro del tiempo disponible.' },
  client_biometric_final_timeout: { clientReportable: true, phaseLabel: 'Biometría', descriptionEs: 'No se obtuvieron las muestras faciales finales después de completar el movimiento solicitado.' },
  client_biometric_challenge_not_completed: { clientReportable: true, phaseLabel: 'Biometría', descriptionEs: 'El movimiento facial solicitado no alcanzó a completarse en ese intento.' },
  client_biometric_descriptor_unavailable: { clientReportable: true, phaseLabel: 'Biometría', descriptionEs: 'El dispositivo no pudo leer los rasgos faciales necesarios para comparar la identidad.' },
  client_biometric_descriptor_inconsistent: { clientReportable: true, phaseLabel: 'Biometría', descriptionEs: 'Las capturas faciales obtenidas por el dispositivo no fueron suficientemente consistentes entre sí.' },
  client_network_request_failed: { clientReportable: true, phaseLabel: 'Conexión', descriptionEs: 'El navegador reportó un fallo de red al intentar comunicarse con el servidor durante la marcación.' },
  client_bluetooth_unsupported: { clientReportable: true, phaseLabel: 'Bluetooth', descriptionEs: 'El navegador del dispositivo no permitía usar Bluetooth para la comprobación de cuadrilla.' },
  client_bluetooth_not_selected: { clientReportable: true, phaseLabel: 'Bluetooth', descriptionEs: 'No se seleccionó un dispositivo Bluetooth de la operación durante el intento de marcación.' },
  client_bluetooth_wrong_operation: { clientReportable: true, phaseLabel: 'Bluetooth', descriptionEs: 'El dispositivo Bluetooth seleccionado pertenecía a una operación diferente a la asignada.' },
  client_bluetooth_context_unavailable: { clientReportable: true, phaseLabel: 'Bluetooth', descriptionEs: 'El Portal no pudo obtener la configuración de cuadrilla necesaria para iniciar la comprobación Bluetooth.' },
  client_bluetooth_read_failed: { clientReportable: true, phaseLabel: 'Bluetooth', descriptionEs: 'El navegador no pudo leer correctamente el dispositivo Bluetooth seleccionado durante el intento.' }
});

function markTypeFromPath(pathname = '') {
  if (pathname.endsWith('/llegada')) return 'ARRIVAL';
  if (pathname.endsWith('/salida')) return 'DEPARTURE';
  if (pathname.endsWith('/inicio-almuerzo')) return 'BREAK_START';
  if (pathname.endsWith('/fin-almuerzo')) return 'BREAK_END';
  return null;
}

function finiteNumber(value, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizedString(value, maxLength = 160) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeBiometricMarkType(value) {
  const markType = normalizedString(value, 40)?.toUpperCase();
  if (!BIOMETRIC_MARK_TYPES.has(markType)) throw new Error('attendance_biometric_mark_type_invalid');
  return markType;
}

export function attendanceMarkFailureDefinition(value) {
  const code = normalizedString(value, 100);
  return code ? ATTENDANCE_MARK_FAILURE_CATALOG[code] || null : null;
}

function markFailureAuditId(input) {
  const digest = createHash('sha256')
    .update([
      input.assignmentId,
      input.markType,
      input.attemptId,
      input.errorCode,
      input.origin
    ].join(':'))
    .digest('hex')
    .slice(0, 48);
  return `attendance_failure_${digest}`;
}

export async function auditAttendanceMarkFailure(prisma, input = {}) {
  if (!prisma?.devAuditEvent || typeof prisma.devAuditEvent.upsert !== 'function') {
    throw new Error('attendance_mark_failure_audit_unavailable');
  }
  const assignmentId = normalizedString(input.assignmentId, 160);
  const attemptId = normalizedString(input.attemptId, 160);
  const errorCode = normalizedString(input.errorCode, 100);
  const definition = attendanceMarkFailureDefinition(errorCode);
  let markType;
  try {
    markType = normalizeBiometricMarkType(input.markType);
  } catch {
    throw new Error('attendance_mark_failure_input_invalid');
  }
  const occurredAt = input.occurredAt instanceof Date ? new Date(input.occurredAt.getTime()) : new Date(input.occurredAt);
  const recordedAt = input.recordedAt instanceof Date ? new Date(input.recordedAt.getTime()) : new Date();
  const origin = input.origin === 'CLIENT_PREFLIGHT' ? 'CLIENT_PREFLIGHT' : 'SERVER_RESPONSE';
  const sourceLabel = origin === 'SERVER_RESPONSE'
    ? 'Servidor de asistencia'
    : (input.sourceLabel === 'Aplicación Android' ? 'Aplicación Android' : 'Portal del auxiliar');
  const latitude = finiteNumber(input.latitude, { min: -90, max: 90 });
  const longitude = finiteNumber(input.longitude, { min: -180, max: 180 });
  const accuracyMeters = finiteNumber(input.accuracyMeters, { min: 0, max: 100_000 });
  if (!assignmentId || !attemptId || !definition || Number.isNaN(occurredAt.getTime()) || Number.isNaN(recordedAt.getTime())) {
    throw new Error('attendance_mark_failure_input_invalid');
  }
  const id = markFailureAuditId({ assignmentId, markType, attemptId, errorCode, origin });
  return prisma.devAuditEvent.upsert({
    where: { id },
    update: {},
    create: {
      id,
      entityType: ATTENDANCE_MARK_FAILURE_ENTITY_TYPE,
      entityId: assignmentId,
      entityLabel: `assignment:${assignmentId}`,
      action: ATTENDANCE_MARK_FAILURE_ACTION,
      actorUsername: 'worker-portal',
      actorRole: 'worker',
      actorSource: origin === 'CLIENT_PREFLIGHT' ? 'worker-portal-client' : 'worker-portal-server',
      metadata: {
        assignmentId,
        attemptId,
        markType,
        failureCode: errorCode,
        phaseLabel: definition.phaseLabel,
        descriptionEs: definition.descriptionEs,
        sourceLabel,
        origin,
        occurredAt: occurredAt.toISOString(),
        ...(latitude !== null ? { latitude } : {}),
        ...(longitude !== null ? { longitude } : {}),
        ...(accuracyMeters !== null ? { accuracyMeters } : {})
      },
      createdAt: recordedAt
    }
  });
}

function attachAttendanceFailureRequestContext(req, input = {}) {
  const assignmentId = normalizedString(input.assignmentId, 160);
  const attemptId = normalizedString(input.attemptId, 160);
  const markType = normalizedString(input.markType, 40)?.toUpperCase();
  if (!assignmentId || !attemptId || !BIOMETRIC_MARK_TYPES.has(markType)) return;
  const candidate = input.occurredAt instanceof Date ? input.occurredAt : new Date(input.occurredAt);
  req.lorrenAttendanceFailureContext = {
    assignmentId,
    markType,
    attemptId,
    occurredAt: Number.isNaN(candidate.getTime()) ? null : new Date(candidate.getTime()),
    sourceLabel: input.sourceLabel === 'Aplicación Android' ? 'Aplicación Android' : 'Portal del auxiliar'
  };
}

function resolveFailureRequestContext(req, payload, now) {
  const errorCode = normalizedString(payload?.error, 100);
  const definition = attendanceMarkFailureDefinition(errorCode);
  if (!definition || definition.clientReportable === true) return null;
  if (['portal_session_required', 'biometric_request_invalid'].includes(errorCode)) return null;
  const trusted = req.lorrenAttendanceFailureContext;
  if (
    !trusted
    || !trusted.assignmentId
    || !trusted.attemptId
    || !BIOMETRIC_MARK_TYPES.has(trusted.markType)
  ) return null;
  return {
    assignmentId: trusted.assignmentId,
    markType: trusted.markType,
    errorCode,
    attemptId: trusted.attemptId,
    occurredAt: trusted.occurredAt || now,
    recordedAt: now,
    origin: 'SERVER_RESPONSE',
    sourceLabel: trusted.sourceLabel,
    latitude: finiteNumber(req.body?.latitude, { min: -90, max: 90 }),
    longitude: finiteNumber(req.body?.longitude, { min: -180, max: 180 }),
    accuracyMeters: finiteNumber(req.body?.accuracyMeters, { min: 0, max: 100_000 })
  };
}

export function createAttendanceMarkFailureResponseObserver({ auditFn, nowFn = () => new Date() } = {}) {
  if (typeof auditFn !== 'function') throw new Error('attendance_mark_failure_observer_audit_required');
  return function attendanceMarkFailureResponseObserver(req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      try {
        if (Number(res.statusCode || 0) >= 400) {
          const now = nowFn();
          if (now instanceof Date && !Number.isNaN(now.getTime())) {
            const context = resolveFailureRequestContext(req, payload, now);
            if (context) {
              Promise.resolve(auditFn(context)).catch((error) => {
                console.warn('[ATTENDANCE_MARK_FAILURE_AUDIT_WRITE_FAILED]', {
                  code: typeof error?.message === 'string' ? error.message : 'unknown'
                });
              });
            }
          }
        }
      } catch (error) {
        console.warn('[ATTENDANCE_MARK_FAILURE_OBSERVER_FAILED]', {
          code: typeof error?.message === 'string' ? error.message : 'unknown'
        });
      }
      return originalJson(payload);
    };
    return next();
  };
}

function resolveCrewPresenceMarkType(proofBundle) {
  const explicitMarkType = normalizedString(proofBundle?.markType, 40)?.toUpperCase();
  if (!explicitMarkType) return { markType: 'ARRIVAL', legacyArrival: true };
  if (!BIOMETRIC_MARK_TYPES.has(explicitMarkType)) throw new Error('crew_presence_mark_type_invalid');
  return { markType: explicitMarkType, legacyArrival: false };
}

function assertCrewMarkChallenge(proofBundle, markType, options = {}) {
  const challenge = normalizedString(proofBundle?.challenge, 2048);
  if (!challenge) throw new Error('crew_presence_mark_challenge_invalid');
  const legacyArrival = options.legacyArrival === true && markType === 'ARRIVAL';
  if (!legacyArrival && !challenge.startsWith(`${CREW_MARK_CHALLENGE_PREFIX}:${markType}:`)) {
    throw new Error('crew_presence_mark_challenge_invalid');
  }
  if (
    markType !== 'ARRIVAL'
    && Array.isArray(proofBundle?.phoneExceptions)
    && proofBundle.phoneExceptions.length > 0
  ) {
    throw new Error('crew_presence_phone_exception_mark_invalid');
  }
}

function crewMarkLabel(markType) {
  if (markType === 'BREAK_START') return 'Inicio de almuerzo';
  if (markType === 'BREAK_END') return 'Fin de almuerzo';
  if (markType === 'DEPARTURE') return 'Salida';
  return 'Entrada';
}

function isNativeAndroidRequest(req) {
  const userAgent = req.get?.('user-agent');
  return typeof userAgent === 'string' && userAgent.includes(NATIVE_ANDROID_USER_AGENT_TOKEN);
}

function parseNativeAttendanceLocationProof(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) {
    throw new Error('attendance_native_location_required');
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed;
  } catch {
    throw new Error('attendance_native_location_invalid');
  }
}

function nativeAttendanceLocationPublicError(error) {
  const code = typeof error?.message === 'string' ? error.message : 'attendance_native_location_invalid';
  if (code === 'crew_presence_secret_required') {
    return [503, 'native_location_temporarily_unavailable', 'No fue posible validar la ubicación nativa en este momento.'];
  }
  if (code === 'attendance_mock_location_detected') {
    return [409, code, 'Android detectó una ubicación simulada. Desactiva la ubicación de prueba antes de marcar.'];
  }
  if (code === 'attendance_native_location_time_mismatch') {
    return [409, code, 'La ubicación nativa venció. Actualiza la ubicación e intenta nuevamente.'];
  }
  if (code === 'attendance_native_location_required') {
    return [400, code, 'La app necesita una ubicación nativa válida para esta marcación.'];
  }
  return [409, /^[A-Za-z0-9_]{1,100}$/.test(code) ? code : 'attendance_native_location_invalid', 'No fue posible validar la ubicación firmada de este teléfono.'];
}

function crewPhoneExceptionAuditId(idempotencyKey, assignmentId) {
  const digest = createHash('sha256')
    .update(`${idempotencyKey}:${assignmentId}`)
    .digest('hex')
    .slice(0, 48);
  return `crew_phone_${digest}`;
}

async function auditCrewPhoneException(prisma, input = {}) {
  if (!prisma?.devAuditEvent || typeof prisma.devAuditEvent.upsert !== 'function') {
    throw new Error('crew_phone_exception_audit_contract_invalid');
  }
  const id = crewPhoneExceptionAuditId(input.idempotencyKey, input.assignmentId);
  try {
    return await prisma.devAuditEvent.upsert({
      where: { id },
      update: {},
      create: {
        id,
        entityType: CREW_PHONE_EXCEPTION_ENTITY_TYPE,
        entityId: input.assignmentId,
        entityLabel: `assignment:${input.assignmentId}`,
        action: CREW_PHONE_EXCEPTION_ACTION,
        actorUsername: `worker-portal:${input.leaderWorkerId}`,
        actorRole: 'crew-leader',
        actorSource: 'worker-portal',
        ipAddress: input.ipAddress || null,
        userAgent: input.userAgent || null,
        metadata: {
          serviceRequestId: input.serviceRequestId,
          assignmentId: input.assignmentId,
          workerId: input.workerId,
          leaderWorkerId: input.leaderWorkerId,
          attemptId: input.idempotencyKey,
          reason: CREW_PHONE_EXCEPTION_REASON,
          declaredAt: input.clientCapturedAt.toISOString(),
          reviewRequired: true
        }
      }
    });
  } catch (error) {
    if (error?.message === 'crew_phone_exception_audit_contract_invalid') throw error;
    throw new Error('crew_phone_exception_audit_failed');
  }
}

function strictError(res, status, error, message) {
  applyWorkerPortalSecurityHeaders(res);
  return res.status(status).json({ ok: false, error, message });
}

async function requireStrictAttendanceLocation(prisma, res, point, input = {}, options = {}) {
  const latitude = finiteNumber(input.latitude, { min: -90, max: 90 });
  const longitude = finiteNumber(input.longitude, { min: -180, max: 180 });
  const accuracyMeters = finiteNumber(input.accuracyMeters, { min: 0, max: 100_000 });
  if (latitude === null || longitude === null || accuracyMeters === null) {
    strictError(res, 400, 'mark_request_invalid', 'No fue posible validar la ubicación.');
    return null;
  }

  const resolved = await resolveAttendanceOperationGeofence(
    prisma,
    point,
    { latitude, longitude, accuracyMeters },
    options
  );
  if (resolved.accepted !== true) {
    const publicError = {
      attendance_operation_geofence_required: [
        409,
        'operation_geofence_required',
        'La operación no tiene una geocerca válida configurada.'
      ],
      attendance_location_accuracy_insufficient: [
        409,
        'location_accuracy_insufficient',
        'La precisión del GPS no es suficiente. Intenta nuevamente al aire libre.'
      ],
      attendance_outside_operation_range: [
        409,
        'outside_operation_range',
        'Debes estar dentro del rango de una operación registrada para marcar asistencia.'
      ],
      attendance_location_required: [
        400,
        'mark_request_invalid',
        'No fue posible validar la ubicación.'
      ]
    }[resolved.errorCode] || [409, 'outside_operation_range', 'No fue posible validar una operación registrada para esta marcación.'];
    strictError(res, publicError[0], publicError[1], publicError[2]);
    return null;
  }

  return {
    latitude,
    longitude,
    accuracyMeters,
    distanceMeters: resolved.distanceMeters,
    operationPointId: resolved.operationPointId,
    crossOperation: resolved.crossOperation === true
  };
}

function setBiometricRetryAfter(res, error) {
  const seconds = Number(error?.retryAfterSeconds || 0);
  if (Number.isFinite(seconds) && seconds > 0) res.set('Retry-After', String(Math.ceil(seconds)));
}

function hasCurrentBiometricEnrollment(enrollment) {
  return Boolean(
    enrollment?.enrolled
    && enrollment?.descriptor
    && Number(enrollment.evidenceVersion) === WORKER_BIOMETRIC_EVIDENCE_VERSION
  );
}

function verifiedBiometricMetadata(metadata, expected, now) {
  return isWorkerBiometricVerificationUsable(metadata, expected, now);
}

function expandBiometricCsp(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace('script-src ', `script-src ${HUMAN_CDN_ORIGIN} `)
    .replace("connect-src 'self'", `connect-src 'self' ${HUMAN_CDN_ORIGIN}`);
}

function installBiometricCspBridge(_req, res, next) {
  const originalSet = res.set.bind(res);
  res.set = (field, value) => {
    if (typeof field === 'string' && field.toLowerCase() === 'content-security-policy') {
      return originalSet(field, expandBiometricCsp(value));
    }
    if (field && typeof field === 'object' && !Array.isArray(field)) {
      const headers = { ...field };
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-security-policy') headers[key] = expandBiometricCsp(headers[key]);
      }
      return originalSet(headers);
    }
    return originalSet(field, value);
  };
  return next();
}

function usesInjectedAttendanceCore(options = {}) {
  return [options.registerArrivalFn, options.registerDepartureFn, options.registerBreakFn]
    .some((candidate) => typeof candidate === 'function');
}

function biometricPublicError(error) {
  const code = typeof error?.message === 'string' ? error.message : 'worker_biometric_error';
  if (code === 'attendance_biometric_rate_limited') return [429, code];
  if (code === 'attendance_biometric_consent_required') return [400, code];
  if (
    code === 'attendance_biometric_antispoof_low'
    || code === 'attendance_biometric_liveness_low'
    || code === 'attendance_biometric_samples_inconsistent'
  ) return [422, code];
  if (code === 'attendance_biometric_secret_required') return [503, 'biometric_temporarily_unavailable'];
  return [400, /^[A-Za-z0-9_]{1,100}$/.test(code) ? code : 'worker_biometric_error'];
}

function crewPresencePublicError(error) {
  const code = typeof error?.message === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(error.message)
    ? error.message
    : 'crew_presence_error';
  if (
    code === 'crew_presence_secret_required'
    || code === 'crew_phone_exception_audit_failed'
    || code.endsWith('_contract_invalid')
  ) return [503, 'crew_presence_temporarily_unavailable'];
  if (code === 'attendance_offline_capture_expired') return [409, 'offline_capture_expired'];
  if (code === 'attendance_offline_capture_future_invalid') return [409, 'offline_capture_future_invalid'];
  if (
    code === 'crew_presence_leader_not_available'
    || code === 'crew_presence_leader_not_assigned'
    || code === 'crew_presence_leader_device_inactive'
    || code === 'crew_presence_service_request_mismatch'
    || code === 'crew_presence_attempt_mismatch'
    || code === 'crew_presence_native_location_required'
    || code === 'crew_presence_native_location_time_mismatch'
    || code === 'crew_presence_mock_location_detected'
    || code === 'crew_group_arrival_leader_presence_required'
    || code === 'crew_group_arrival_manual_target_conflict'
    || code === 'crew_group_arrival_manual_target_invalid'
    || code === 'crew_group_arrival_manual_target_not_assigned'
    || code === 'crew_group_arrival_manual_leader_arrival_required'
    || code === 'crew_group_mark_leader_presence_required'
    || code === 'crew_group_mark_leader_not_assigned'
  ) return [409, code];
  return [400, code];
}

export function workerPortalRouter(prisma, options = {}) {
  const repositoryFactory = options.repositoryFactory || (() => createPrismaWorkerPortalSessionRepository(prisma));
  const resolveSessionFn = options.resolveSessionFn || resolveWorkerPortalSession;
  const nowFn = options.nowFn || (() => new Date());
  const injectedCore = usesInjectedAttendanceCore(options);
  const getEnrollmentFn = options.getEnrollmentFn
    || ((workerId) => getWorkerBiometricEnrollment(prisma, workerId, { env: options.env || process.env }));
  const enrollBiometricFn = options.enrollBiometricFn
    || ((input, enrollmentOptions) => enrollWorkerBiometric(prisma, input, enrollmentOptions));
  const assessBiometricFn = options.assessBiometricFn
    || ((input, assessmentOptions) => assessWorkerBiometric(prisma, input, assessmentOptions));
  const issueChallengeFn = options.issueChallengeFn || issueWorkerBiometricChallenge;
  const assertAttemptAllowedFn = options.assertAttemptAllowedFn
    || ((input, attemptOptions) => assertWorkerBiometricAttemptAllowed(prisma, input, attemptOptions));
  const loadCrewPortalContextsFn = options.loadCrewPortalContextsFn
    || ((input) => loadCrewAttendancePortalContexts(prisma, input));
  const issueCrewPresenceCredentialFn = options.issueCrewPresenceCredentialFn || issueCrewPresenceCredential;
  const verifyCrewPresenceBundleFn = options.verifyCrewPresenceBundleFn
    || ((input, verifyOptions) => verifyCrewPresenceBundle(prisma, input, verifyOptions));
  const verifyNativeAttendanceLocationProofFn = options.verifyNativeAttendanceLocationProofFn
    || ((input, verifyOptions) => verifyNativeAttendanceLocationProof(input, verifyOptions));
  const registerCrewPresenceArrivalFn = options.registerCrewPresenceArrivalFn
    || ((input) => registerCrewArrivalForLeader(prisma, input));
  const registerCrewPresenceMarkFn = options.registerCrewPresenceMarkFn
    || ((input) => registerCrewMarkForLeader(prisma, input));
  const auditCrewPhoneExceptionFn = options.auditCrewPhoneExceptionFn
    || ((input) => auditCrewPhoneException(prisma, input));
  const auditMarkFailureFn = options.auditMarkFailureFn
    || ((input) => auditAttendanceMarkFailure(prisma, input));
  const sendMarkFailureAdminAlertFn = options.sendMarkFailureAdminAlertFn
    || ((input) => sendDispatchAttendanceFailureAdminAlert({
      scope: 'operational',
      prismaClient: prisma,
      ...input
    }));
  const auditAndAlertMarkFailureFn = async (input) => {
    const failureEvent = await auditMarkFailureFn(input);
    await sendMarkFailureAdminAlertFn({
      failureEvent,
      failureContext: input
    }).catch((error) => {
      console.warn('[ATTENDANCE_MARK_FAILURE_ALERT_FAILED]', {
        code: typeof error?.message === 'string' ? error.message : 'unknown'
      });
    });
    return failureEvent;
  };
  const loadBiometricAssignmentFn = options.loadBiometricAssignmentFn || (async (workerId, assignmentId) => (
    prisma.dispatchAssignment.findFirst({
      where: {
        id: assignmentId,
        workerId,
        status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] }
      },
      include: { serviceRequest: { include: { operationPoint: true } } }
    })
  ));
  let repository = options.repository || null;

  const markUpload = options.strictMarkUpload || options.markUpload || options.arrivalUpload || multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTENDANCE_EVIDENCE_BYTES, files: 1, fields: 12, fieldSize: 16 * 1024 }
  }).single('selfie');
  const biometricJson = express.json({ limit: '512kb', strict: true, type: 'application/json' });

  function getRepository() {
    if (!repository) repository = repositoryFactory();
    if (!repository) throw new Error('worker_portal_repository_unavailable');
    return repository;
  }

  async function resolvePortalSession(req, now) {
    const rawSessionToken = req.cookies?.[WORKER_PORTAL_SESSION_COOKIE_NAME];
    if (!rawSessionToken) return null;
    return resolveSessionFn({ repository: getRepository(), rawSessionToken, now });
  }

  function requirePortalRequest(req, res) {
    applyWorkerPortalSecurityHeaders(res);
    if (req.get?.('x-requested-with') !== WORKER_PORTAL_REQUEST_HEADER) {
      strictError(res, 400, 'biometric_request_invalid', 'Solicitud biométrica inválida.');
      return false;
    }
    return true;
  }

  function requireNativeAttendanceLocation(req, res, portalSession, expected, now) {
    try {
      const proof = parseNativeAttendanceLocationProof(req.body?.nativeLocationProof);
      let verificationAt = now;
      if (expected.captureMode === OFFLINE_WEB_CAPTURE_MODE) {
        const proofCapturedAt = new Date(Number(proof?.capturedAt));
        if (!Number.isNaN(proofCapturedAt.getTime())) verificationAt = proofCapturedAt;
      }
      return verifyNativeAttendanceLocationProofFn({
        workerId: portalSession.workerId,
        deviceId: portalSession.deviceId,
        assignmentId: expected.assignmentId,
        markType: expected.markType,
        idempotencyKey: expected.idempotencyKey,
        proof,
        now: verificationAt
      }, {
        env: options.env || process.env,
        secret: options.crewPresenceSecret
      });
    } catch (error) {
      const [status, code, message] = nativeAttendanceLocationPublicError(error);
      strictError(res, status, code, message);
      return null;
    }
  }

  function applyVerifiedNativeLocationToBody(req, verified) {
    req.body.latitude = String(verified.latitude);
    req.body.longitude = String(verified.longitude);
    req.body.accuracyMeters = String(verified.accuracyMeters);
    req.body.clientCapturedAt = verified.clientCapturedAt;
  }

  async function requireBiometricAssignment(req, res, portalSession, now) {
    const assignmentId = normalizedString(req.body?.assignmentId, 120);
    const idempotencyKey = normalizedString(req.body?.idempotencyKey, 120);
    let markType;
    try {
      markType = normalizeBiometricMarkType(req.body?.markType);
    } catch {
      strictError(res, 400, 'biometric_request_invalid', 'Solicitud biométrica inválida.');
      return null;
    }
    if (!assignmentId || !idempotencyKey) {
      strictError(res, 400, 'biometric_request_invalid', 'Solicitud biométrica inválida.');
      return null;
    }
    const assignment = await loadBiometricAssignmentFn(portalSession.workerId, assignmentId, now);
    if (!assignment || assignment.serviceRequest?.operationPoint?.attendanceEnabled !== true) {
      strictError(res, 404, 'assignment_not_available', 'La operación no está disponible para validar el rostro.');
      return null;
    }
    attachAttendanceFailureRequestContext(req, {
      assignmentId: assignment.id,
      markType,
      attemptId: idempotencyKey,
      occurredAt: req.body?.clientCapturedAt || now,
      sourceLabel: isNativeAndroidRequest(req) ? 'Aplicación Android' : 'Portal del auxiliar'
    });
    return { assignment, assignmentId: assignment.id, idempotencyKey, markType };
  }

  async function markLatestEnrollmentAsWorkerPortal(workerId) {
    const event = await prisma.devAuditEvent.findFirst({
      where: {
        entityType: WORKER_BIOMETRIC_ENTITY_TYPE,
        entityId: workerId,
        action: WORKER_BIOMETRIC_ACTION.ENROLLED
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    });
    if (!event) return;
    await prisma.devAuditEvent.update({
      where: { id: event.id },
      data: { actorSource: 'worker-portal', actorRole: 'worker' }
    });
  }

  function consumeVerifiedAssessmentAfterSuccess(res, event, now) {
    if (!event?.id || !event?.metadata || typeof prisma.devAuditEvent?.update !== 'function') return;
    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      prisma.devAuditEvent.update({
        where: { id: event.id },
        data: {
          metadata: {
            ...event.metadata,
            consumedAt: new Date(Math.max(Date.now(), now.getTime())).toISOString()
          }
        }
      }).catch((error) => {
        console.error('[WORKER_PORTAL_BIOMETRIC_CONSUME_FAILED]', {
          code: typeof error?.message === 'string' ? error.message : 'unknown'
        });
      });
    });
  }

  async function strictMarkGuard(req, res, next) {
    try {
      applyWorkerPortalSecurityHeaders(res);
      if (req.get?.('x-requested-with') !== WORKER_PORTAL_REQUEST_HEADER) {
        return strictError(res, 400, 'mark_request_invalid', 'Solicitud de marcación inválida.');
      }

      const now = nowFn();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('worker_portal_strict_now_invalid');
      }

      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');

      const markType = markTypeFromPath(req.path);
      const idempotencyKey = normalizedString(req.body?.idempotencyKey, 120);
      const captureMode = normalizedString(req.body?.captureMode, 40)?.toUpperCase();
      if (
        !markType
        || !idempotencyKey
        || ![ONLINE_WEB_CAPTURE_MODE, OFFLINE_WEB_CAPTURE_MODE].includes(captureMode)
      ) {
        return strictError(res, 400, 'mark_request_invalid', 'No fue posible validar la ubicación o el modo de captura.');
      }

      const assignment = await prisma.dispatchAssignment.findFirst({
        where: {
          id: req.params.assignmentId,
          workerId: portalSession.workerId,
          status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] }
        },
        include: { serviceRequest: { include: { operationPoint: true } } }
      });
      if (!assignment || assignment.serviceRequest?.operationPoint?.attendanceEnabled !== true) {
        return strictError(res, 409, 'assignment_not_available', 'La operación no está disponible para marcar asistencia.');
      }
      attachAttendanceFailureRequestContext(req, {
        assignmentId: assignment.id,
        markType,
        attemptId: idempotencyKey,
        occurredAt: req.body?.clientCapturedAt || now,
        sourceLabel: isNativeAndroidRequest(req) ? 'Aplicación Android' : 'Portal del auxiliar'
      });

      const requestedCrewGroup = markType === 'ARRIVAL'
        && captureMode === ONLINE_WEB_CAPTURE_MODE
        && req.get?.('x-lorren-crew-group') === 'true';
      let locationInput = req.body;
      if (!requestedCrewGroup && isNativeAndroidRequest(req)) {
        locationInput = requireNativeAttendanceLocation(req, res, portalSession, {
          assignmentId: assignment.id,
          markType,
          idempotencyKey,
          captureMode
        }, now);
        if (!locationInput) return;
        applyVerifiedNativeLocationToBody(req, locationInput);
      }
      const location = await requireStrictAttendanceLocation(
        prisma,
        res,
        assignment.serviceRequest.operationPoint,
        locationInput,
        { allowCrossOperation: !requestedCrewGroup }
      );
      if (!location) return;

      if (requestedCrewGroup) {
        const contexts = await loadCrewPortalContextsFn({ workerId: portalSession.workerId });
        const crewContext = (Array.isArray(contexts) ? contexts : [])
          .find((context) => context?.assignmentId === assignment.id);
        const observedOperationPointId = normalizedString(req.get?.('x-lorren-crew-operation-point-id'), 160);
        const assignmentOperationPointId = normalizedString(assignment.serviceRequest?.operationPoint?.id, 160);
        if (
          !crewContext
          || crewContext.mode !== 'CREW'
          || crewContext.isCrewLeader !== true
          || crewContext.crewAvailable !== true
          || !crewContext.operationPointId
          || crewContext.operationPointId !== assignmentOperationPointId
          || observedOperationPointId !== crewContext.operationPointId
        ) {
          return strictError(
            res,
            409,
            'crew_group_not_available',
            'La llegada grupal no está disponible para esta asignación o el dispositivo Bluetooth no corresponde a la operación.'
          );
        }
        req.lorrenCrewGroup = true;
        req.lorrenCrewForceMajeure = req.get?.('x-lorren-crew-force-majeure') === 'true';
      }

      if (BIOMETRIC_MARK_TYPES.has(markType) && captureMode === ONLINE_WEB_CAPTURE_MODE && !requestedCrewGroup) {
        const event = await prisma.devAuditEvent.findFirst({
          where: {
            entityType: ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
            entityId: idempotencyKey,
            action: WORKER_BIOMETRIC_ACTION.ASSESSED
          },
          orderBy: { createdAt: 'desc' }
        });
        if (!verifiedBiometricMetadata(event?.metadata, {
          workerId: portalSession.workerId,
          assignmentId: assignment.id,
          markType,
          idempotencyKey
        }, now)) {
          return strictError(res, 409, 'biometric_verification_required', 'La validación facial venció, ya fue utilizada o no corresponde a esta marcación.');
        }
        consumeVerifiedAssessmentAfterSuccess(res, event, now);
      }

      if (BIOMETRIC_MARK_TYPES.has(markType) && captureMode === OFFLINE_WEB_CAPTURE_MODE) {
        const clientCapturedAt = new Date(req.body?.clientCapturedAt);
        if (Number.isNaN(clientCapturedAt.getTime())) {
          return strictError(res, 400, 'mark_request_invalid', 'La hora de la marcación sin conexión no es válida.');
        }
      }

      req.lorrenStrictAttendance = {
        workerId: portalSession.workerId,
        markType,
        captureMode,
        operationPointId: location.operationPointId,
        crossOperation: location.crossOperation,
        distanceMeters: location.distanceMeters,
        insideGeofence: true,
        requiresReview: captureMode === OFFLINE_WEB_CAPTURE_MODE
      };
      return next();
    } catch (error) {
      console.error('[WORKER_PORTAL_STRICT_MARK_GUARD_FAILED]', {
        code: typeof error?.message === 'string' ? error.message : 'unknown'
      });
      return strictError(res, 503, 'mark_temporarily_unavailable', 'No fue posible validar la marcación en este momento.');
    }
  }

  function strictMarkMiddleware(req, res, next) {
    return markUpload(req, res, (error) => {
      if (error) return next(error);
      return strictMarkGuard(req, res, next);
    });
  }

  const coreRouter = coreWorkerPortalRouter(prisma, injectedCore ? {
    ...options,
    repository: getRepository()
  } : {
    ...options,
    repository: getRepository(),
    markUpload: strictMarkMiddleware,
    arrivalUpload: undefined
  });

  const router = express.Router();
  router.use(installBiometricCspBridge);
  router.use(createAttendanceMarkFailureResponseObserver({ auditFn: auditAndAlertMarkFailureFn, nowFn }));
  router.use(coreRouter);

  router.post('/asignaciones/:assignmentId/intentos-fallidos', biometricJson, async (req, res) => {
    applyWorkerPortalSecurityHeaders(res);
    if (req.get?.('x-requested-with') !== WORKER_PORTAL_REQUEST_HEADER) {
      return strictError(res, 400, 'mark_failure_report_invalid', 'Solicitud de reporte técnico inválida.');
    }
    try {
      const now = nowFn();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('attendance_mark_failure_now_invalid');
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');

      const assignmentId = normalizedString(req.params.assignmentId, 160);
      const errorCode = normalizedString(req.body?.errorCode, 100);
      const clientAttemptId = normalizedString(req.body?.clientAttemptId, 160);
      const definition = attendanceMarkFailureDefinition(errorCode);
      let markType;
      try {
        markType = normalizeBiometricMarkType(req.body?.markType);
      } catch {
        return strictError(res, 400, 'mark_failure_report_invalid', 'El reporte técnico de la marcación no es válido.');
      }
      if (
        !assignmentId
        || !clientAttemptId
        || !/^[A-Za-z0-9:_-]{8,160}$/.test(clientAttemptId)
        || !definition?.clientReportable
      ) {
        return strictError(res, 400, 'mark_failure_report_invalid', 'El reporte técnico de la marcación no es válido.');
      }

      const occurredAt = new Date(req.body?.occurredAt);
      if (
        Number.isNaN(occurredAt.getTime())
        || occurredAt.getTime() > now.getTime() + ATTENDANCE_MARK_FAILURE_FUTURE_TOLERANCE_MS
        || occurredAt.getTime() < now.getTime() - ATTENDANCE_MARK_FAILURE_MAX_CLIENT_AGE_MS
      ) {
        return strictError(res, 400, 'mark_failure_report_invalid', 'La hora del reporte técnico no es válida.');
      }

      const assignment = await prisma.dispatchAssignment.findFirst({
        where: { id: assignmentId, workerId: portalSession.workerId },
        select: { id: true }
      });
      if (!assignment) return strictError(res, 404, 'assignment_not_available', 'La asignación no corresponde a este auxiliar.');

      await auditAndAlertMarkFailureFn({
        assignmentId,
        markType,
        errorCode,
        attemptId: clientAttemptId,
        occurredAt,
        recordedAt: now,
        origin: 'CLIENT_PREFLIGHT',
        sourceLabel: isNativeAndroidRequest(req) ? 'Aplicación Android' : 'Portal del auxiliar'
      });
      return res.status(202).json({ ok: true });
    } catch (error) {
      console.warn('[ATTENDANCE_MARK_FAILURE_CLIENT_REPORT_FAILED]', {
        code: typeof error?.message === 'string' ? error.message : 'unknown'
      });
      return strictError(res, 503, 'mark_failure_report_unavailable', 'No fue posible guardar el reporte técnico en este momento.');
    }
  });

  router.post('/cuadrillas/proximidad/contexto', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const assignments = await loadCrewPortalContextsFn({ workerId: portalSession.workerId });
      return res.status(200).json({
        ok: true,
        protocol: {
          serviceUuid: CREW_BLUETOOTH_SERVICE_UUID,
          operationCharacteristicUuid: CREW_BLUETOOTH_OPERATION_CHARACTERISTIC_UUID
        },
        assignments
      });
    } catch (error) {
      console.error('[WORKER_PORTAL_CREW_PROXIMITY_CONTEXT_FAILED]', {
        code: typeof error?.message === 'string' ? error.message : 'unknown'
      });
      return strictError(
        res,
        503,
        'crew_proximity_temporarily_unavailable',
        'No fue posible preparar la validación Bluetooth de la cuadrilla.'
      );
    }
  });

  router.post('/cuadrillas/presencia/credencial', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const publicKey = normalizedString(req.body?.publicKey, 4096);
      if (!publicKey) return strictError(res, 400, 'crew_presence_public_key_required', 'No fue posible preparar este teléfono para asistencia.');
      const issued = issueCrewPresenceCredentialFn({
        workerId: portalSession.workerId,
        deviceId: portalSession.deviceId,
        publicKey,
        now
      }, {
        env: options.env || process.env,
        secret: options.crewPresenceSecret,
        ttlMs: options.crewPresenceCredentialTtlMs
      });
      return res.status(201).json({
        ok: true,
        credential: issued.credential,
        expiresAt: issued.expiresAt,
        keyHash: issued.keyHash
      });
    } catch (error) {
      const [status, code] = crewPresencePublicError(error);
      if (status >= 500) console.error('[WORKER_PORTAL_CREW_PRESENCE_CREDENTIAL_FAILED]', { code });
      return strictError(res, status, code, 'No fue posible preparar este teléfono para asistencia.');
    }
  });

  router.post('/cuadrillas/presencia/entrada-manual', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      if (!isNativeAndroidRequest(req)) {
        return strictError(res, 409, 'native_attendance_required', 'Esta marcación requiere la app de Lórren.');
      }

      const assignmentId = normalizedString(req.body?.assignmentId, 160);
      const serviceRequestId = normalizedString(req.body?.serviceRequestId, 160);
      const targetAssignmentId = normalizedString(req.body?.targetAssignmentId, 160);
      const idempotencyKey = normalizedString(req.body?.idempotencyKey, 100);
      if (
        !assignmentId
        || !serviceRequestId
        || !targetAssignmentId
        || !idempotencyKey
        || targetAssignmentId === assignmentId
      ) {
        return strictError(res, 400, 'crew_manual_arrival_invalid', 'La entrada pendiente no es válida.');
      }

      const assignment = await loadBiometricAssignmentFn(portalSession.workerId, assignmentId, now);
      if (
        !assignment
        || assignment.serviceRequest?.id !== serviceRequestId
        || assignment.serviceRequest?.operationPoint?.attendanceEnabled !== true
      ) {
        return strictError(res, 409, 'assignment_not_available', 'La cuadrilla ya no está disponible para esta marcación.');
      }

      const nativeLocation = requireNativeAttendanceLocation(req, res, portalSession, {
        assignmentId,
        markType: 'ARRIVAL',
        idempotencyKey,
        captureMode: ONLINE_WEB_CAPTURE_MODE
      }, now);
      if (!nativeLocation) return;
      const location = await requireStrictAttendanceLocation(
        prisma,
        res,
        assignment.serviceRequest.operationPoint,
        nativeLocation,
        { allowCrossOperation: false }
      );
      if (!location) return;

      const result = await registerCrewPresenceArrivalFn({
        leaderWorkerId: portalSession.workerId,
        assignmentId,
        manualTargetAssignmentId: targetAssignmentId,
        idempotencyKey,
        now,
        captureMode: ONLINE_WEB_CAPTURE_MODE,
        clientCapturedAt: nativeLocation.clientCapturedAt,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracyMeters,
        installationIdHash: null,
        persistentStorageAvailable: true,
        presenceValidated: false,
        forceMajeure: false,
        ipAddress: normalizedString(req.ip, 120),
        userAgent: normalizedString(req.get?.('user-agent'), 500)
      });
      if (!result?.applied || !result.summary) {
        return strictError(res, 409, 'crew_manual_arrival_not_available', 'La entrada pendiente ya no está disponible.');
      }
      const targetResult = (result.summary.results || [])
        .find((item) => item.assignmentId === targetAssignmentId && item.isLeader === false);
      if (!targetResult || !['RECORDED', 'REPLAYED', 'ALREADY_RECORDED'].includes(targetResult.status)) {
        return strictError(res, 409, 'crew_manual_arrival_not_recorded', 'No fue posible registrar la entrada pendiente.');
      }

      return res.status(200).json({
        ok: true,
        markType: 'ARRIVAL',
        serviceRequestId,
        targetAssignmentId,
        status: targetResult.status,
        requiresReview: targetResult.pendingReview === true
      });
    } catch (error) {
      const [status, code] = crewPresencePublicError(error);
      if (status >= 500) console.error('[WORKER_PORTAL_CREW_MANUAL_ARRIVAL_FAILED]', { code });
      return strictError(res, status, code, 'No fue posible registrar la entrada pendiente.');
    }
  });

  router.post('/cuadrillas/presencia/sincronizar', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');

      const assignmentId = normalizedString(req.body?.assignmentId, 160);
      const serviceRequestId = normalizedString(req.body?.serviceRequestId, 160);
      const idempotencyKey = normalizedString(req.body?.idempotencyKey, 100);
      const clientCapturedAt = new Date(req.body?.clientCapturedAt);
      const proofBundle = req.body?.proofBundle;
      const { markType, legacyArrival } = resolveCrewPresenceMarkType(proofBundle);
      assertCrewMarkChallenge(proofBundle, markType, { legacyArrival });
      if (!assignmentId || !serviceRequestId || !idempotencyKey || Number.isNaN(clientCapturedAt.getTime())) {
        return strictError(res, 400, 'crew_presence_sync_invalid', 'La comprobación de cuadrilla no es válida.');
      }

      const assignment = await loadBiometricAssignmentFn(portalSession.workerId, assignmentId, now);
      if (
        !assignment
        || assignment.serviceRequest?.id !== serviceRequestId
        || assignment.serviceRequest?.operationPoint?.attendanceEnabled !== true
      ) {
        return strictError(res, 409, 'assignment_not_available', 'La cuadrilla ya no está disponible para esta marcación.');
      }

      const verified = await verifyCrewPresenceBundleFn({
        leaderWorkerId: portalSession.workerId,
        leaderDeviceId: portalSession.deviceId,
        assignmentId,
        serviceRequestId,
        idempotencyKey,
        clientCapturedAt,
        proofBundle,
        now
      }, {
        env: options.env || process.env,
        secret: options.crewPresenceSecret,
        loadCrewContextsFn: (_prisma, input) => loadCrewPortalContextsFn(input)
      });
      const location = await requireStrictAttendanceLocation(
        prisma,
        res,
        assignment.serviceRequest.operationPoint,
        verified.leaderLocation,
        { allowCrossOperation: false }
      );
      if (!location) return;

      const verifiedMembers = Array.isArray(verified.members) ? verified.members : [];
      const memberByWorkerId = new Map(verifiedMembers.map((member) => [member.workerId, member]));
      if (markType === 'ARRIVAL') {
        await Promise.all((verified.phoneExceptionWorkerIds || []).map(async (workerId) => {
          const member = memberByWorkerId.get(workerId);
          if (!member) throw new Error('crew_phone_exception_member_contract_invalid');
          await auditCrewPhoneExceptionFn({
            leaderWorkerId: portalSession.workerId,
            serviceRequestId,
            assignmentId: member.assignmentId,
            workerId,
            idempotencyKey,
            clientCapturedAt: verified.clientCapturedAt,
            ipAddress: normalizedString(req.ip, 120),
            userAgent: normalizedString(req.get?.('user-agent'), 500)
          });
        }));
      }

      const commonInput = {
        leaderWorkerId: portalSession.workerId,
        assignmentId,
        idempotencyKey,
        now,
        captureMode: OFFLINE_WEB_CAPTURE_MODE,
        clientCapturedAt: verified.clientCapturedAt,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracyMeters,
        installationIdHash: verified.leaderInstallationIdHash,
        persistentStorageAvailable: true,
        presenceValidated: true,
        validatedWorkerIds: verified.validatedWorkerIds,
        ipAddress: normalizedString(req.ip, 120),
        userAgent: normalizedString(req.get?.('user-agent'), 500)
      };
      const result = markType === 'ARRIVAL'
        ? await registerCrewPresenceArrivalFn({
            ...commonInput,
            forceMajeure: false
          })
        : await registerCrewPresenceMarkFn({
            ...commonInput,
            markType
          });

      if (!result?.applied) {
        return strictError(res, 409, 'crew_presence_group_not_available', 'La marcación por cuadrilla ya no está disponible.');
      }
      if (!result.summary) {
        return strictError(res, 409, 'crew_presence_leader_mark_conflict', 'La marcación del encargado no permitió completar esta acción de cuadrilla.');
      }

      const summary = result.summary;
      const alreadyRecordedCount = Number(summary.alreadyRecordedCount || 0);
      const processedCount = Number.isFinite(Number(summary.processedCount))
        ? Number(summary.processedCount)
        : Number(summary.newlyRecordedCount || 0) + Number(summary.replayedCount || 0) + alreadyRecordedCount;
      const validatedSet = new Set(verified.validatedWorkerIds || []);
      const phoneExceptionSet = markType === 'ARRIVAL'
        ? new Set(verified.phoneExceptionWorkerIds || [])
        : new Set();
      const resultByAssignment = new Map((summary.results || []).map((item) => [item.assignmentId, item]));
      const memberStatuses = verifiedMembers.map((member) => {
        const canonicalResult = resultByAssignment.get(member.assignmentId);
        let status = 'PENDING';
        if (['RECORDED', 'REPLAYED', 'ALREADY_RECORDED'].includes(canonicalResult?.status)) status = 'REGISTERED';
        else if (canonicalResult?.status === 'NOT_RECORDED') status = 'PENDING';
        else if (validatedSet.has(member.workerId)) status = 'VERIFIED';
        else if (phoneExceptionSet.has(member.workerId)) status = 'NO_PHONE_REVIEW';
        else if (markType === 'ARRIVAL' && member.arrivalReported) status = 'REGISTERED';
        return {
          assignmentId: member.assignmentId,
          workerId: member.workerId,
          isLeader: member.workerId === portalSession.workerId,
          status
        };
      });
      const verifiedCount = memberStatuses.filter((member) => member.status === 'VERIFIED').length;
      const registeredCount = memberStatuses.filter((member) => member.status === 'REGISTERED').length;
      const pendingCount = memberStatuses.filter((member) => member.status === 'PENDING').length;
      const phoneExceptionCount = memberStatuses.filter((member) => member.status === 'NO_PHONE_REVIEW').length;
      const notDetectedCount = pendingCount;
      const requiresReview = summary.failedCount > 0
        || summary.reviewPendingCount > 0
        || phoneExceptionCount > 0;
      const actionLabel = crewMarkLabel(markType);
      let message = `${actionLabel} de cuadrilla: ${registeredCount} integrante${registeredCount === 1 ? '' : 's'} registrado${registeredCount === 1 ? '' : 's'}.`;
      if (verifiedCount > 0) message += ` ${verifiedCount} detectado${verifiedCount === 1 ? '' : 's'} no pudo${verifiedCount === 1 ? '' : 'ieron'} completar la marca.`;
      if (pendingCount > 0) message += ` ${pendingCount} queda${pendingCount === 1 ? '' : 'n'} pendiente${pendingCount === 1 ? '' : 's'} por no ser detectado${pendingCount === 1 ? '' : 's'}.`;
      if (phoneExceptionCount > 0) message += ` ${phoneExceptionCount} sin teléfono queda${phoneExceptionCount === 1 ? '' : 'n'} por revisar.`;
      if (summary.failedCount > 0 || summary.reviewPendingCount > 0) {
        message += ' Una o más marcaciones requieren revisión.';
      }

      return res.status(200).json({
        ok: true,
        markType,
        crewGroup: true,
        presenceValidated: true,
        serviceRequestId,
        totalMembers: summary.totalMembers,
        detectedMembers: summary.eligibleMembers ?? validatedSet.size,
        processedCount,
        newlyRecordedCount: summary.newlyRecordedCount,
        replayedCount: summary.replayedCount,
        alreadyRecordedCount,
        failedCount: summary.failedCount,
        reviewPendingCount: summary.reviewPendingCount,
        notDetectedCount,
        verifiedProofCount: verified.verifiedProofCount,
        rejectedProofCount: verified.rejectedProofCount,
        phoneExceptionCount,
        rejectedPhoneExceptionCount: markType === 'ARRIVAL' ? (verified.rejectedPhoneExceptionCount || 0) : 0,
        memberStatuses,
        requiresReview,
        message
      });
    } catch (error) {
      const [status, code] = crewPresencePublicError(error);
      if (status >= 500) console.error('[WORKER_PORTAL_CREW_PRESENCE_SYNC_FAILED]', { code });
      return strictError(res, status, code, 'No fue posible sincronizar la marcación de la cuadrilla.');
    }
  });

  router.post('/biometria/estado', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const enrollment = await getEnrollmentFn(portalSession.workerId);
      const enrolled = hasCurrentBiometricEnrollment(enrollment);
      return res.status(200).json({
        ok: true,
        enrolled,
        registrationRequired: !enrolled,
        upgradeRequired: Boolean(enrollment?.enrolled && !enrolled)
      });
    } catch (error) {
      console.error('[WORKER_PORTAL_BIOMETRIC_STATUS_FAILED]', {
        code: typeof error?.message === 'string' ? error.message : 'unknown'
      });
      return strictError(res, 503, 'biometric_temporarily_unavailable', 'No fue posible consultar el registro facial.');
    }
  });

  router.post('/biometria/registrar', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const current = await getEnrollmentFn(portalSession.workerId);
      if (hasCurrentBiometricEnrollment(current)) {
        return res.status(200).json({ ok: true, enrolled: true, alreadyEnrolled: true });
      }
      const result = await enrollBiometricFn({
        workerId: portalSession.workerId,
        workerLabel: portalSession.workerId,
        evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
        descriptor: req.body?.descriptor,
        sampleDescriptors: req.body?.sampleDescriptors,
        sampleRealScores: req.body?.sampleRealScores,
        sampleLiveScores: req.body?.sampleLiveScores,
        captureDurationMs: req.body?.captureDurationMs,
        realScore: req.body?.realScore,
        liveScore: req.body?.liveScore,
        modelVersion: normalizedString(req.body?.modelVersion, 100),
        consentAccepted: req.body?.consentAccepted === true,
        actorUsername: `worker-portal:${portalSession.workerId}`,
        actorRole: 'worker',
        ipAddress: normalizedString(req.ip, 120),
        userAgent: normalizedString(req.get?.('user-agent'), 500)
      }, { now, env: options.env || process.env });
      await markLatestEnrollmentAsWorkerPortal(portalSession.workerId);
      return res.status(201).json({
        ok: true,
        enrolled: true,
        upgraded: Boolean(current?.enrolled),
        enrolledAt: result.enrolledAt
      });
    } catch (error) {
      const [status, code] = biometricPublicError(error);
      setBiometricRetryAfter(res, error);
      return strictError(res, status, code, 'No fue posible completar el registro facial.');
    }
  });

  router.post('/biometria/desafio', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const context = await requireBiometricAssignment(req, res, portalSession, now);
      if (!context) return;
      let locationInput = req.body;
      if (isNativeAndroidRequest(req)) {
        locationInput = requireNativeAttendanceLocation(req, res, portalSession, {
          assignmentId: context.assignmentId,
          markType: context.markType,
          idempotencyKey: context.idempotencyKey,
          captureMode: ONLINE_WEB_CAPTURE_MODE
        }, now);
        if (!locationInput) return;
        applyVerifiedNativeLocationToBody(req, locationInput);
      }
      const location = await requireStrictAttendanceLocation(
        prisma,
        res,
        context.assignment.serviceRequest.operationPoint,
        locationInput
      );
      if (!location) return;
      const enrollment = await getEnrollmentFn(portalSession.workerId);
      if (!hasCurrentBiometricEnrollment(enrollment)) {
        return strictError(res, 409, 'biometric_enrollment_required', 'Debes renovar el registro facial antes de marcar.');
      }
      await assertAttemptAllowedFn({
        workerId: portalSession.workerId,
        assignmentId: context.assignmentId,
        markType: context.markType
      }, { now });
      const challenge = issueChallengeFn({
        workerId: portalSession.workerId,
        assignmentId: context.assignmentId,
        idempotencyKey: context.idempotencyKey,
        markType: context.markType
      }, { now, env: options.env || process.env });
      return res.status(200).json({ ok: true, challenge });
    } catch (error) {
      const [status, code] = biometricPublicError(error);
      setBiometricRetryAfter(res, error);
      console.warn('[WORKER_PORTAL_BIOMETRIC_CHALLENGE_FAILED]', { code });
      return strictError(res, status, code, 'No fue posible iniciar la validación facial.');
    }
  });

  router.post('/biometria/verificar', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const context = await requireBiometricAssignment(req, res, portalSession, now);
      if (!context) return;
      const enrollment = await getEnrollmentFn(portalSession.workerId);
      if (!hasCurrentBiometricEnrollment(enrollment)) {
        return strictError(res, 409, 'biometric_enrollment_required', 'Debes renovar el registro facial antes de marcar.');
      }
      const assessment = await assessBiometricFn({
        workerId: portalSession.workerId,
        assignmentId: context.assignmentId,
        idempotencyKey: context.idempotencyKey,
        markType: context.markType,
        evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
        challengeToken: req.body?.challengeToken,
        challengeAction: normalizedString(req.body?.challengeAction, 40),
        challengeCompleted: req.body?.challengeCompleted === true,
        challengeEvidence: req.body?.challengeEvidence,
        descriptor: req.body?.descriptor,
        sampleDescriptors: req.body?.sampleDescriptors,
        sampleRealScores: req.body?.sampleRealScores,
        sampleLiveScores: req.body?.sampleLiveScores,
        realScore: req.body?.realScore,
        liveScore: req.body?.liveScore,
        modelVersion: normalizedString(req.body?.modelVersion, 100),
        ipAddress: normalizedString(req.ip, 120),
        userAgent: normalizedString(req.get?.('user-agent'), 500)
      }, { now, env: options.env || process.env });
      if (!assessment?.verified) {
        return res.status(422).json({
          ok: false,
          error: 'biometric_verification_rejected',
          verified: false,
          requiresReview: false,
          riskFlags: assessment?.riskFlags || []
        });
      }
      return res.status(200).json({
        ok: true,
        decision: assessment.decision,
        verified: true,
        validUntil: assessment.validUntil,
        requiresReview: false
      });
    } catch (error) {
      const [status, code] = biometricPublicError(error);
      setBiometricRetryAfter(res, error);
      console.warn('[WORKER_PORTAL_BIOMETRIC_VERIFICATION_FAILED]', { code });
      return strictError(res, status, code, 'No fue posible completar la validación facial.');
    }
  });

  router.use('/sesion-transferencia', createWorkerPortalSessionHandoffRouter(prisma, {
    repository: getRepository(),
    resolveSessionFn,
    nowFn,
    env: options.env || process.env,
    secret: options.handoffSecret ?? options.installationPepper,
    ttlMs: options.handoffTtlMs,
    randomBytesFn: options.handoffRandomBytesFn,
    rotateSessionTokenFn: options.rotateSessionTokenFn
  }));

  return router;
}