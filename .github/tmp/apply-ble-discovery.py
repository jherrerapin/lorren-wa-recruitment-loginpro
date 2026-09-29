from pathlib import Path

root = Path('.')


def replace(path, old, new):
    p = root / path
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'pattern not found in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))

# MainActivity: purge interactive Classic discoverability.
path = 'mobile/android/app/src/main/java/com/loginpro/lorren/portal/MainActivity.java'
replace(path, '    private static final int REQUEST_BLUETOOTH_DISCOVERABLE = 4107;\n    private static final int BLUETOOTH_DISCOVERABLE_SECONDS = 300;\n', '')
replace(path, '    private boolean bluetoothDiscoverableRequested;\n', '')
replace(path, '''    boolean ensureNearbyDiscoverable() {
        BluetoothAdapter adapter = bluetoothAdapter();
        if (adapter == null) return false;
        try {
            if (adapter.getScanMode() == BluetoothAdapter.SCAN_MODE_CONNECTABLE_DISCOVERABLE) return true;
        } catch (SecurityException error) {
            ensureNearbyPermissions();
            return false;
        }
        requestBluetoothDiscoverable();
        return false;
    }

    boolean refreshNearbyDiscoverableWindow() {
        if (!nearbyTransportPermissionsGranted()) {
            ensureNearbyPermissions();
            return false;
        }
        if (bluetoothDiscoverableRequested || systemPromptInFlight) return false;
        runOnUiThread(this::requestBluetoothDiscoverable);
        return true;
    }

''', '')
replace(path, '''    private void requestBluetoothDiscoverable() {
        if (bluetoothDiscoverableRequested) return;
        bluetoothDiscoverableRequested = true;
        systemPromptInFlight = true;
        try {
            Intent request = new Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE);
            request.putExtra(
                BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION,
                BLUETOOTH_DISCOVERABLE_SECONDS
            );
            startActivityForResult(request, REQUEST_BLUETOOTH_DISCOVERABLE);
        } catch (Exception error) {
            bluetoothDiscoverableRequested = false;
            systemPromptInFlight = false;
            if (presenceBridge != null) presenceBridge.onBluetoothDiscoverableResult(false);
        }
    }

''', '')
replace(path, '''        if (requestCode == REQUEST_BLUETOOTH_DISCOVERABLE) {
            systemPromptInFlight = false;
            bluetoothDiscoverableRequested = false;
            if (presenceBridge != null) presenceBridge.onBluetoothDiscoverableResult(resultCode > 0);
            return;
        }
        if (requestCode != REQUEST_ENABLE_BLUETOOTH) return;
''', '''        if (requestCode != REQUEST_ENABLE_BLUETOOTH) return;
''')

