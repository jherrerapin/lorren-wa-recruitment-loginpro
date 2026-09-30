package com.loginpro.lorren.portal;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Autoridad nativa única de presencia local de cuadrilla.
 *
 * La presencia local usa BLE únicamente para descubrimiento silencioso por UUID y
 * Bluetooth Classic RFCOMM para el intercambio challenge/proof. Antes
 * de tocar el stack Bluetooth se validan los permisos modernos que Android exige;
 * si falta alguno se solicita desde MainActivity y la operación no continúa hasta
 * que Android resuelva el permiso. Esta clase transporta y verifica challenge/proof;
 * no escribe asistencia.
 */
final class NearbyPresenceManager {
    interface EventSink {
        void emit(JSONObject event);
    }

    interface CredentialProvider {
        String credential();
    }

    private static final UUID SERVICE_UUID = UUID.fromString("6f727265-6e2d-4352-4557-505245530001");
    private static final String SERVICE_NAME = "LORREN_CREW_PRESENCE";
    private static final ParcelUuid SERVICE_PARCEL_UUID = new ParcelUuid(SERVICE_UUID);

    // BLE descubre auxiliares de forma inmediata por UUID; RFCOMM conserva
    // el intercambio challenge/proof y la ventana termina al completar proofs.
    private static final long MIN_SCAN_MS = 35_000L;
    private static final long MAX_SCAN_MS = 45_000L;
    private static final long CONNECTION_GRACE_MS = 1_500L;
    private static final long RFCOMM_EXCHANGE_TIMEOUT_MS = 12_000L;
    private static final int MAX_MESSAGE_BYTES = 16_384;

    // 8029 apareció en la implementación histórica basada en Google Nearby y
    // representa un fallo de permisos, no un fallo físico de discovery Bluetooth.
    private static final int MISSING_PERMISSION_NEARBY_WIFI_DEVICES_STATUS = 8029;
    private static final Pattern BLUETOOTH_STATUS_PATTERN = Pattern.compile(
        "(?i)status(?:code)?\\s*[=:]?\\s*(\\d{3,5})"
    );

    private enum Role { IDLE, READY, LEADER }

    private final MainActivity activity;
    private final Context appContext;
    private final BluetoothAdapter bluetoothAdapter;
    private final EventSink eventSink;
    private final CredentialProvider credentialProvider;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private Role role = Role.IDLE;

    // AUX: servidor RFCOMM persistente mientras READY.
    private String readyServiceRequestId = "";
    private BluetoothServerSocket auxiliaryServerSocket;
    private BluetoothSocket auxiliarySocket;
    private Thread auxiliaryAcceptThread;
    private Thread auxiliaryExchangeThread;
    private Runnable auxiliaryExchangeTimeout;
    private BluetoothLeAdvertiser auxiliaryAdvertiser;
    private AdvertiseCallback auxiliaryAdvertiseCallback;

    // ENC: BLE scan filtrado por UUID + conexiones RFCOMM de una marcación.
    private String attemptId = "";
    private String scanServiceRequestId = "";
    private String challenge = "";
    private long challengeSentAt = 0L;
    private int expectedProofCount = 0;
    private long leaderTimeoutMs = MIN_SCAN_MS;
    private final Map<String, JSONObject> proofsByKey = new LinkedHashMap<>();
    private final Set<String> leaderConnectionAddresses = new LinkedHashSet<>();
    private final Map<String, BluetoothSocket> leaderSockets = new LinkedHashMap<>();
    private final Map<String, Runnable> leaderSocketTimeouts = new LinkedHashMap<>();
    private Runnable leaderTimeout;
    private Runnable leaderCompleteTimeout;
    private BluetoothLeScanner leaderBleScanner;
    private ScanCallback leaderBleScanCallback;

    NearbyPresenceManager(MainActivity activity, EventSink eventSink, CredentialProvider credentialProvider) {
        this.activity = activity;
        this.appContext = activity.getApplicationContext();
        this.bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
        this.eventSink = eventSink;
        this.credentialProvider = credentialProvider;
    }

