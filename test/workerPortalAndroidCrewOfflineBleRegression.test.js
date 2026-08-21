import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerCrewMarkForLeader } from '../src/modules/dispatch-attendance/application/registerCrewArrival.js';

function read(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('APK usa la autoridad nativa de cuadrilla y no inicia el Web Bluetooth heredado', async () => {
  const [workerBiometric, nativePresence] = await Promise.all([
    read('src/public/worker-biometric.js'),
    read('mobile/android/app/src/main/assets/native-presence.js')
  ]);

  const legacyCrewBlockStart = workerBiometric.indexOf("const CONTEXT_PATH = '/operaciones/portal/cuadrillas/proximidad/contexto';");
  const nativeGuard = workerBiometric.indexOf("if (window.LorrenAndroidPresence || /LorrenNative\\/1/.test(WORKER_PORTAL_USER_AGENT)) return;");
  const webBluetoothCall = workerBiometric.indexOf('navigator.bluetooth.requestDevice');

  assert.ok(legacyCrewBlockStart >= 0, 'falta localizar el flujo web de cuadrilla');
  assert.ok(nativeGuard > legacyCrewBlockStart, 'el APK debe salir del flujo Web Bluetooth al entrar al bloque de cuadrilla');
  assert.ok(webBluetoothCall > nativeGuard, 'el guard nativo debe ejecutarse antes de cualquier requestDevice');
  assert.match(nativePresence, /\[data-crew-bluetooth-status\]/);
});

test('Nearby conserva modo no disruptivo y Lórren no contiene autoridad para encender WiFi', async () => {
  const nearby = await read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java');

  assert.match(nearby, /DiscoveryOptions\.Builder\(\)[\s\S]{0,180}setLowPower\(true\)/);
  assert.match(nearby, /AdvertisingOptions\.Builder\(\)[\s\S]{0,220}setLowPower\(true\)[\s\S]{0,120}setConnectionType\(ConnectionType\.NON_DISRUPTIVE\)/);
  assert.match(nearby, /ConnectionOptions\.Builder\(\)[\s\S]{0,220}setLowPower\(true\)[\s\S]{0,120}setConnectionType\(ConnectionType\.NON_DISRUPTIVE\)/);
  assert.doesNotMatch(nearby, /WifiManager|setWifiEnabled|ACTION_WIFI_STATE_CHANGED|startLocalOnlyHotspot/);
});

test('cada marcación CREW genera una comprobación local nueva ligada al tipo de marca', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(nativePresence, /const MARK_TYPES = new Set\(\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\)/);
  assert.match(nativePresence, /async function startLeaderScan\(markType, automaticRetry = false\)/);
  assert.match(nativePresence, /challenge: `lorren-mark-v1:\$\{normalizedMark\}:\$\{randomToken\(32\)\}`/);
  assert.match(nativePresence, /proofBundle\.markType = attempt\.markType/);
  assert.match(nativePresence, /expectedAuxiliaryProofCount\(context, normalizedMark\)/);
  assert.match(nativePresence, /normalizedMark === 'ARRIVAL' && member\.arrivalReported/);
  assert.match(nativePresence, /Iniciar almuerzo de la cuadrilla/);
  assert.match(nativePresence, /Finalizar almuerzo de la cuadrilla/);
  assert.match(nativePresence, /Registrar salida de la cuadrilla/);
});

test('APK oculta las marcaciones individuales CREW y no deriva almuerzo o salida al diálogo facial', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(nativePresence, /function hideIndividualCrewMarks\(\)/);
  assert.match(nativePresence, /\.mark-button\[data-assignment-id\]\[data-mark-type\]/);
  assert.match(nativePresence, /button\.hidden = true/);
  assert.match(nativePresence, /queueCrewPresence/);
  assert.doesNotMatch(nativePresence, /\/biometria\/(?:estado|registrar|desafio|verificar)/);
  assert.doesNotMatch(nativePresence, /captureVerification|captureEnrollment|Verificación facial/);
});

test('sin teléfono no se presenta como diagnóstico antes de completar una entrada', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(nativePresence, /normalizedMark === 'ARRIVAL'[\s\S]{0,100}&& hasCompletedLeaderScan/);
  assert.match(nativePresence, /Reportar sin teléfono/);
  assert.match(nativePresence, /¿Confirmar que está presente pero no tiene su teléfono\?/);
  assert.doesNotMatch(nativePresence, /native-presence-member-action', 'Sin teléfono'/);
});

test('auxiliar reinicia realmente discovery cuando vuelve a primer plano', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(nativePresence, /async function ensureAuxiliaryReady\(forceRestart = false\)/);
  assert.match(nativePresence, /forceRestart && activeMode === 'READY'[\s\S]{0,120}bridgeCall\('stopReady'\)[\s\S]{0,80}activeMode = 'IDLE'/);
  assert.match(nativePresence, /window\.addEventListener\('focus',[\s\S]{0,100}ensureAuxiliaryReady\(true\)/);
  assert.match(nativePresence, /visibilitychange[\s\S]{0,160}visibilityState === 'visible'[\s\S]{0,100}ensureAuxiliaryReady\(true\)/);
});

