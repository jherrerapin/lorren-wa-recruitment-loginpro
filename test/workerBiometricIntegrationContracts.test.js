import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const browserLoader = fs.readFileSync('src/public/worker-biometric.js', 'utf8');
const browser = fs.readFileSync('src/public/worker-biometric-core.js', 'utf8');
const hardening = fs.readFileSync('src/public/worker-portal-hardening.js', 'utf8');
const bridge = fs.readFileSync('src/public/vendor/human/human.js', 'utf8');
const portal = fs.readFileSync('src/views/workerPortal.ejs', 'utf8');
const activationView = fs.readFileSync('src/views/operacionesPortalActivaciones.ejs', 'utf8');
const verificationRoute = fs.readFileSync('src/routes/dispatchWorkerPortalActivationAdmin.js', 'utf8');
const portalRoute = fs.readFileSync('src/routes/workerPortal.js', 'utf8');
const service = fs.readFileSync('src/services/workerBiometricService.js', 'utf8');
const migration = fs.readFileSync('prisma/migrations/20260728033000_enforce_worker_biometric_review/migration.sql', 'utf8');


test('Human queda fuera del servidor y fijado en el puente CDN del navegador', () => {
  assert.equal(packageJson.dependencies['@vladmandic/human'], undefined);
  assert.equal(packageLock.packages[''].dependencies['@vladmandic/human'], undefined);
  assert.doesNotMatch(packageJson.scripts.build, /prepare:human/);
  assert.doesNotMatch(packageJson.scripts.start, /prepare:human/);
  assert.match(browserLoader, /worker-biometric-core\.js/);
  assert.match(browserLoader, /worker-portal-hardening\.js/);
  assert.match(browser, /\/public\/vendor\/human\/human\.js/);
  assert.match(browser, /\/public\/vendor\/human\/models\//);
  assert.match(bridge, /HUMAN_VERSION = '3\.3\.6'/);
  assert.match(bridge, /cdn\.jsdelivr\.net\/npm\/@vladmandic\/human@\$\{HUMAN_VERSION\}\/dist\/human\.js/);
  assert.match(bridge, /modelBasePath: HUMAN_CDN_MODELS/);
  assert.match(portalRoute, /https:\/\/cdn\.jsdelivr\.net/);
});


test('el celular ejecuta detección, vivacidad, anti-spoof y desafío activo', () => {
  assert.match(browser, /face\.real/);
  assert.match(browser, /face\.live/);
  assert.match(browser, /face\.embedding/);
  assert.match(browser, /rotation\?\.angle/);
  assert.match(browser, /TURN_SIDE/);
  assert.match(browser, /MOVE_CLOSER/);
  assert.match(browser, /faces\.length !== 1/);
  assert.match(browser, /createHuman\('webgl'\)/);
  assert.match(browser, /createHuman\('cpu'\)/);
});


test('el servidor cifra la plantilla y firma desafíos ligados a cada marcación', () => {
  assert.match(service, /aes-256-gcm/);
  assert.match(service, /createHmac\('sha256'/);
  assert.match(service, /workerId,\s*assignmentId,\s*idempotencyKey,\s*markType/);
  assert.match(service, /CHALLENGE_TTL_MS = 2 \* 60 \* 1000/);
  assert.match(service, /timingSafeEqual/);
  assert.match(service, /BIOMETRIC_DESCRIPTOR_REPLAY/);
  assert.doesNotMatch(service, /metadata:\s*\{[^}]*descriptor:/s);
});


test('el primer acceso registra el rostro explícitamente desde la sesión del auxiliar', () => {
  assert.match(portal, /id="enrollment-dialog"/);
  assert.match(portal, /Registro facial inicial/);
  assert.match(portal, /captureEnrollment/);
  assert.match(portal, /portalBiometricRequest\('estado'\)/);
  assert.match(portal, /portalBiometricRequest\('registrar'/);
  assert.match(portalRoute, /router\.post\('\/biometria\/estado'/);
  assert.match(portalRoute, /router\.post\('\/biometria\/registrar'/);
  assert.match(portalRoute, /portalSession\.workerId/);
  assert.match(portalRoute, /await enrollBiometricFn\(/);
  assert.match(portalRoute, /actorSource: 'worker-portal'/);
  assert.match(verificationRoute, /biometric_enrollment_required/);
  assert.doesNotMatch(verificationRoute, /await enrollBiometricFn\(/);
});


test('la captura biométrica solo acepta cámara en vivo', () => {
  assert.match(portal, /Solo cámara en vivo/);
  assert.doesNotMatch(portal, /type="file"/i);
  assert.doesNotMatch(portal, /fallback-photo|file-fallback|capturePlainPhoto/);
  assert.doesNotMatch(portal, /setPhoto\(file\)|files\?\.\[0\]/);
  assert.doesNotMatch(portal, /quedará para revisión/i);
  assert.doesNotMatch(activationView, /id="enroll-button"/);
  assert.doesNotMatch(activationView, /id="biometric-dialog"/);
  assert.doesNotMatch(activationView, /Registrar rostro|Actualizar rostro/);
  assert.doesNotMatch(hardening, /enroll-button|biometric-dialog/);
});


test('entrada y salida exigen una captura nueva, biometría verificada y geocerca', () => {
  assert.match(portal, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(portal, /biometria\/desafio/);
  assert.match(portal, /biometria\/verificar/);
  assert.match(portal, /captureVerification/);
  assert.match(portal, /biometricVerified = true/);
  assert.match(portal, /if \(isBiometricMark\(\)\) form\.set\('selfie'/);
  assert.match(portalRoute, /outside_operation_range/);
  assert.match(portalRoute, /location_accuracy_insufficient/);
  assert.match(portalRoute, /metadata\.decision === 'VERIFIED'/);
  assert.match(portalRoute, /biometric_verification_required/);
  assert.match(portalRoute, /prependRouteHandlers\(router, path, \[markUpload, strictMarkGuard\]\)/);
  assert.match(hardening, /Primero completa correctamente la validación facial/);
});


test('PostgreSQL conserva una segunda barrera contra autovalidación biométrica', () => {
  assert.match(migration, /DispatchAttendanceMark_enforce_biometric_review/);
  assert.match(migration, /BIOMETRIC_ASSESSMENT_MISSING/);
  assert.match(migration, /SET "decision" = 'REVIEW_REQUIRED'/);
  assert.match(migration, /DispatchAttendanceSession_preserve_biometric_review/);
  assert.match(migration, /NEW\."validationStatus" := 'REVIEW_REQUIRED'/);
  assert.match(migration, /NEW\."arrivalValidatedAt" := NULL/);
  assert.match(migration, /NEW\."departureValidatedAt" := NULL/);
});