    synchronized void startReady(String serviceRequestId) {
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

    private synchronized void emitReady() {
        String serviceRequestId = readyServiceRequestId;
        emit("ready", event -> event.put("serviceRequestId", serviceRequestId));
    }

    private void startAuxiliaryAcceptLoop(BluetoothServerSocket serverSocket) {
        Thread thread = new Thread(() -> {
            while (true) {
                synchronized (NearbyPresenceManager.this) {
                    if (role != Role.READY || auxiliaryServerSocket != serverSocket) return;
                }
                BluetoothSocket socket;
                try {
                    socket = serverSocket.accept();
                } catch (SecurityException error) {
                    synchronized (NearbyPresenceManager.this) {
                        if (role == Role.READY && auxiliaryServerSocket == serverSocket) {
                            failReadyPermissions("auxiliary_accept", error);
                        }
                    }
                    return;
                } catch (IOException error) {
                    synchronized (NearbyPresenceManager.this) {
                        if (role == Role.READY && auxiliaryServerSocket == serverSocket) {
                            emitDiagnostic("AUX", "RFCOMM_ACCEPT_FAILED");
                            failReady("connection_failed");
                        }
                    }
                    return;
                }
                if (socket == null) continue;
                acceptAuxiliaryConnection(socket);
            }
        }, "lorren-crew-rfcomm-accept");
        thread.setDaemon(true);
        synchronized (this) {
            auxiliaryAcceptThread = thread;
        }
        thread.start();
    }

    private synchronized void acceptAuxiliaryConnection(BluetoothSocket socket) {
        if (role != Role.READY || auxiliaryServerSocket == null) {
            closeSocket(socket);
            return;
        }
        if (auxiliarySocket != null) {
            closeSocket(socket);
            return;
        }
        auxiliarySocket = socket;
        emitDiagnostic("AUX", "RFCOMM_CONNECTION_ACCEPTED");
        emitDiagnostic("AUX", "CONNECTION_ESTABLISHED");
        scheduleAuxiliaryExchangeTimeout(socket);

        Thread exchange = new Thread(
            () -> runAuxiliaryExchange(socket),
            "lorren-crew-rfcomm-aux-exchange"
        );
        exchange.setDaemon(true);
        auxiliaryExchangeThread = exchange;
        exchange.start();
    }

    private void runAuxiliaryExchange(BluetoothSocket socket) {
        try {
            JSONObject message = readMessage(socket);
            synchronized (this) {
                if (role != Role.READY || auxiliarySocket != socket) return;
            }
            String incomingAttemptId = requiredToken(message.optString("attemptId"), "attemptId");
            String incomingServiceRequestId = requiredToken(
                message.optString("serviceRequestId"),
                "serviceRequestId"
            );
            String incomingChallenge = requiredToken(message.optString("challenge"), "challenge");
            long sentAt = message.optLong("sentAt", 0L);

            synchronized (this) {
                if (!readyServiceRequestId.equals(incomingServiceRequestId)) {
                    finishAuxiliaryExchange(socket);
                    return;
                }
            }

            // Permitimos la conexión offline aunque haya desfase; la firma mantiene integridad.
            if (sentAt <= 0L) {
                finishAuxiliaryExchange(socket);
                return;
            }

            emitDiagnostic("AUX", "CHALLENGE_RECEIVED");
            long respondedAt = System.currentTimeMillis();
            String publicKey = DeviceKeyStore.publicKeyBase64();
            String canonical = canonicalProof(
                incomingAttemptId,
                incomingServiceRequestId,
                incomingChallenge,
                respondedAt
            );
            String signature = DeviceKeyStore.signBase64(canonical);
            String credential = safeCredential();

            JSONObject response = new JSONObject();
            response.put("type", "proof");
            response.put("version", 1);
            response.put("attemptId", incomingAttemptId);
            response.put("serviceRequestId", incomingServiceRequestId);
            response.put("challenge", incomingChallenge);
            response.put("respondedAt", respondedAt);
            response.put("publicKey", publicKey);
            response.put("signature", signature);
            response.put("credential", credential);
            response.put("credentialState", credential.isEmpty() ? "UNPROVISIONED" : "PROVISIONED");
            writeMessage(socket, response);

            synchronized (this) {
                if (role != Role.READY || auxiliarySocket != socket) return;
                String completedService = readyServiceRequestId;
                emitDiagnostic("AUX", "PROOF_DISPATCHED");
                emit("proof_sent", event -> event.put("serviceRequestId", completedService));
                finishAuxiliaryExchange(socket);
            }
        } catch (SecurityException error) {
            synchronized (this) {
                if (role != Role.READY || auxiliarySocket != socket) return;
                failReadyPermissions("auxiliary_exchange", error);
            }
        } catch (Exception error) {
            synchronized (this) {
                if (role != Role.READY || auxiliarySocket != socket) return;
                emitDiagnostic("AUX", "PAYLOAD_FAILED");
                resumeAuxiliaryAfterFailure(socket, "payload_transfer_failed");
            }
        }
    }

    private synchronized void scheduleAuxiliaryExchangeTimeout(BluetoothSocket socket) {
        cancelAuxiliaryExchangeTimeout();
        auxiliaryExchangeTimeout = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.READY || auxiliarySocket != socket) return;
                emitDiagnostic("AUX", "CONNECTION_FAILED");
                resumeAuxiliaryAfterFailure(socket, "connection_failed");
            }
        };
        handler.postDelayed(auxiliaryExchangeTimeout, RFCOMM_EXCHANGE_TIMEOUT_MS);
    }

    private synchronized void resumeAuxiliaryAfterFailure(BluetoothSocket socket, String code) {
        if (auxiliarySocket == socket) closeAuxiliarySocket();
        if (role == Role.READY && code != null && !code.isEmpty()) emitError(code);
    }

    private synchronized void finishAuxiliaryExchange(BluetoothSocket socket) {
        if (auxiliarySocket == socket) closeAuxiliarySocket();
    }

    private synchronized void failReady(String code) {
        stopReadyRuntime();
        role = Role.IDLE;
        activity.setPresenceKeepScreenOn(false);
        readyServiceRequestId = "";
        emitError(code);
    }

    private synchronized void failReadyPermissions(String operation, Throwable error) {
        stopReadyRuntime();
        role = Role.IDLE;
        activity.setPresenceKeepScreenOn(false);
        readyServiceRequestId = "";
        emitPermissionsRequired("AUX", operation, error);
    }

    private synchronized void failReadyBluetooth(String operation, Throwable error) {
        stopReadyRuntime();
        role = Role.IDLE;
        activity.setPresenceKeepScreenOn(false);
        readyServiceRequestId = "";
        emitBluetoothUnavailable("AUX", operation, error);
    }

    synchronized void startLeaderScan(JSONObject input) {
        String nextAttemptId = requiredToken(input.optString("attemptId"), "attemptId");
        String serviceRequestId = requiredToken(input.optString("serviceRequestId"), "serviceRequestId");
        String nextChallenge = requiredToken(input.optString("challenge"), "challenge");
        long timeoutMs = Math.max(
            MIN_SCAN_MS,
            Math.min(MAX_SCAN_MS, input.optLong("timeoutMs", MIN_SCAN_MS))
        );
        int nextExpectedProofCount = Math.max(0, input.optInt("expectedProofCount", 0));

        ensureNearbyTransportPermissions();
        stopAllInternal(false);
        if (!supportsBleScan()) {
            emitBluetoothUnavailable("ENC", "leader_ble_scan", null, "bluetooth_unavailable");
            throw new IllegalStateException("bluetooth_unavailable");
        }
        role = Role.LEADER;
        activity.setPresenceKeepScreenOn(true);
        attemptId = nextAttemptId;
        scanServiceRequestId = serviceRequestId;
        challenge = nextChallenge;
        challengeSentAt = 0L;
        expectedProofCount = nextExpectedProofCount;
        leaderTimeoutMs = timeoutMs;
        proofsByKey.clear();
        leaderConnectionAddresses.clear();

        emitDiagnostic("ENC", "SCAN_REQUESTED");
        if (expectedProofCount == 0) {
            challengeSentAt = System.currentTimeMillis();
            emitLeaderScanStarted();
            completeLeaderScan(nextAttemptId);
            return;
        }
        if (bluetoothAdapter == null) {
            failLeaderBluetooth("leader_discovery", null);
            return;
        }

        try {
            ensureNearbyTransportPermissions();
            challengeSentAt = System.currentTimeMillis();
            emitLeaderScanStarted();
            scheduleLeaderTimeout(nextAttemptId, timeoutMs);
            if (!startLeaderBleScan(nextAttemptId)) {
                failLeaderBluetooth("leader_ble_scan", null);
                return;
            }
        } catch (SecurityException error) {
            failLeaderPermissions("leader_discovery", error);
        } catch (RuntimeException error) {
            failLeaderBluetooth("leader_discovery", error);
        }
    }

    private synchronized boolean startLeaderBleScan(String currentAttemptId) {
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
                    if (device == null) return;
                    String address = safeAddress(device);
                    if (address.isEmpty()) return;
                    synchronized (NearbyPresenceManager.this) {
                        if (role != Role.LEADER || leaderBleScanCallback != this) return;
                        emitDiagnostic("ENC", "BLE_SERVICE_FOUND");
                    }
                    connectLeaderToAuxiliary(device);
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

    private void connectLeaderToAuxiliary(BluetoothDevice device) {
        String address = safeAddress(device);
        if (address.isEmpty()) return;
        synchronized (this) {
            if (role != Role.LEADER || !leaderConnectionAddresses.add(address)) return;
            emitDiagnostic("ENC", "BLE_SERVICE_MATCHED");
            emitDiagnostic("ENC", "ENDPOINT_FOUND");
            int pendingCount = leaderConnectionAddresses.size();
            emit("endpoint_found", event -> event.put("pendingCount", pendingCount));
        }

        Thread thread = new Thread(
            () -> runLeaderConnection(device, address),
            "lorren-crew-rfcomm-leader"
        );
        thread.setDaemon(true);
        thread.start();
    }

    private void runLeaderConnection(BluetoothDevice device, String address) {
        BluetoothSocket socket = null;
        try {
            ensureNearbyTransportPermissions();
            emitDiagnostic("ENC", "RFCOMM_CONNECTING");
            socket = device.createInsecureRfcommSocketToServiceRecord(SERVICE_UUID);
            if (socket == null) throw new IOException("rfcomm_socket_unavailable");
            synchronized (this) {
                if (role != Role.LEADER || !leaderConnectionAddresses.contains(address)) {
                    closeSocket(socket);
                    return;
                }
                leaderSockets.put(address, socket);
                scheduleLeaderSocketTimeout(address, socket);
            }
            socket.connect();
            synchronized (this) {
                if (role != Role.LEADER || leaderSockets.get(address) != socket) return;
                emitDiagnostic("ENC", "RFCOMM_CONNECTED");
                emitDiagnostic("ENC", "CONNECTION_ESTABLISHED");
            }

            JSONObject payload = new JSONObject();
            synchronized (this) {
                payload.put("type", "challenge");
                payload.put("version", 1);
                payload.put("attemptId", attemptId);
                payload.put("serviceRequestId", scanServiceRequestId);
                payload.put("challenge", challenge);
                payload.put("sentAt", challengeSentAt);
            }
            writeMessage(socket, payload);
            emitDiagnostic("ENC", "CHALLENGE_DISPATCHED");

            JSONObject proof = readMessage(socket);
            emitDiagnostic("ENC", "PROOF_RECEIVED_RAW");
            acceptLeaderProof(address, proof);
        } catch (SecurityException error) {
            synchronized (this) {
                if (role == Role.LEADER) {
                    removeLeaderConnection(address, true);
                    failLeaderPermissions("leader_connection", error);
                }
            }
        } catch (Exception error) {
            synchronized (this) {
                if (role == Role.LEADER && leaderConnectionAddresses.contains(address)) {
                    emitDiagnostic("ENC", "CONNECTION_FAILED");
                    removeLeaderConnection(address, true);
                    emitError("connection_failed");
                }
            }
        } finally {
            synchronized (this) {
                if (socket != null && leaderSockets.get(address) == socket) {
                    removeLeaderConnection(address, true);
                }
            }
        }
    }

    private synchronized void acceptLeaderProof(String address, JSONObject proof) {
        try {
            if (!attemptId.equals(proof.optString("attemptId"))) {
                failLeaderPeer(address, "proof_invalid");
                return;
            }
            if (!scanServiceRequestId.equals(proof.optString("serviceRequestId"))) {
                failLeaderPeer(address, "proof_invalid");
                return;
            }
            if (!challenge.equals(proof.optString("challenge"))) {
                failLeaderPeer(address, "proof_invalid");
                return;
            }

            long respondedAt = proof.optLong("respondedAt", 0L);
            if (respondedAt <= 0L) {
                failLeaderPeer(address, "proof_invalid");
                return;
            }

            String publicKey = requiredToken(proof.optString("publicKey"), "publicKey");
            String signature = requiredToken(proof.optString("signature"), "signature");
            String canonical = canonicalProof(attemptId, scanServiceRequestId, challenge, respondedAt);
            if (!DeviceKeyStore.verifyBase64(publicKey, canonical, signature)) {
                emitDiagnostic("ENC", "PROOF_SIGNATURE_INVALID");
                failLeaderPeer(address, "proof_signature_invalid");
                return;
            }

            String keyId = keyId(publicKey);
            JSONObject stored = new JSONObject();
            stored.put("version", 1);
            stored.put("serviceRequestId", scanServiceRequestId);
            stored.put("attemptId", attemptId);
            stored.put("challenge", challenge);
            stored.put("respondedAt", respondedAt);
            stored.put("publicKey", publicKey);
            stored.put("signature", signature);
            stored.put("credential", proof.optString("credential", ""));
            stored.put(
                "credentialState",
                proof.optString("credentialState", "UNPROVISIONED")
            );
            stored.put("deviceKeyId", keyId);
            proofsByKey.put(keyId, stored);

            removeLeaderConnection(address, true);
            int verifiedCount = proofsByKey.size();
            int pendingCount = leaderConnectionAddresses.size();
            emitDiagnostic("ENC", "PROOF_VERIFIED");
            emit("proof_received", event -> {
                event.put("deviceKeyId", keyId);
                event.put("verifiedCount", verifiedCount);
                event.put("pendingCount", pendingCount);
                event.put("credentialProvisioned", !stored.optString("credential").isEmpty());
            });

            if (expectedProofCount > 0 && verifiedCount >= expectedProofCount) {
                completeLeaderScan(attemptId);
            }
        } catch (Exception error) {
            failLeaderPeer(address, "proof_invalid");
        }
    }

    private synchronized void failLeaderPeer(String address, String code) {
        removeLeaderConnection(address, true);
        emitDiagnostic("ENC", "PROOF_INVALID");
        if (code != null && !code.isEmpty()) emitError(code);
    }

    private synchronized void scheduleLeaderSocketTimeout(String address, BluetoothSocket socket) {
        Runnable previous = leaderSocketTimeouts.remove(address);
        if (previous != null) handler.removeCallbacks(previous);
        Runnable timeout = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER || leaderSockets.get(address) != socket) return;
                emitDiagnostic("ENC", "CONNECTION_FAILED");
                removeLeaderConnection(address, true);
                emitError("connection_failed");
            }
        };
        leaderSocketTimeouts.put(address, timeout);
        handler.postDelayed(timeout, RFCOMM_EXCHANGE_TIMEOUT_MS);
    }

    private synchronized void scheduleLeaderTimeout(String completedAttemptId, long timeoutMs) {
        cancelLeaderTimeouts();
        leaderTimeout = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER || !attemptId.equals(completedAttemptId)) return;
                emitDiagnostic("ENC", "WINDOW_CLOSED");
                stopLeaderDiscovery();
                leaderCompleteTimeout = () -> completeLeaderScan(completedAttemptId);
                handler.postDelayed(leaderCompleteTimeout, CONNECTION_GRACE_MS);
            }
        };
        handler.postDelayed(leaderTimeout, timeoutMs);
    }

    private synchronized void emitLeaderScanStarted() {
        String startedAttemptId = attemptId;
        String startedServiceRequestId = scanServiceRequestId;
        long startedTimeoutMs = leaderTimeoutMs;
        int startedExpectedProofCount = expectedProofCount;
        emit("scan_started", event -> {
            event.put("attemptId", startedAttemptId);
            event.put("serviceRequestId", startedServiceRequestId);
            event.put("timeoutMs", startedTimeoutMs);
            event.put("expectedProofCount", startedExpectedProofCount);
        });
    }

    private synchronized void failLeaderStart(String code) {
        if (role != Role.LEADER) return;
        cancelLeaderTimeouts();
        stopLeaderDiscovery();
        closeLeaderSockets();
        role = Role.IDLE;
        activity.setPresenceKeepScreenOn(false);
        emitError(code);
    }

    private synchronized void failLeaderPermissions(String operation, Throwable error) {
        if (role != Role.LEADER) return;
        cancelLeaderTimeouts();
        stopLeaderDiscovery();
        closeLeaderSockets();
        role = Role.IDLE;
        activity.setPresenceKeepScreenOn(false);
        emitPermissionsRequired("ENC", operation, error);
    }

    private synchronized void failLeaderBluetooth(String operation, Throwable error) {
        if (role != Role.LEADER) return;
        cancelLeaderTimeouts();
        stopLeaderDiscovery();
        closeLeaderSockets();
        role = Role.IDLE;
        activity.setPresenceKeepScreenOn(false);
        emitBluetoothUnavailable("ENC", operation, error);
    }

    private synchronized void completeLeaderScan(String completedAttemptId) {
        if (role != Role.LEADER || !attemptId.equals(completedAttemptId)) return;
        int verifiedCount = proofsByKey.size();
        int pendingCount = leaderConnectionAddresses.size();

        cancelLeaderTimeouts();
        stopLeaderDiscovery();
        closeLeaderSockets();

        emitDiagnostic("ENC", "SCAN_COMPLETE");
        emit("scan_complete", event -> {
            event.put("attemptId", completedAttemptId);
            event.put("verifiedCount", verifiedCount);
            event.put("pendingCount", pendingCount);
            event.put("expectedProofCount", expectedProofCount);
        });
        role = Role.IDLE;
        activity.setPresenceKeepScreenOn(false);
    }

    synchronized void stopReady() {
        if (role == Role.READY) stopAllInternal(true);
    }

    synchronized void stopLeaderScan() {
        if (role == Role.LEADER) stopAllInternal(true);
    }

    synchronized JSONObject proofBundle() {
        JSONObject result = new JSONObject();
        JSONArray proofs = new JSONArray();
        try {
            result.put("version", 1);
            result.put("attemptId", attemptId);
            result.put("serviceRequestId", scanServiceRequestId);
            result.put("challenge", challenge);
            result.put("challengeSentAt", challengeSentAt);
            for (JSONObject proof : proofsByKey.values()) {
                proofs.put(new JSONObject(proof.toString()));
            }
            result.put("proofs", proofs);
        } catch (Exception ignored) {
            // Campos construidos con primitivas y valores ya validados.
        }
        return result;
    }

    synchronized void shutdown() {
        stopAllInternal(false);
    }

    private synchronized void stopAllInternal(boolean notify) {
        cancelAuxiliaryExchangeTimeout();
        cancelLeaderTimeouts();
        stopReadyRuntime();
        stopLeaderDiscovery();
        closeLeaderSockets();

        readyServiceRequestId = "";
        attemptId = "";
        scanServiceRequestId = "";
        challenge = "";
        challengeSentAt = 0L;
        expectedProofCount = 0;
        leaderTimeoutMs = MIN_SCAN_MS;
        proofsByKey.clear();
        leaderConnectionAddresses.clear();
        role = Role.IDLE;
        activity.setPresenceKeepScreenOn(false);
        if (notify) emit("stopped", event -> {});
    }

    private synchronized void stopReadyRuntime() {
        stopAuxiliaryBleAdvertising();
        closeAuxiliarySocket();
        BluetoothServerSocket server = auxiliaryServerSocket;
        auxiliaryServerSocket = null;
        auxiliaryAcceptThread = null;
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {
            }
        }
    }

    private synchronized void closeAuxiliarySocket() {
        cancelAuxiliaryExchangeTimeout();
        BluetoothSocket socket = auxiliarySocket;
        auxiliarySocket = null;
        auxiliaryExchangeThread = null;
        closeSocket(socket);
    }

    private synchronized void cancelAuxiliaryExchangeTimeout() {
        if (auxiliaryExchangeTimeout != null) handler.removeCallbacks(auxiliaryExchangeTimeout);
        auxiliaryExchangeTimeout = null;
    }

    private synchronized void stopLeaderDiscovery() {
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
    }

    private synchronized void closeLeaderSockets() {
        for (Runnable timeout : leaderSocketTimeouts.values()) {
            handler.removeCallbacks(timeout);
        }
        leaderSocketTimeouts.clear();
        List<BluetoothSocket> sockets = new ArrayList<>(leaderSockets.values());
        leaderSockets.clear();
        leaderConnectionAddresses.clear();
        for (BluetoothSocket socket : sockets) closeSocket(socket);
    }

    private synchronized void removeLeaderConnection(String address, boolean close) {
        Runnable timeout = leaderSocketTimeouts.remove(address);
        if (timeout != null) handler.removeCallbacks(timeout);
        BluetoothSocket socket = leaderSockets.remove(address);
        leaderConnectionAddresses.remove(address);
        if (close) closeSocket(socket);
    }

    private synchronized void cancelLeaderTimeouts() {
        if (leaderTimeout != null) handler.removeCallbacks(leaderTimeout);
        if (leaderCompleteTimeout != null) handler.removeCallbacks(leaderCompleteTimeout);
        leaderTimeout = null;
        leaderCompleteTimeout = null;
    }

    private void ensureNearbyTransportPermissions() {
        if (hasNearbyTransportPermissions()) return;
        activity.ensureNearbyPermissions();
        throw new SecurityException("permissions_required");
    }

    private boolean hasNearbyTransportPermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        return appContext.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)
                == PackageManager.PERMISSION_GRANTED
            && appContext.checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE)
                == PackageManager.PERMISSION_GRANTED
            && appContext.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean supportsBleScan() {
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

    private boolean supportsBleAdvertising() {
        if (bluetoothAdapter == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return false;
        if (!appContext.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return false;
        try {
            ensureNearbyTransportPermissions();
            return bluetoothAdapter.getBluetoothLeAdvertiser() != null;
        } catch (SecurityException error) {
            throw error;
        } catch (RuntimeException error) {
            return false;
        }
    }

    private String safeCredential() {
        String credential = credentialProvider.credential();
        if (credential == null) return "";
        String normalized = credential.trim();
        return normalized.length() > MAX_MESSAGE_BYTES ? "" : normalized;
    }

    private static void writeMessage(BluetoothSocket socket, JSONObject payload) throws IOException {
        if (socket == null || payload == null) throw new IOException("rfcomm_payload_missing");
        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length <= 0 || bytes.length > MAX_MESSAGE_BYTES) {
            throw new IOException("rfcomm_payload_size_invalid");
        }
        DataOutputStream output = new DataOutputStream(socket.getOutputStream());
        output.writeInt(bytes.length);
        output.write(bytes);
        output.flush();
    }

    private static JSONObject readMessage(BluetoothSocket socket) throws Exception {
        if (socket == null) throw new IOException("rfcomm_socket_missing");
        DataInputStream input = new DataInputStream(socket.getInputStream());
        int length = input.readInt();
        if (length <= 0 || length > MAX_MESSAGE_BYTES) {
            throw new IOException("rfcomm_payload_size_invalid");
        }
        byte[] bytes = new byte[length];
        input.readFully(bytes);
        return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }

    private static String safeAddress(BluetoothDevice device) {
        if (device == null) return "";
        try {
            String address = device.getAddress();
            return address == null ? "" : address;
        } catch (SecurityException error) {
            return "";
        }
    }

    private static void closeSocket(BluetoothSocket socket) {
        if (socket == null) return;
        try {
            socket.close();
        } catch (IOException ignored) {
        }
    }

    private static String canonicalProof(
        String attemptId,
        String serviceRequestId,
        String challenge,
        long respondedAt
    ) {
        return "lorren-presence-v1\n"
            + attemptId + "\n"
            + serviceRequestId + "\n"
            + challenge + "\n"
            + respondedAt;
    }

    private static String keyId(String publicKeyBase64) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256")
            .digest(Base64.decode(publicKeyBase64, Base64.NO_WRAP));
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < 6; index += 1) {
            builder.append(String.format("%02x", digest[index] & 0xff));
        }
        return builder.toString();
    }

    private static String requiredToken(String value, String label) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.isEmpty() || normalized.length() > 2_048) {
            throw new IllegalArgumentException(label + "_invalid");
        }
        return normalized;
    }

    private interface EventWriter {
        void write(JSONObject event) throws Exception;
    }

    private void emit(String type, EventWriter writer) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", type);
            writer.write(event);
            eventSink.emit(event);
        } catch (Exception ignored) {
            // Los eventos de UI no son autoridad de asistencia.
        }
    }

    private void emitDiagnostic(String actor, String stage) {
        emit("diagnostic", event -> {
            event.put("actor", actor);
            event.put("stage", stage);
        });
    }

    private void emitError(String code) {
        emit("error", event -> event.put("code", code));
    }

    private void emitPermissionsRequired(String actor, String operation, Throwable error) {
        activity.ensureNearbyPermissions();
        emitDiagnostic(actor, "PERMISSIONS_REQUIRED");
        // No se activa el fallback manual mientras Android está resolviendo permisos.
        // MainActivity emitirá el evento `permissions` con granted=true/false.
        emit("stopped", event -> {
            event.put("reason", "permissions_pending");
            event.put("operation", operation == null ? "" : operation);
            int statusCode = bluetoothStatusCode(error);
            if (statusCode > 0) event.put("statusCode", statusCode);
        });
    }

    private void emitBluetoothUnavailable(String actor, String operation, Throwable error) {
        int statusCode = bluetoothStatusCode(error);
        if (statusCode == MISSING_PERMISSION_NEARBY_WIFI_DEVICES_STATUS) {
            emitPermissionsRequired(actor, operation, error);
            return;
        }
        emitBluetoothUnavailable(actor, operation, error, "startup_failed");
    }

    private void emitBluetoothUnavailable(
        String actor,
        String operation,
        Throwable error,
        String reason
    ) {
        int statusCode = bluetoothStatusCode(error);
        emitDiagnostic(actor, "BLUETOOTH_UNAVAILABLE");
        emit("bluetooth_unavailable", event -> {
            event.put("code", "bluetooth_unavailable");
            event.put("operation", operation == null ? "" : operation);
            event.put("reason", reason == null ? "startup_failed" : reason);
            if (statusCode > 0) event.put("statusCode", statusCode);
        });
    }

    private static int bluetoothStatusCode(Throwable error) {
        Throwable current = error;
        for (int depth = 0; current != null && depth < 6; depth += 1) {
            String message = current.getMessage();
            if (message != null) {
                if (message.contains(String.valueOf(MISSING_PERMISSION_NEARBY_WIFI_DEVICES_STATUS))) {
                    return MISSING_PERMISSION_NEARBY_WIFI_DEVICES_STATUS;
                }
                Matcher matcher = BLUETOOTH_STATUS_PATTERN.matcher(message);
                if (matcher.find()) {
                    try {
                        return Integer.parseInt(matcher.group(1));
                    } catch (NumberFormatException ignored) {
                    }
                }
            }
            current = current.getCause();
        }
        return 0;
    }
}
