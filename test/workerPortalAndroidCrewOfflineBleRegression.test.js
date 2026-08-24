import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerCrewMarkForLeader } from '../src/modules/dispatch-attendance/application/registerCrewArrival.js';
import { loadCrewAttendancePortalContexts } from '../src/modules/dispatch-attendance/application/crewAttendanceConfig.js';

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

test('Nearby Connections conserva una sola autoridad: encargado hub y auxiliares discoverers sin cambiar radios', async () => {
  const [nearby, gradle, manifest, mainActivity] = await Promise.all([
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'),
    read('mobile/android/app/build.gradle'),
    read('mobile/android/app/src/main/AndroidManifest.xml'),
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/MainActivity.java')
  ]);

  assert.match(gradle, /play-services-nearby:19\.4\.0/);
  assert.match(nearby, /Nearby\.getConnectionsClient/);
  assert.match(nearby, /Strategy\.P2P_STAR/);
  assert.match(nearby, /startReadyDiscovery/);
  assert.match(nearby, /client\.startDiscovery/);
  assert.match(nearby, /startLeaderAdvertising/);
  assert.match(nearby, /client\.startAdvertising/);
  assert.match(nearby, /setLowPower\(false\)/);
  assert.equal((nearby.match(/ConnectionType\.NON_DISRUPTIVE/g) || []).length, 2);
  assert.doesNotMatch(nearby, /ConnectionType\.(?:BALANCED|DISRUPTIVE)/);
  assert.match(nearby, /Payload\.fromBytes/);
  assert.match(nearby, /DeviceKeyStore\.signBase64\(canonical\)/);
  assert.match(nearby, /DeviceKeyStore\.verifyBase64\(publicKey, canonical, signature\)/);
  assert.match(nearby, /expectedProofCount > 0 && verifiedCount >= expectedProofCount/);
  assert.doesNotMatch(nearby, /BluetoothLeAdvertiser|BluetoothGattServer|BluetoothGattCallback|BluetoothLeScanner|ScanFilter/);
  assert.doesNotMatch(nearby, /WifiManager|setWifiEnabled|ACTION_WIFI_STATE_CHANGED|startLocalOnlyHotspot/);

  assert.match(manifest, /android\.permission\.ACCESS_WIFI_STATE/);
  assert.match(manifest, /android\.permission\.CHANGE_WIFI_STATE/);
  assert.match(manifest, /android\.permission\.NEARBY_WIFI_DEVICES/);
  assert.match(mainActivity, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);
  assert.match(mainActivity, /hasNearbyWifiPermission\(\)/);
  assert.match(mainActivity, /addNearbyWifiPermissionIfNeeded\(missing\)/);
});

