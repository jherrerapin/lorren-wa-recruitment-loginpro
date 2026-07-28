import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const browser = fs.readFileSync('src/public/worker-biometric.js', 'utf8');
const bridge = fs.readFileSync('src/public/vendor/human/human.js', 'utf8');
const portal = fs.readFileSync('src/views/workerPortal.ejs', 'utf8');
const admin = fs.readFileSync('src/views/operacionesPortalActivaciones.ejs', 'utf8');
const route = fs.readFileSync('src/routes/dispatchWorkerPortalActivationAdmin.js', 'utf8');
const service = fs.readFileSync('src/services/workerBiometricService.js', 'utf8');
const migration = fs.readFileSync('prisma/migrations/20260728033000_enforce_worker_biometric_review/migration.sql', 'utf8');

test('Human queda fuera del servidor y fijado en el puente CDN del navegador', () => {
  assert.equal(packageJson.dependencies['@vladmandic/human'], undefined);
  assert.equal(packageLock.packages[''].dependencies['@vladmandic/human'], undefined);
  assert.doesNotMatch(packageJson.scripts.build, /prepare:human/);
  assert.doesNotMatch(packageJson.scripts.start, /prepare:human/);
  assert.match(browser, /\/public\/vendor\/human\/human\.js/);
  assert.match(browser, /\/public\/vendor\/human\/models\//);
  assert.match(bridge, /HUMAN_VERSION = '3\.3\.6'/);
  assert.match(bridge, /cdn\.jsdelivr\.net\/npm\/@vladmandic\/human@\$\{HUMAN_VERSION\}\/dist\/human\.js/);
  assert.match(bridge, /modelBasePath: HUMAN_CDN_MODELS/);
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

test('el servidor cifra la plantilla y firma desafíos ligados a la marcación', () => {
  assert.match(service, /aes-256-gcm/);
  assert.match(service, /createHmac\('sha256'/);
  assert.match(service, /workerId,\s*assignmentId,\s*idempotencyKey,\s*markType/);
  assert.match(service, /CHALLENGE_TTL_MS = 2 \* 60 \* 1000/);
  assert.match(service, /timingSafeEqual/);
  assert.match(service, /BIOMETRIC_DESCRIPTOR_REPLAY/);
  assert.doesNotMatch(service, /metadata:\s*\{[^}]*descriptor:/s);
});

test('la inscripción es supervisada, consentida y revocable', () => {
  assert.match(admin, /Registro supervisado/);
  assert.match(admin, /autorizó la plantilla facial/);
  assert.match(admin, /Registrar rostro/);
  assert.match(admin, /Eliminar rostro/);
  assert.match(route, /consentAccepted: req\.body\?\.consentAccepted === true/);
  assert.match(route, /router\.post\('\/biometria\/revocar'/);
  assert.match(service, /redactHistoricalEnrollmentTemplates/);
});

test('el portal usa GPS, dispositivo y biometría sin bloquear una asistencia dudosa', () => {
  assert.match(portal, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(portal, /biometria\/desafio/);
  assert.match(portal, /biometria\/verificar/);
  assert.match(portal, /La marcación quedará para revisión/);
  assert.match(browser, /Marcación registrada y enviada para revisión/);
  assert.doesNotMatch(portal, /reconocimiento facial automático/);
});

test('PostgreSQL impide autovalidar una marcación biométrica ausente o fallida', () => {
  assert.match(migration, /DispatchAttendanceMark_enforce_biometric_review/);
  assert.match(migration, /BIOMETRIC_ASSESSMENT_MISSING/);
  assert.match(migration, /SET "decision" = 'REVIEW_REQUIRED'/);
  assert.match(migration, /DispatchAttendanceSession_preserve_biometric_review/);
  assert.match(migration, /NEW\."validationStatus" := 'REVIEW_REQUIRED'/);
  assert.match(migration, /NEW\."arrivalValidatedAt" := NULL/);
  assert.match(migration, /NEW\."departureValidatedAt" := NULL/);
});