# PresenceBridge: READY starts silently; no pending discoverability handshake.
path = 'mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java'
replace(path, '    private String pendingReadyServiceRequestId = "";\n', '')
replace(path, '''    @JavascriptInterface
    public String setReady(String serviceRequestId) {
        if (!hasUsablePresenceCredential()) return jsonError("native_presence_credential_required");
        if (!activity.ensureNearbyPermissions()) return jsonError("permissions_pending");
        String readinessError = activity.ensureNearbyRadioReady();
        if (readinessError != null) return jsonError(readinessError);
        try {
            String normalizedServiceRequestId = requiredToken(serviceRequestId, "serviceRequestId");
            synchronized (this) {
                pendingReadyServiceRequestId = normalizedServiceRequestId;
            }
            if (!activity.ensureNearbyDiscoverable()) return jsonOk();
            synchronized (this) {
                pendingReadyServiceRequestId = "";
            }
            manager.startReady(normalizedServiceRequestId);
            return jsonOk();
        } catch (Exception error) {
            synchronized (this) {
                pendingReadyServiceRequestId = "";
            }
            return jsonError(handleBluetoothStartFailure("auxiliary_ready", error));
        }
    }

    void onBluetoothDiscoverableResult(boolean granted) {
        String serviceRequestId;
        synchronized (this) {
            serviceRequestId = pendingReadyServiceRequestId;
            pendingReadyServiceRequestId = "";
        }
        if (serviceRequestId.isEmpty()) return;
        if (!granted) {
            emitBluetoothUnavailable("auxiliary_discovery", null);
            return;
        }
        if (!hasUsablePresenceCredential()) {
            emitPresenceError("native_presence_credential_required");
            return;
        }
        if (!activity.ensureNearbyPermissions()) return;
        String readinessError = activity.ensureNearbyRadioReady();
        if (readinessError != null) {
            emitPresenceError(readinessError);
            return;
        }
        try {
            manager.startReady(serviceRequestId);
        } catch (Exception error) {
            handleBluetoothStartFailure("auxiliary_ready", error);
        }
    }

''', '''    @JavascriptInterface
    public String setReady(String serviceRequestId) {
        if (!hasUsablePresenceCredential()) return jsonError("native_presence_credential_required");
        if (!activity.ensureNearbyPermissions()) return jsonError("permissions_pending");
        String readinessError = activity.ensureNearbyRadioReady();
        if (readinessError != null) return jsonError(readinessError);
        try {
            manager.startReady(requiredToken(serviceRequestId, "serviceRequestId"));
            return jsonOk();
        } catch (Exception error) {
            return jsonError(handleBluetoothStartFailure("auxiliary_ready", error));
        }
    }

''')
replace(path, '''    @JavascriptInterface
    public String stopReady() {
        synchronized (this) {
            pendingReadyServiceRequestId = "";
        }
        manager.stopReady();
        return jsonOk();
    }
''', '''    @JavascriptInterface
    public String stopReady() {
        manager.stopReady();
        return jsonOk();
    }
''')
replace(path, '''    void shutdown() {
        synchronized (this) {
            pendingReadyServiceRequestId = "";
        }
        cancelPendingLocation();
        manager.shutdown();
    }
''', '''    void shutdown() {
        cancelPendingLocation();
        manager.shutdown();
    }
''')