test('scan conserva un único reintento automático y vuelve a comprobar solamente la misma marca', async () => {
  const [nearby, nativePresence] = await Promise.all([
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'),
    read('mobile/android/app/src/main/assets/native-presence.js')
  ]);

  assert.match(nearby, /input\.optInt\("expectedProofCount", 0\)/);
  assert.match(nearby, /expectedProofCount > 0 && proofsByKey\.size\(\) >= expectedProofCount[\s\S]{0,120}completeLeaderScan\(attemptId\)/);
  assert.match(nativePresence, /let autoRetryRemaining = 1;/);
  assert.match(nativePresence, /autoRetryRemaining -= 1;/);
  assert.match(nativePresence, /startLeaderScan\(completionMarkType, true\)/);
  assert.match(nativePresence, /retryMarkType = incomplete \? completionMarkType : ''/);
});

test('scan terminado espera ubicación tardía sin perder el tipo de marcación', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(nativePresence, /let pendingCompletedScan = null;/);
  assert.match(nativePresence, /pendingCompletedScan = completion/);
  assert.match(nativePresence, /type === 'native_location_ready'[\s\S]{0,260}completion\.markType \|\| activeAttempt\.markType/);
  assert.match(nativePresence, /finishCompletedScan\(completion\)/);
});

test('ubicación Android conserva la mejor muestra y el backend mantiene precisión y geocerca como autoridad', async () => {
  const [bridge, geofence] = await Promise.all([
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java'),
    read('src/modules/dispatch-attendance/application/attendanceGeofenceResolver.js')
  ]);

  assert.match(bridge, /TARGET_LOCATION_ACCURACY_METERS = 50f/);
  assert.match(bridge, /isBetterLocation\(location, bestLocation\[0\]\)/);
  assert.match(bridge, /locationAccuracyAcceptable\(bestLocation\[0\]\)/);
  assert.match(bridge, /pendingLocationTimeout = \(\) ->[\s\S]{0,420}bestLocation\[0\]/);
  assert.doesNotMatch(
    bridge,
    /onLocationChanged\(Location location\)[\s\S]{0,160}cancelPendingLocation\(\);\s*\n\s*sink\.onLocation\(location\)/
  );
  assert.match(geofence, /attendance_location_accuracy_insufficient/);
  assert.match(geofence, /attendance_outside_operation_range/);
  assert.match(geofence, /maxLocationAccuracyMeters/);
});

test('sin Internet una marcación CREW se encola y solo sincroniza cuando vuelve conectividad', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  const startLeaderScan = nativePresence.match(/async function startLeaderScan\(markType, automaticRetry = false\) \{([\s\S]*?)\n  \}\n\n  function stopNativeModes/);
  const queueCompletedAttempt = nativePresence.match(/async function queueCompletedAttempt\(\) \{([\s\S]*?)\n  \}\n\n  function finishCompletedScan/);

  assert.ok(startLeaderScan, 'falta startLeaderScan');
  assert.ok(queueCompletedAttempt, 'falta queueCompletedAttempt');
  assert.doesNotMatch(startLeaderScan[1], /navigator\.onLine/);
  assert.match(queueCompletedAttempt[1], /offline\.queueCrewPresence/);
  assert.match(queueCompletedAttempt[1], /if \(navigator\.onLine && typeof offline\.syncNow === 'function'\) offline\.syncNow\(\)/);
  assert.match(nativePresence, /if \(!navigator\.onLine\) return readCachedContexts\(\);/);
  assert.match(nativePresence, /if \(!navigator\.onLine\) return credentialPrepared\(\);/);
  assert.match(nativePresence, /de cuadrilla guardada sin conexión; se sincronizará cuando vuelva Internet/);
});

test('endpoint de presencia usa la misma puerta para las cuatro marcas y exige challenge ligado a markType', async () => {
  const route = await read('src/routes/workerPortal.js');

  assert.match(route, /CREW_MARK_CHALLENGE_PREFIX = 'lorren-mark-v1'/);
  assert.match(route, /proofBundle\?\.markType/);
  assert.match(route, /challenge\.startsWith\(`\$\{CREW_MARK_CHALLENGE_PREFIX\}:\$\{markType\}:`\)/);
  assert.match(route, /markType === 'ARRIVAL'[\s\S]{0,300}registerCrewPresenceArrivalFn/);
  assert.match(route, /registerCrewPresenceMarkFn/);
  assert.match(route, /markType[\s\S]{0,220}validatedWorkerIds: verified\.validatedWorkerIds/);
  assert.match(route, /verified\.leaderLocation[\s\S]{0,100}allowCrossOperation: false/);
});

