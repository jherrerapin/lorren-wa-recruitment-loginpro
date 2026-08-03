import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const portalRoute = fs.readFileSync('src/routes/workerPortal.js', 'utf8');
const biometricRoute = fs.readFileSync('src/routes/dispatchWorkerPortalActivationAdmin.js', 'utf8');
const portalView = fs.readFileSync('src/views/workerPortal.ejs', 'utf8');
const activationView = fs.readFileSync('src/views/operacionesPortalActivaciones.ejs', 'utf8');
const biometricFlow = fs.readFileSync('src/public/worker-portal-biometric-flow.js', 'utf8');
const compactAdmin = fs.readFileSync('src/public/attendance-admin-compact.js', 'utf8');
const biometricLoader = fs.readFileSync('src/public/worker-biometric.js', 'utf8');
const adminLoader = fs.readFileSync('src/public/attendance-admin-runtime.js', 'utf8');


test('la geocerca se compone explícitamente antes de la persistencia del núcleo', () => {
  assert.match(portalRoute, /calculateAttendanceDistanceMeters/);
  assert.match(portalRoute, /isAttendanceInsideGeofence\(distanceMeters, radiusMeters\) !== true/);
  assert.match(portalRoute, /operation_geofence_required/);
  assert.match(portalRoute, /location_accuracy_insufficient/);
  assert.match(portalRoute, /outside_operation_range/);
  assert.match(portalRoute, /function strictMarkMiddleware\(req, res, next\)/);
  assert.match(portalRoute, /markUpload\(req, res, \(error\) =>/);
  assert.match(portalRoute, /return strictMarkGuard\(req, res, next\)/);
  assert.match(portalRoute, /markUpload: strictMarkMiddleware/);
  assert.doesNotMatch(portalRoute, /prependRouteHandlers|routeLayer|router\.stack|target\.route\.stack/);
});


test('llegada, almuerzo y salida necesitan una evaluación facial v2 vigente y no consumida', () => {
  assert.match(portalRoute, /BIOMETRIC_MARK_TYPES = new Set\(\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\)/);
  assert.match(portalRoute, /isWorkerBiometricVerificationUsable/);
  assert.match(portalRoute, /idempotencyKey/);
  assert.match(portalRoute, /consumeVerifiedAssessmentAfterSuccess/);
  assert.match(portalRoute, /biometric_verification_required/);
  assert.match(portalRoute, /ONLINE_WEB/);
  assert.match(biometricFlow, /\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\.includes\(state\.markType\)/);
  assert.match(biometricFlow, /captureVerification/);
  assert.match(biometricFlow, /state\.biometricVerified = true/);
  assert.match(biometricFlow, /state\.biometricValidUntil/);
  assert.match(biometricFlow, /markType: state\.markType/);
  assert.match(biometricFlow, /form\.set\('selfie', state\.photoBlob/);
});


test('la inscripción v2 ocurre solo en el portal y usa la sesión del auxiliar', () => {
  assert.match(portalRoute, /router\.post\('\/biometria\/estado'/);
  assert.match(portalRoute, /router\.post\('\/biometria\/registrar'/);
  assert.match(portalRoute, /await enrollBiometricFn\(/);
  assert.match(portalRoute, /portalSession\.workerId/);
  assert.match(portalRoute, /hasCurrentBiometricEnrollment/);
  assert.match(portalRoute, /sampleDescriptors: req\.body\?\.sampleDescriptors/);
  assert.match(portalRoute, /consentAccepted: req\.body\?\.consentAccepted === true/);
  assert.match(portalRoute, /actorSource: 'worker-portal'/);
  assert.match(portalRoute, /biometric_enrollment_required/);
  assert.match(portalView, /Registro facial inicial/);
  assert.match(biometricFlow, /captureEnrollment/);
  assert.match(biometricFlow, /loadBiometricStatus/);
  assert.doesNotMatch(biometricRoute, /biometric_enrollment_required|enrollBiometricFn/);
  assert.doesNotMatch(biometricRoute, /router\.post\('\/biometria\/registrar'/);
});


test('no existe carga de archivos ni registro facial administrativo', () => {
  assert.doesNotMatch(portalView, /type="file"/i);
  assert.doesNotMatch(portalView, /fallback-photo|file-fallback|capturePlainPhoto/);
  assert.doesNotMatch(activationView, /enroll-button|biometric-dialog/);
  assert.doesNotMatch(activationView, /Registrar rostro|Actualizar rostro/);
  assert.equal(fs.existsSync('src/public/worker-portal-hardening.js'), false);
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


test('los cargadores conservan únicamente los componentes vigentes', () => {
  assert.match(biometricLoader, /worker-biometric-core\.js/);
  assert.match(biometricLoader, /worker-biometric-mobile\.js/);
  assert.match(biometricLoader, /worker-portal-biometric-flow\.js/);
  assert.doesNotMatch(biometricLoader, /worker-portal-hardening\.js/);
  assert.match(adminLoader, /attendance-admin-runtime-core\.js/);
  assert.match(adminLoader, /attendance-admin-compact\.js/);
});
