import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const portalRoute = fs.readFileSync('src/routes/workerPortal.js', 'utf8');
const biometricRoute = fs.readFileSync('src/routes/dispatchWorkerPortalActivationAdmin.js', 'utf8');
const portalView = fs.readFileSync('src/views/workerPortal.ejs', 'utf8');
const activationView = fs.readFileSync('src/views/operacionesPortalActivaciones.ejs', 'utf8');
const hardening = fs.readFileSync('src/public/worker-portal-hardening.js', 'utf8');
const biometricFlow = fs.readFileSync('src/public/worker-portal-biometric-flow.js', 'utf8');
const compactAdmin = fs.readFileSync('src/public/attendance-admin-compact.js', 'utf8');
const biometricLoader = fs.readFileSync('src/public/worker-biometric.js', 'utf8');
const adminLoader = fs.readFileSync('src/public/attendance-admin-runtime.js', 'utf8');


test('la geocerca se valida antes de delegar la persistencia al núcleo', () => {
  assert.match(portalRoute, /calculateAttendanceDistanceMeters/);
  assert.match(portalRoute, /isAttendanceInsideGeofence\(distanceMeters, radiusMeters\) !== true/);
  assert.match(portalRoute, /operation_geofence_required/);
  assert.match(portalRoute, /location_accuracy_insufficient/);
  assert.match(portalRoute, /outside_operation_range/);
  assert.match(portalRoute, /prependRouteHandlers\(router, path, \[markUpload, strictMarkGuard\]\)/);
  assert.match(portalRoute, /target\.route\.stack\.unshift/);
  const corePosition = portalRoute.indexOf('coreWorkerPortalRouter(prisma');
  const guardInjectionPosition = portalRoute.lastIndexOf('prependRouteHandlers(router, path');
  assert.ok(corePosition >= 0 && guardInjectionPosition > corePosition);
});


test('llegada, almuerzo y salida necesitan una evaluación facial verificada', () => {
  assert.match(portalRoute, /BIOMETRIC_MARK_TYPES = new Set\(\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\)/);
  assert.match(portalRoute, /metadata\.decision === 'VERIFIED'/);
  assert.match(portalRoute, /metadata\.verified === true/);
  assert.match(portalRoute, /String\(metadata\.markType \|\| ''\) === String\(expected\.markType\)/);
  assert.match(portalRoute, /biometric_verification_required/);
  assert.match(portalRoute, /ONLINE_WEB/);
  assert.match(hardening, /biometricVerified = Boolean/);
  assert.match(hardening, /Primero completa correctamente la validación facial/);
  assert.match(biometricFlow, /\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\.includes\(state\.markType\)/);
  assert.match(biometricFlow, /markType: state\.markType/);
  assert.match(biometricFlow, /captureVerification/);
  assert.match(biometricFlow, /state\.biometricVerified = true/);
  assert.match(biometricFlow, /form\.set\('selfie', state\.photoBlob/);
});


test('la inscripción inicial ocurre antes de marcar y usa la sesión del auxiliar', () => {
  assert.match(portalRoute, /router\.post\('\/biometria\/estado'/);
  assert.match(portalRoute, /router\.post\('\/biometria\/registrar'/);
  assert.match(portalRoute, /await enrollBiometricFn\(/);
  assert.match(portalRoute, /portalSession\.workerId/);
  assert.match(portalRoute, /consentAccepted: req\.body\?\.consentAccepted === true/);
  assert.match(portalRoute, /actorSource: 'worker-portal'/);
  assert.match(portalView, /Registro facial inicial/);
  assert.match(biometricFlow, /captureEnrollment/);
  assert.match(biometricFlow, /loadBiometricStatus/);
  assert.match(biometricRoute, /biometric_enrollment_required/);
  assert.doesNotMatch(biometricRoute, /await enrollBiometricFn\(/);
});


test('no existe carga de archivos ni registro facial administrativo', () => {
  assert.doesNotMatch(portalView, /type="file"/i);
  assert.doesNotMatch(portalView, /fallback-photo|file-fallback|capturePlainPhoto/);
  assert.doesNotMatch(activationView, /enroll-button|biometric-dialog/);
  assert.doesNotMatch(activationView, /Registrar rostro|Actualizar rostro/);
  assert.doesNotMatch(hardening, /enroll-button|biometric-dialog/);
});


test('las vistas ya no dependen de JavaScript para retirar textos redundantes del portal', () => {
  assert.match(compactAdmin, /removeAll\('\.calculation-note'\)/);
  assert.match(compactAdmin, /removeAll\('\.work-grid'\)/);
  assert.match(compactAdmin, /removeAll\('\.attendance-risk-explanation'\)/);
  assert.doesNotMatch(portalView, /class="work-summary"/);
  assert.doesNotMatch(portalView, /Pendiente de salida|Horas extra|Tiempo trabajado/);
  assert.match(portalView, /Jornada finalizada/);
  assert.match(portalView, /Registrar salida/);
});


test('los cargadores conservan los núcleos y aplican el endurecimiento', () => {
  assert.match(biometricLoader, /worker-biometric-core\.js/);
  assert.match(biometricLoader, /worker-portal-hardening\.js/);
  assert.match(biometricLoader, /worker-portal-biometric-flow\.js/);
  assert.match(adminLoader, /attendance-admin-runtime-core\.js/);
  assert.match(adminLoader, /attendance-admin-compact\.js/);
});