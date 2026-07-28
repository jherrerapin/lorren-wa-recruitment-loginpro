import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const portalRoute = fs.readFileSync('src/routes/workerPortal.js', 'utf8');
const biometricRoute = fs.readFileSync('src/routes/dispatchWorkerPortalActivationAdmin.js', 'utf8');
const hardening = fs.readFileSync('src/public/worker-portal-hardening.js', 'utf8');
const compactAdmin = fs.readFileSync('src/public/attendance-admin-compact.js', 'utf8');
const biometricLoader = fs.readFileSync('src/public/worker-biometric.js', 'utf8');
const adminLoader = fs.readFileSync('src/public/attendance-admin-runtime.js', 'utf8');


test('la geocerca se valida antes de delegar la persistencia al núcleo', () => {
  assert.match(portalRoute, /calculateAttendanceDistanceMeters/);
  assert.match(portalRoute, /isAttendanceInsideGeofence\(distanceMeters, radiusMeters\) !== true/);
  assert.match(portalRoute, /operation_geofence_required/);
  assert.match(portalRoute, /location_accuracy_insufficient/);
  assert.match(portalRoute, /outside_operation_range/);
  const guardPosition = portalRoute.indexOf('router.post(STRICT_MARK_PATHS, markUpload, strictMarkGuard)');
  const corePosition = portalRoute.indexOf('router.use(coreWorkerPortalRouter');
  assert.ok(guardPosition >= 0 && corePosition > guardPosition);
});


test('cada entrada y salida necesita una evaluación facial verificada', () => {
  assert.match(portalRoute, /BIOMETRIC_MARK_TYPES = new Set\(\['ARRIVAL', 'DEPARTURE'\]\)/);
  assert.match(portalRoute, /metadata\.decision === 'VERIFIED'/);
  assert.match(portalRoute, /metadata\.verified === true/);
  assert.match(portalRoute, /biometric_verification_required/);
  assert.match(portalRoute, /online_biometric_required/);
  assert.match(hardening, /biometricVerified = Boolean/);
  assert.match(hardening, /Primero completa correctamente la validación facial/);
});


test('la inscripción inicial ocurre en el portal del auxiliar', () => {
  assert.match(biometricRoute, /enrollmentRequired:/);
  assert.match(biometricRoute, /await enrollBiometricFn\(/);
  assert.match(biometricRoute, /consentAccepted: req\.body\?\.consentAccepted === true/);
  assert.match(biometricRoute, /await assessBiometricFn\(/);
  assert.match(biometricRoute, /actorSource: 'worker-portal'/);
  assert.match(biometricRoute, /biometric_enrollment_moved_to_worker_portal/);
  assert.match(hardening, /getElementById\('enroll-button'\)\?\.remove/);
  assert.match(hardening, /payload\.consentAccepted/);
});


test('las capas visuales eliminan explicaciones y estados redundantes', () => {
  assert.match(compactAdmin, /removeAll\('\.calculation-note'\)/);
  assert.match(compactAdmin, /removeAll\('\.work-grid'\)/);
  assert.match(compactAdmin, /removeAll\('\.attendance-risk-explanation'\)/);
  assert.match(compactAdmin, /label\.includes\('almuerzo'\)/);
  assert.match(compactAdmin, /value\.includes\(text\)/);
  assert.match(hardening, /removeElement\('\.work-summary'\)/);
  assert.match(hardening, /removeElement\('\.portal-summary-panel'\)/);
  assert.match(hardening, /removeElement\('\.portal-status-pill'\)/);
  assert.match(hardening, /Jornada finalizada/);
  assert.match(hardening, /Registrar salida/);
});


test('los cargadores conservan los núcleos y aplican el endurecimiento', () => {
  assert.match(biometricLoader, /worker-biometric-core\.js/);
  assert.match(biometricLoader, /worker-portal-hardening\.js/);
  assert.match(adminLoader, /attendance-admin-runtime-core\.js/);
  assert.match(adminLoader, /attendance-admin-compact\.js/);
});