# NearbyPresenceManager: BLE advertises/discovers; RFCOMM remains the proof transport.
path = 'mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'
p = root / path
text = p.read_text()
text = text.replace('import android.bluetooth.BluetoothSocket;\n', '''import android.bluetooth.BluetoothSocket;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
''', 1)
text = text.replace('import java.util.ArrayList;\n', 'import java.util.ArrayList;\nimport java.util.Collections;\n', 1)
text = text.replace(''' * La prueba local usa Bluetooth Classic RFCOMM/SDP de extremo a extremo para no
 * depender de Wi-Fi, WAN ni de Google Nearby durante el intercambio local. Antes
''', ''' * La presencia local usa BLE únicamente para descubrimiento silencioso por UUID y
 * Bluetooth Classic RFCOMM para el intercambio challenge/proof. Antes
''', 1)
text = text.replace('''    private static final long DISCOVERY_RESTART_DELAY_MS = 1_500L;
    private static final long DISCOVERABILITY_REFRESH_MS = 240_000L;
    private static final long DISCOVERABILITY_RETRY_MS = 15_000L;
''', '''    private static final long DISCOVERY_RESTART_DELAY_MS = 1_500L;
''', 1)
text = text.replace('''    private Runnable auxiliaryExchangeTimeout;
    private Runnable auxiliaryDiscoverabilityRefresh;

    // ENC: discovery Classic + SDP + conexiones RFCOMM de una marcación.
''', '''    private Runnable auxiliaryExchangeTimeout;
    private BluetoothLeAdvertiser auxiliaryAdvertiser;
    private AdvertiseCallback auxiliaryAdvertiseCallback;

    // ENC: BLE scan filtrado por UUID + conexiones RFCOMM de una marcación.
''', 1)
text = text.replace('''    private Runnable leaderDiscoveryRestart;
    private int leaderDiscoveryBurst = 0;
''', '''    private Runnable leaderDiscoveryRestart;
    private int leaderDiscoveryBurst = 0;
    private BluetoothLeScanner leaderBleScanner;
    private ScanCallback leaderBleScanCallback;
''', 1)
old = '''    synchronized void startReady(String serviceRequestId) {
        String normalizedService = requiredToken(serviceRequestId, "serviceRequestId");
        ensureNearbyTransportPermissions();
        stopAllInternal(false);
        if (!supportsBleAdvertising()) {
            emitBluetoothUnavailable(
                "AUX",
                "auxiliary_advertising",
                null,
                "advertising_unsupported"
            );
            throw new IllegalStateException("advertising_unsupported");
        }
        role = Role.READY;
        activity.setPresenceKeepScreenOn(true);
        readyServiceRequestId = normalizedService;
        emitDiagnostic("AUX", "READY_REQUESTED");
        startAuxiliaryServer();
    }

    private synchronized void startAuxiliaryServer() {
        if (role != Role.READY || bluetoothAdapter == null) {
            failReadyBluetooth("auxiliary_ready", null);
            return;
        }
        try {
            ensureNearbyTransportPermissions();
            if (bluetoothAdapter.getScanMode() != BluetoothAdapter.SCAN_MODE_CONNECTABLE_DISCOVERABLE) {
                emitDiagnostic("AUX", "DISCOVERABLE_NOT_READY");
                failReadyBluetooth("auxiliary_discovery", null);
                return;
            }
        } catch (SecurityException error) {
            failReadyPermissions("auxiliary_discovery", error);
            return;
        } catch (RuntimeException error) {
            failReadyBluetooth("auxiliary_discovery", error);
            return;
        }
        emitDiagnostic("AUX", "DISCOVERABLE_CONFIRMED");
        if (auxiliaryServerSocket != null) {
            scheduleAuxiliaryDiscoverabilityRefresh(DISCOVERABILITY_REFRESH_MS);
            emitReady();
            return;
        }
        emitDiagnostic("AUX", "RFCOMM_SERVER_START");
        try {
            ensureNearbyTransportPermissions();
            auxiliaryServerSocket = bluetoothAdapter.listenUsingInsecureRfcommWithServiceRecord(
                SERVICE_NAME,
                SERVICE_UUID
            );
        } catch (SecurityException error) {
            failReadyPermissions("auxiliary_advertising", error);
            return;
        } catch (IOException | RuntimeException error) {
            failReadyBluetooth("auxiliary_advertising", error);
            return;
        }
        if (auxiliaryServerSocket == null) {
            failReadyBluetooth("auxiliary_advertising", null);
            return;
        }
        emitDiagnostic("AUX", "RFCOMM_SERVER_READY");
        scheduleAuxiliaryDiscoverabilityRefresh(DISCOVERABILITY_REFRESH_MS);
        emitReady();
        startAuxiliaryAcceptLoop(auxiliaryServerSocket);
    }

    private synchronized void scheduleAuxiliaryDiscoverabilityRefresh(long delayMs) {
        cancelAuxiliaryDiscoverabilityRefresh();
        auxiliaryDiscoverabilityRefresh = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.READY || auxiliaryServerSocket == null) return;
                emitDiagnostic("AUX", "DISCOVERABLE_REFRESH_REQUESTED");
            }
            boolean requested = activity.refreshNearbyDiscoverableWindow();
            synchronized (NearbyPresenceManager.this) {
                if (role == Role.READY && auxiliaryServerSocket != null) {
                    scheduleAuxiliaryDiscoverabilityRefresh(
                        requested ? DISCOVERABILITY_REFRESH_MS : DISCOVERABILITY_RETRY_MS
                    );
                }
            }
        };
        handler.postDelayed(auxiliaryDiscoverabilityRefresh, delayMs);
    }

    private synchronized void cancelAuxiliaryDiscoverabilityRefresh() {
        if (auxiliaryDiscoverabilityRefresh != null) {
            handler.removeCallbacks(auxiliaryDiscoverabilityRefresh);
        }
        auxiliaryDiscoverabilityRefresh = null;
    }
'''
new = '''    synchronized void startReady(String serviceRequestId) {
        String normalizedService = requiredToken(serviceRequestId, "serviceRequestId");
        ensureNearbyTransportPermissions();
        stopAllInternal(false);
        if (!supportsBleAdvertising()) {
            emitBluetoothUnavailable(
                "AUX",
                "auxiliary_ble_advertising",
                null,
                "advertising_unsupported"
            );
            throw new IllegalStateException("advertising_unsupported");
        }
        role = Role.READY;
        activity.setPresenceKeepScreenOn(true);
        readyServiceRequestId = normalizedService;
        emitDiagnostic("AUX", "READY_REQUESTED");
        startAuxiliaryServer();
    }

    private synchronized void startAuxiliaryServer() {
        if (role != Role.READY || bluetoothAdapter == null) {
            failReadyBluetooth("auxiliary_ready", null);
            return;
        }
        if (auxiliaryServerSocket != null) {
            startAuxiliaryBleAdvertising();
            return;
        }
        emitDiagnostic("AUX", "RFCOMM_SERVER_START");
        try {
            ensureNearbyTransportPermissions();
            auxiliaryServerSocket = bluetoothAdapter.listenUsingInsecureRfcommWithServiceRecord(
                SERVICE_NAME,
                SERVICE_UUID
            );
        } catch (SecurityException error) {
            failReadyPermissions("auxiliary_rfcomm_server", error);
            return;
        } catch (IOException | RuntimeException error) {
            failReadyBluetooth("auxiliary_rfcomm_server", error);
            return;
        }
        if (auxiliaryServerSocket == null) {
            failReadyBluetooth("auxiliary_rfcomm_server", null);
            return;
        }
        emitDiagnostic("AUX", "RFCOMM_SERVER_READY");
        startAuxiliaryAcceptLoop(auxiliaryServerSocket);
        startAuxiliaryBleAdvertising();
    }

    private synchronized void startAuxiliaryBleAdvertising() {
        if (role != Role.READY || auxiliaryServerSocket == null || bluetoothAdapter == null) return;
        if (auxiliaryAdvertiseCallback != null) return;
        try {
            ensureNearbyTransportPermissions();
            BluetoothLeAdvertiser advertiser = bluetoothAdapter.getBluetoothLeAdvertiser();
            if (advertiser == null) {
                failReadyBluetooth("auxiliary_ble_advertising", null);
                return;
            }

            AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)
                .setTimeout(0)
                .build();
            AdvertiseData data = new AdvertiseData.Builder()
                .addServiceUuid(SERVICE_PARCEL_UUID)
                .setIncludeDeviceName(false)
                .build();

            AdvertiseCallback callback = new AdvertiseCallback() {
                @Override
                public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                    synchronized (NearbyPresenceManager.this) {
                        if (role != Role.READY || auxiliaryAdvertiseCallback != this) return;
                        emitDiagnostic("AUX", "BLE_ADVERTISING_READY");
                        emitReady();
                    }
                }

                @Override
                public void onStartFailure(int errorCode) {
                    synchronized (NearbyPresenceManager.this) {
                        if (role != Role.READY || auxiliaryAdvertiseCallback != this) return;
                        auxiliaryAdvertiseCallback = null;
                        auxiliaryAdvertiser = null;
                        emitDiagnostic("AUX", "BLE_ADVERTISING_FAILED");
                        failReadyBluetooth("auxiliary_ble_advertising", null);
                    }
                }
            };

            auxiliaryAdvertiser = advertiser;
            auxiliaryAdvertiseCallback = callback;
            emitDiagnostic("AUX", "BLE_ADVERTISING_START");
            advertiser.startAdvertising(settings, data, callback);
        } catch (SecurityException error) {
            failReadyPermissions("auxiliary_ble_advertising", error);
        } catch (RuntimeException error) {
            failReadyBluetooth("auxiliary_ble_advertising", error);
        }
    }

    private synchronized void stopAuxiliaryBleAdvertising() {
        BluetoothLeAdvertiser advertiser = auxiliaryAdvertiser;
        AdvertiseCallback callback = auxiliaryAdvertiseCallback;
        auxiliaryAdvertiser = null;
        auxiliaryAdvertiseCallback = null;
        if (advertiser == null || callback == null) return;
        try {
            advertiser.stopAdvertising(callback);
        } catch (SecurityException ignored) {
        } catch (RuntimeException ignored) {
        }
    }
'''
if old not in text:
    raise SystemExit('auxiliary block not found')