test('fan-out verificado solo marca al subconjunto detectado y no atribuye dispositivo del encargado al auxiliar', async () => {
  const calls = [];
  const prisma = {
    dispatchAssignment: {
      async findMany() {
        return [
          { id: 'TEST-ASSIGNMENT-LEADER', workerId: 'TEST-WORKER-LEADER' },
          { id: 'TEST-ASSIGNMENT-A', workerId: 'TEST-WORKER-A' },
          { id: 'TEST-ASSIGNMENT-B', workerId: 'TEST-WORKER-B' }
        ];
      }
    }
  };
  const result = await registerCrewMarkForLeader(prisma, {
    leaderWorkerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    idempotencyKey: 'TEST-CREW-PRESENCE-MARK-001',
    markType: 'BREAK_START',
    now: new Date('2026-08-21T17:30:00.000Z'),
    captureMode: 'OFFLINE_WEB',
    clientCapturedAt: new Date('2026-08-21T17:29:00.000Z'),
    latitude: 4.6,
    longitude: -74.1,
    accuracyMeters: 18,
    installationIdHash: 'TEST-LEADER-INSTALLATION',
    persistentStorageAvailable: true,
    presenceValidated: true,
    validatedWorkerIds: ['TEST-WORKER-LEADER', 'TEST-WORKER-A']
  }, {
    loadCrewContextsFn: async () => [{
      assignmentId: 'TEST-ASSIGNMENT-LEADER',
      serviceRequestId: 'TEST-SERVICE-CREW',
      mode: 'CREW',
      isCrewLeader: true,
      crewAvailable: true
    }],
    registerBreakFn: async (_client, input) => {
      calls.push(input);
      return {
        recorded: true,
        replayed: false,
        attendanceSession: { validationStatus: 'AUTO_VALIDATED' },
        validation: { validationStatus: 'AUTO_VALIDATED' }
      };
    },
    registerDepartureFn: async () => {
      throw new Error('TEST-DEPARTURE-SHOULD-NOT-RUN');
    }
  });

  assert.deepEqual(calls.map((call) => call.expectedWorkerId), [
    'TEST-WORKER-LEADER',
    'TEST-WORKER-A'
  ]);
  assert.equal(calls[0].installationIdHash, 'TEST-LEADER-INSTALLATION');
  assert.equal(calls[1].installationIdHash, null);
  assert.equal(result.summary.eligibleMembers, 2);
  assert.equal(result.summary.notDetectedCount, 1);
});

test('reintento verificado continúa con auxiliares aunque esa misma marca ya exista para el encargado', async () => {
  const calls = [];
  const prisma = {
    dispatchAssignment: {
      async findMany() {
        return [
          { id: 'TEST-ASSIGNMENT-LEADER', workerId: 'TEST-WORKER-LEADER' },
          { id: 'TEST-ASSIGNMENT-A', workerId: 'TEST-WORKER-A' }
        ];
      }
    }
  };
  const result = await registerCrewMarkForLeader(prisma, {
    leaderWorkerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    idempotencyKey: 'TEST-CREW-PRESENCE-MARK-RETRY',
    markType: 'BREAK_START',
    now: new Date('2026-08-21T17:31:00.000Z'),
    captureMode: 'OFFLINE_WEB',
    clientCapturedAt: new Date('2026-08-21T17:30:00.000Z'),
    latitude: 4.6,
    longitude: -74.1,
    accuracyMeters: 15,
    persistentStorageAvailable: true,
    presenceValidated: true,
    validatedWorkerIds: ['TEST-WORKER-LEADER', 'TEST-WORKER-A']
  }, {
    loadCrewContextsFn: async () => [{
      assignmentId: 'TEST-ASSIGNMENT-LEADER',
      serviceRequestId: 'TEST-SERVICE-CREW',
      mode: 'CREW',
      isCrewLeader: true,
      crewAvailable: true
    }],
    registerBreakFn: async (_client, input) => {
      calls.push(input.expectedWorkerId);
      if (input.expectedWorkerId === 'TEST-WORKER-LEADER') {
        throw new Error('attendance_break_already_started');
      }
      return {
        recorded: true,
        replayed: false,
        attendanceSession: { validationStatus: 'AUTO_VALIDATED' },
        validation: { validationStatus: 'AUTO_VALIDATED' }
      };
    },
    registerDepartureFn: async () => {
      throw new Error('TEST-DEPARTURE-SHOULD-NOT-RUN');
    }
  });

  assert.deepEqual(calls, ['TEST-WORKER-LEADER', 'TEST-WORKER-A']);
  assert.equal(result.summary.alreadyRecordedCount, 1);
  assert.equal(result.summary.newlyRecordedCount, 1);
  assert.equal(result.summary.processedCount, 2);
});