test('replay físico: auxiliar descubre al encargado Nearby y el enlace no usa BALANCED', async () => {
  const nearby = await read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java');

  const readyPath = nearby.match(
    /synchronized void startReady\(String serviceRequestId\) \{([\s\S]*?)\n    \}\n\n    private void startReadyDiscovery/
  );
  assert.ok(readyPath, 'falta startReady del auxiliar');
  assert.match(readyPath[1], /startReadyDiscovery\(normalizedService, 0\)/);

  const readyDiscovery = nearby.match(
    /private void startReadyDiscovery\(String normalizedService, int retryCount\) \{([\s\S]*?)\n    \}\n\n    private void handleReadyDiscoveryFailure/
  );
  assert.ok(readyDiscovery, 'falta discovery Nearby del auxiliar');
  assert.match(readyDiscovery[1], /client\.startDiscovery/);
  assert.match(readyDiscovery[1], /setStrategy\(STRATEGY\)/);
  assert.match(readyDiscovery[1], /setLowPower\(false\)/);
  assert.match(readyDiscovery[1], /emit\("ready"/);

  const leaderPath = nearby.match(
    /synchronized void startLeaderScan\(JSONObject input\) \{([\s\S]*?)\n    \}\n\n    private void startLeaderAdvertising/
  );
  assert.ok(leaderPath, 'falta startLeaderScan del encargado');
  assert.match(leaderPath[1], /startLeaderAdvertising\(nextAttemptId, serviceRequestId, timeoutMs, 0\)/);

  const leaderAdvertising = nearby.match(
    /private void startLeaderAdvertising\([\s\S]*?\) \{([\s\S]*?)\n    \}\n\n    private void handleLeaderAdvertisingFailure/
  );
  assert.ok(leaderAdvertising, 'falta advertising Nearby del encargado');
  assert.match(leaderAdvertising[1], /client\.startAdvertising/);
  assert.match(leaderAdvertising[1], /setLowPower\(false\)/);
  assert.match(leaderAdvertising[1], /ConnectionType\.NON_DISRUPTIVE/);
  assert.doesNotMatch(leaderAdvertising[1], /ConnectionType\.BALANCED/);
  assert.match(leaderAdvertising[1], /emitLeaderScanStarted/);

  assert.match(nearby, /onEndpointFound[\s\S]{0,1400}role != Role\.READY[\s\S]{0,1400}requestConnection/);
  assert.match(nearby, /onConnectionInitiated[\s\S]{0,1200}role == Role\.LEADER && requestedEndpoints\.add\(endpointId\)[\s\S]{0,300}endpoint_found/);
  assert.match(nearby, /role == Role\.LEADER[\s\S]{0,220}sendChallenge\(endpointId\)/);
  assert.match(nearby, /role == Role\.READY && "challenge"\.equals\(type\)[\s\S]{0,180}respondToChallenge/);
  assert.doesNotMatch(nearby, /android\.bluetooth\.le|BluetoothGatt|BluetoothLeAdvertiser|BluetoothLeScanner/);
});

test('auxiliar entra READY tras confirmación de discovery Nearby y no por foco del WebView', async () => {
  const [nativePresence, nearby] = await Promise.all([
    read('mobile/android/app/src/main/assets/native-presence.js'),
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
  ]);
  const startReady = nativePresence.match(/async function startReady\(\) \{([\s\S]*?)\n  \}\n\n  async function startLeaderScan/);
  const ensureReady = nativePresence.match(/async function ensureAuxiliaryReady\(forceRestart = false\) \{([\s\S]*?)\n  \}\n\n  async function startReady/);

  assert.ok(startReady, 'falta startReady');
  assert.ok(ensureReady, 'falta ensureAuxiliaryReady');
  assert.match(startReady[1], /activeMode = 'PREPARING'/);
  assert.match(startReady[1], /bridgeCall\('setReady'/);
  assert.doesNotMatch(startReady[1], /activeMode = 'READY'/);
  assert.match(nativePresence, /if \(type === 'ready'\)[\s\S]{0,220}activeMode = 'READY'/);
  assert.match(nativePresence, /Bluetooth listo\. Esperando la marcación del encargado\./);
  assert.match(ensureReady[1], /document\.visibilityState === 'hidden'/);
  assert.doesNotMatch(ensureReady[1], /document\.hasFocus/);
  assert.match(nearby, /client\.startDiscovery[\s\S]{0,900}addOnSuccessListener[\s\S]{0,500}emit\("ready"/);
  assert.match(nearby, /handleReadyDiscoveryFailure/);
});

test('cada marcación CREW genera una comprobación local nueva ligada al tipo de marca', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(nativePresence, /const MARK_TYPES = new Set\(\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\)/);
  assert.match(nativePresence, /async function startLeaderScan\(markType, automaticRetry = false\)/);
  assert.match(nativePresence, /challenge: `lorren-mark-v1:\$\{normalizedMark\}:\$\{randomToken\(32\)\}`/);
  assert.match(nativePresence, /bundle\.markType = attempt\.markType/);
  assert.match(nativePresence, /expectedAuxiliaryProofCount\(context, normalizedMark\)/);
  assert.match(nativePresence, /memberHasPersistedMark\(member, normalizedMark\)/);
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

test('auxiliar rearma una sola señal local al volver a primer plano', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(nativePresence, /function scheduleAuxiliaryRearm\(\)/);
  assert.match(nativePresence, /clearAuxiliaryRearm\(\)[\s\S]{0,220}ensureAuxiliaryReady\(true\)/);
  assert.match(nativePresence, /forceRestart && \['PREPARING', 'READY'\]\.includes\(activeMode\)[\s\S]{0,120}bridgeCall\('stopReady'\)[\s\S]{0,80}activeMode = 'IDLE'/);
  assert.match(nativePresence, /window\.addEventListener\('focus', scheduleAuxiliaryRearm\)/);
  assert.match(nativePresence, /visibilitychange[\s\S]{0,120}visibilityState === 'visible'[\s\S]{0,80}scheduleAuxiliaryRearm\(\)/);
});

test('scan con cero auxiliares reintenta antes de persistir y después falla cerrado', async () => {
  const [nearby, nativePresence, verifier] = await Promise.all([
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'),
    read('mobile/android/app/src/main/assets/native-presence.js'),
    read('src/modules/dispatch-attendance/application/crewPresenceCredential.js')
  ]);

  assert.match(nativePresence, /const DEFAULT_SCAN_MS = 6_000/);
  assert.match(nearby, /input\.optInt\("expectedProofCount", 0\)/);
  assert.match(nearby, /expectedProofCount > 0 && verifiedCount >= expectedProofCount[\s\S]{0,120}completeLeaderScan\(attemptId\)/);
  assert.match(nativePresence, /let autoRetryRemaining = 1;/);
  const zeroProofBranch = nativePresence.match(/if \(noAuxiliaryDetected\) \{([\s\S]*?)\n    \}\n\n    queueCompletedAttempt\(proofBundle\)/);
  assert.ok(zeroProofBranch, 'la rama cero-proof debe ocurrir antes de encolar');
  assert.match(zeroProofBranch[1], /startLeaderScan\(completionMarkType, true\)/);
  assert.match(zeroProofBranch[1], /no se guardó/);
  assert.doesNotMatch(zeroProofBranch[1], /queueCompletedAttempt/);
  assert.match(verifier, /hasAuxiliaryMembers[\s\S]{0,180}validatedWorkerIds\.length === 1[\s\S]{0,120}crew_presence_auxiliary_not_detected/);
});

test('scan parcial conserva subconjunto detectado y un único reintento de la misma marca', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(nativePresence, /retryNotDetectedCount = Math\.max\(0, completion\.expectedProofCount - queuedProofCount\)/);
  assert.match(nativePresence, /if \(incomplete && autoRetryRemaining > 0\)/);
  assert.match(nativePresence, /autoRetryRemaining -= 1/);
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

test('sin Internet encargado y auxiliares pueden completar la prueba local; la marca se encola y sincroniza después', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  const startReady = nativePresence.match(/async function startReady\(\) \{([\s\S]*?)\n  \}\n\n  async function startLeaderScan/);
  const startLeaderScan = nativePresence.match(/async function startLeaderScan\(markType, automaticRetry = false\) \{([\s\S]*?)\n  \}\n\n  function stopNativeModes/);
  const queueCompletedAttempt = nativePresence.match(/async function queueCompletedAttempt\(proofBundle\) \{([\s\S]*?)\n  \}\n\n  function finishCompletedScan/);

  assert.ok(startReady, 'falta startReady del auxiliar');
  assert.ok(startLeaderScan, 'falta startLeaderScan del encargado');
  assert.ok(queueCompletedAttempt, 'falta queueCompletedAttempt');
  assert.match(startReady[1], /navigator\.onLine && !credentialPrepared\(\)[\s\S]{0,80}provisionCredential\(\)/);
  assert.doesNotMatch(startReady[1], /if \(!navigator\.onLine\)[\s\S]{0,120}return/);
  assert.match(startLeaderScan[1], /navigator\.onLine && !credentialPrepared\(\)[\s\S]{0,80}provisionCredential\(\)/);
  assert.doesNotMatch(startLeaderScan[1], /if \(!navigator\.onLine\)[\s\S]{0,120}return/);
  assert.match(queueCompletedAttempt[1], /offline\.queueCrewPresence/);
  assert.match(queueCompletedAttempt[1], /if \(navigator\.onLine && typeof offline\.syncNow === 'function'\) offline\.syncNow\(\)/);
  assert.match(nativePresence, /if \(!navigator\.onLine\) return readCachedContexts\(\);/);
  assert.match(nativePresence, /if \(!navigator\.onLine\) return credentialPrepared\(\);/);
  assert.match(nativePresence, /guardada sin conexión; pendiente de sincronizar cuando vuelva Internet/);
});

test('online no avanza por una marca solamente encolada y espera confirmación server-side', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(nativePresence, /function optimisticOfflineActions\(context\) \{\s*if \(navigator\.onLine\) return null;/);
  assert.match(nativePresence, /function onlineQueuedMarkType\(context\)/);
  assert.match(nativePresence, /if \(onlineQueuedMarkType\(context\)\) return \[\];/);
  assert.match(nativePresence, /enviada · esperando confirmación del servidor/);
  assert.match(nativePresence, /forgetQueuedMark\(serviceRequestId, markType\)/);
  assert.match(nativePresence, /if \(navigator\.onLine\) contexts = await loadContexts\(\)/);
  assert.match(nativePresence, /window\.location\.reload\(\)/);
});

test('panel de cuadrilla diferencia la próxima detección del historial confirmado', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(nativePresence, /function safeAttendance\(value\)/);
  assert.match(nativePresence, /function memberHasPersistedMark\(member, markType\)/);
  assert.match(nativePresence, /function appendMemberHistory\(copy, member\)/);
  assert.match(nativePresence, /\$\{markInfo\(markType\)\.title\} · \$\{time\}/);
  assert.match(nativePresence, /Por detectar · \$\{markInfo\(markType\)\.noun\}/);
});

test('interfaz retira textos internos solicitados sin desactivar anti-spoof', async () => {
  const [nativePresence, biometricMobile] = await Promise.all([
    read('mobile/android/app/src/main/assets/native-presence.js'),
    read('src/public/worker-biometric-mobile.js')
  ]);

  assert.doesNotMatch(nativePresence, /Cada marcación comprueba localmente a los auxiliares presentes/);
  assert.doesNotMatch(biometricMobile, /Validando que sea un rostro real/);
  assert.match(biometricMobile, /scores\.realScore < MIN_REAL_SCORE/);
});

test('contexto de cuadrilla proyecta las cuatro horas persistidas por integrante', async () => {
  let assignmentQuery;
  const serviceCreatedAt = new Date('2026-08-21T12:00:00.000Z');
  const prisma = {
    dispatchAssignment: {
      async findMany(query) {
        assignmentQuery = query;
        return [{
          id: 'TEST-ASSIGNMENT-LEADER',
          workerId: 'TEST-WORKER-LEADER',
          serviceRequest: {
            id: 'TEST-SERVICE-CREW',
            operationPointId: 'TEST-OPERATION',
            operationPointName: 'Operación de prueba',
            serviceDate: new Date('2026-08-21T00:00:00.000Z'),
            startTime: '08:00',
            endTime: '17:00',
            createdAt: serviceCreatedAt,
            operationPoint: { id: 'TEST-OPERATION', isActive: true, attendanceEnabled: true },
            assignments: [
              {
                id: 'TEST-ASSIGNMENT-LEADER',
                workerId: 'TEST-WORKER-LEADER',
                worker: { fullName: 'Encargado Prueba' },
                attendanceSession: {
                  arrivalReportedAt: new Date('2026-08-21T13:01:00.000Z'),
                  departureReportedAt: new Date('2026-08-21T22:03:00.000Z'),
                  marks: [
                    { markType: 'BREAK_START', clientCapturedAt: new Date('2026-08-21T17:02:00.000Z'), serverReceivedAt: new Date('2026-08-21T17:02:03.000Z') },
                    { markType: 'BREAK_END', clientCapturedAt: new Date('2026-08-21T18:01:00.000Z'), serverReceivedAt: new Date('2026-08-21T18:01:02.000Z') }
                  ]
                }
              },
              {
                id: 'TEST-ASSIGNMENT-A',
                workerId: 'TEST-WORKER-A',
                worker: { fullName: 'Auxiliar Prueba' },
                attendanceSession: {
                  arrivalReportedAt: new Date('2026-08-21T13:01:30.000Z'),
                  departureReportedAt: null,
                  marks: []
                }
              }
            ]
          }
        }];
      }
    },
    devAuditEvent: {
      async findMany(query) {
        if (query.where.entityType === 'DISPATCH_CREW_ATTENDANCE_SERVICE') {
          return [{
            entityId: 'TEST-SERVICE-CREW',
            createdAt: new Date('2026-08-21T12:01:00.000Z'),
            metadata: { mode: 'CREW', crewLeaderWorkerId: 'TEST-WORKER-LEADER' }
          }];
        }
        return [{
          entityId: 'TEST-OPERATION',
          createdAt: new Date('2026-08-21T11:00:00.000Z'),
          metadata: { allowed: true }
        }];
      }
    }
  };

  const [context] = await loadCrewAttendancePortalContexts(prisma, { workerId: 'TEST-WORKER-LEADER' });
  const leader = context.members.find((member) => member.workerId === 'TEST-WORKER-LEADER');
  const auxiliary = context.members.find((member) => member.workerId === 'TEST-WORKER-A');

  assert.equal(assignmentQuery.select.serviceRequest.select.assignments.select.attendanceSession.select.departureReportedAt, true);
  assert.deepEqual(assignmentQuery.select.serviceRequest.select.assignments.select.attendanceSession.select.marks.where.markType.in, ['BREAK_START', 'BREAK_END']);
  assert.deepEqual(leader.attendance, {
    arrivalAt: '2026-08-21T13:01:00.000Z',
    breakStartAt: '2026-08-21T17:02:00.000Z',
    breakEndAt: '2026-08-21T18:01:00.000Z',
    departureAt: '2026-08-21T22:03:00.000Z'
  });
  assert.deepEqual(auxiliary.attendance, {
    arrivalAt: '2026-08-21T13:01:30.000Z',
    breakStartAt: null,
    breakEndAt: null,
    departureAt: null
  });
});

test('tarjeta de cada trabajador muestra las cuatro marcaciones persistidas con hora', async () => {
  const view = await read('src/views/workerPortal.ejs');

  assert.match(view, /Marcaciones registradas/);
  assert.match(view, /data-assignment-history-mark="ARRIVAL"[\s\S]{0,180}assignment\.arrivalReportedLabel/);
  assert.match(view, /data-assignment-history-mark="BREAK_START"[\s\S]{0,180}assignment\.breakStartLabel/);
  assert.match(view, /data-assignment-history-mark="BREAK_END"[\s\S]{0,180}assignment\.breakEndReportedLabel/);
  assert.match(view, /data-assignment-history-mark="DEPARTURE"[\s\S]{0,180}assignment\.departureReportedLabel/);
  assert.match(view, /Sin registrar/);
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