text = text.replace(old, new, 1)
text = text.replace('''        stopAllInternal(false);
        if (!supportsBleAdvertising()) {
            emitBluetoothUnavailable(
                "ENC",
                "leader_advertising",
                null,
                "advertising_unsupported"
            );
            throw new IllegalStateException("advertising_unsupported");
        }
        role = Role.LEADER;
''', '''        stopAllInternal(false);
        if (!supportsBleScan()) {
            emitBluetoothUnavailable("ENC", "leader_ble_scan", null, "bluetooth_unavailable");
            throw new IllegalStateException("bluetooth_unavailable");
        }
        role = Role.LEADER;
''', 1)
old = '''            ensureNearbyTransportPermissions();
            registerLeaderReceiver();
            if (bluetoothAdapter.isDiscovering()) bluetoothAdapter.cancelDiscovery();

            Set<BluetoothDevice> bonded = bluetoothAdapter.getBondedDevices();
            if (bonded != null) {
                for (BluetoothDevice dev : bonded) {
                    rememberDiscoveredDevice(dev);
                }
            }

            challengeSentAt = System.currentTimeMillis();
            emitLeaderScanStarted();
            scheduleLeaderTimeout(nextAttemptId, timeoutMs);
            if (!startLeaderDiscoveryBurst(nextAttemptId)) {
                failLeaderBluetooth("leader_discovery", null);
                return;
            }
'''
new = '''            ensureNearbyTransportPermissions();
            challengeSentAt = System.currentTimeMillis();
            emitLeaderScanStarted();
            scheduleLeaderTimeout(nextAttemptId, timeoutMs);
            if (!startLeaderBleScan(nextAttemptId)) {
                failLeaderBluetooth("leader_ble_scan", null);
                return;
            }
'''
if old not in text:
    raise SystemExit('leader start block not found')
text = text.replace(old, new, 1)
anchor = '    private final BroadcastReceiver leaderDiscoveryReceiver = new BroadcastReceiver() {'
idx = text.find(anchor)
if idx < 0:
    raise SystemExit('leader receiver anchor not found')
ble_method = '''    private synchronized boolean startLeaderBleScan(String currentAttemptId) {
        if (role != Role.LEADER || !attemptId.equals(currentAttemptId) || bluetoothAdapter == null) {
            return false;
        }
        try {
            ensureNearbyTransportPermissions();
            BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
            if (scanner == null) return false;

            ScanFilter filter = new ScanFilter.Builder()
                .setServiceUuid(SERVICE_PARCEL_UUID)
                .build();
            ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

            ScanCallback callback = new ScanCallback() {
                @Override
                public void onScanResult(int callbackType, ScanResult result) {
                    BluetoothDevice device = result == null ? null : result.getDevice();
                    synchronized (NearbyPresenceManager.this) {
                        if (role != Role.LEADER || leaderBleScanCallback != this) return;
                        emitDiagnostic("ENC", "BLE_SERVICE_FOUND");
                    }
                    if (device != null) connectLeaderToAuxiliary(device);
                }

                @Override
                public void onBatchScanResults(List<ScanResult> results) {
                    if (results == null) return;
                    for (ScanResult result : results) onScanResult(0, result);
                }

                @Override
                public void onScanFailed(int errorCode) {
                    synchronized (NearbyPresenceManager.this) {
                        if (role != Role.LEADER || leaderBleScanCallback != this) return;
                        emitDiagnostic("ENC", "BLE_SCAN_FAILED");
                        failLeaderBluetooth("leader_ble_scan", null);
                    }
                }
            };

            leaderBleScanner = scanner;
            leaderBleScanCallback = callback;
            emitDiagnostic("ENC", "BLE_SCAN_START");
            scanner.startScan(Collections.singletonList(filter), settings, callback);
            return true;
        } catch (SecurityException error) {
            failLeaderPermissions("leader_ble_scan", error);
            return false;
        } catch (RuntimeException error) {
            failLeaderBluetooth("leader_ble_scan", error);
            return false;
        }
    }

'''
text = text[:idx] + ble_method + text[idx:]
text = text.replace('''    private synchronized void stopReadyRuntime() {
        cancelAuxiliaryDiscoverabilityRefresh();
        closeAuxiliarySocket();
''', '''    private synchronized void stopReadyRuntime() {
        stopAuxiliaryBleAdvertising();
        closeAuxiliarySocket();
''', 1)
text = text.replace('''    private synchronized void stopLeaderDiscovery() {
        cancelLeaderInquiryCheckpoint();
        if (bluetoothAdapter != null) {
''', '''    private synchronized void stopLeaderDiscovery() {
        cancelLeaderInquiryCheckpoint();
        BluetoothLeScanner scanner = leaderBleScanner;
        ScanCallback callback = leaderBleScanCallback;
        leaderBleScanner = null;
        leaderBleScanCallback = null;
        if (scanner != null && callback != null) {
            try {
                scanner.stopScan(callback);
            } catch (SecurityException ignored) {
            } catch (RuntimeException ignored) {
            }
        }
        if (bluetoothAdapter != null) {
''', 1)
insert_before = '    private boolean supportsBleAdvertising() {'
idx = text.find(insert_before)
if idx < 0:
    raise SystemExit('supportsBleAdvertising anchor not found')
text = text[:idx] + '''    private boolean supportsBleScan() {
        if (bluetoothAdapter == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return false;
        if (!appContext.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return false;
        try {
            ensureNearbyTransportPermissions();
            return bluetoothAdapter.getBluetoothLeScanner() != null;
        } catch (SecurityException error) {
            throw error;
        } catch (RuntimeException error) {
            return false;
        }
    }

''' + text[idx:]
p.write_text(text)

# Update focused regression to the hybrid BLE-discovery/RFCOMM contract.
path = 'test/workerPortalAndroidRfcommResilience.test.js'
p = root / path
p.write_text('''import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(path, 'utf8');

test('auxiliar anuncia silenciosamente SERVICE_UUID por BLE y conserva RFCOMM', async () => {
  const [activity, bridge, manager] = await Promise.all([
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/MainActivity.java'),
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java'),
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
  ]);

  assert.doesNotMatch(activity, /ACTION_REQUEST_DISCOVERABLE|BLUETOOTH_DISCOVERABLE_SECONDS/);
  assert.doesNotMatch(bridge, /ensureNearbyDiscoverable|onBluetoothDiscoverableResult/);
  assert.match(activity, /Manifest\\.permission\\.BLUETOOTH_ADVERTISE/);
  assert.match(manager, /BluetoothLeAdvertiser/);
  assert.match(manager, /addServiceUuid\\(SERVICE_PARCEL_UUID\\)/);
  assert.match(manager, /advertiser\\.startAdvertising\\(settings, data, callback\\)/);
  assert.match(manager, /listenUsingInsecureRfcommWithServiceRecord[\\s\\S]{0,120}SERVICE_UUID/);
  assert.match(manager, /setPresenceKeepScreenOn\\(true\\)/);
});

test('líder descubre por BLE filtrado por SERVICE_UUID y conecta challenge-proof por RFCOMM', async () => {
  const manager = await read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java');

  assert.match(manager, /BluetoothLeScanner/);
  assert.match(manager, /new ScanFilter\\.Builder\\(\\)[\\s\\S]{0,120}setServiceUuid\\(SERVICE_PARCEL_UUID\\)/);
  assert.match(manager, /ScanSettings\\.SCAN_MODE_LOW_LATENCY/);
  assert.match(manager, /scanner\\.startScan\\(Collections\\.singletonList\\(filter\\), settings, callback\\)/);
  assert.match(manager, /startLeaderBleScan\\(nextAttemptId\\)/);
  assert.match(manager, /BLE_SERVICE_FOUND/);
  assert.match(manager, /createInsecureRfcommSocketToServiceRecord\\(SERVICE_UUID\\)/);
  assert.match(manager, /payload\\.put\\("type", "challenge"\\)/);
  assert.match(manager, /PROOF_VERIFIED/);
});

test('frontend conserva dos reintentos completos y fallback manual', async () => {
  const source = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(source, /const MAX_SCAN_RETRIES = 2/);
  assert.match(source, /let scanRetries = 0/);
  assert.doesNotMatch(source, /autoRetryRemaining/);
  assert.match(source, /scanRetries < MAX_SCAN_RETRIES/);
  assert.match(source, /BLUETOOTH_SCAN_RETRY/);
  assert.match(source, /startLeaderScan\\(completionMarkType, true\\)/);
  assert.match(source, /reason: 'scan_retries_exhausted'/);
  assert.match(source, /bluetoothFallbackActive = true/);
});
''')
