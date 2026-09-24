package com.loginpro.lorren.portal;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.Parcelable;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
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
 * La prueba local usa Bluetooth Classic RFCOMM/SDP de extremo a extremo para no
 * depender de Wi-Fi, WAN ni del rol BLE peripheral/advertiser que falló en los
 * replays físicos. El auxiliar preparado expone un servicio RFCOMM y el encargado
 * descubre dispositivos cercanos, resuelve el UUID técnico de Lórren y conecta.
 * Esta clase transporta y verifica challenge/proof; no escribe asistencia.
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

    // Bluetooth Classic inquiry suele consumir ~12 s. La ventana nativa deja
    // margen real para inquiry + SDP + RFCOMM y termina antes si llegan las proofs.
    private static final long MIN_SCAN_MS = 35_000L;
    private static final long MAX_SCAN_MS = 45_000L;
    private static final long INQUIRY_CHECKPOINT_MS = 15_000L;
    private static final long CONNECTION_GRACE_MS = 1_500L;
    private static final long RFCOMM_EXCHANGE_TIMEOUT_MS = 12_000L;
    private static final int MAX_DISCOVERED_DEVICES = 24;
    private static final int MAX_MESSAGE_BYTES = 16_384;
    private static final int DISCOVERY_FAILED_STATUS = 8029;
    private static final Pattern BLUETOOTH_STATUS_PATTERN = Pattern.compile(
        "(?i)status(?:code)?\\s*[=:]?\\s*(\\d{3,5})"
    );

    private enum Role { IDLE, READY, LEADER }

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

    // ENC: discovery Classic + SDP + conexiones RFCOMM de una marcación.
    private String attemptId = "";
    private String scanServiceRequestId = "";
    private String challenge = "";
    private long challengeSentAt = 0L;
    private int expectedProofCount = 0;
    private long leaderTimeoutMs = MIN_SCAN_MS;
    private final Map<String, JSONObject> proofsByKey = new LinkedHashMap<>();
    private final Map<String, BluetoothDevice> discoveredDevices = new LinkedHashMap<>();
    private final Set<String> sdpRequestedAddresses = new LinkedHashSet<>();
    private final Set<String> leaderConnectionAddresses = new LinkedHashSet<>();
    private final Map<String, BluetoothSocket> leaderSockets = new LinkedHashMap<>();
    private final Map<String, Runnable> leaderSocketTimeouts = new LinkedHashMap<>();
    private boolean leaderReceiverRegistered = false;
    private Runnable leaderInquiryCheckpoint;
    private Runnable leaderTimeout;
    private Runnable leaderCompleteTimeout;

    NearbyPresenceManager(Context context, EventSink eventSink, CredentialProvider credentialProvider) {
        this.appContext = context.getApplicationContext();
        this.bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
        this.eventSink = eventSink;
        this.credentialProvider = credentialProvider;
    }

    synchronized void startReady(String serviceRequestId) {
        String normalizedService = requiredToken(serviceRequestId, "serviceRequestId");
        stopAllInternal(false);
        role = Role.READY;
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
            if (bluetoothAdapter.getScanMode() != BluetoothAdapter.SCAN_MODE_CONNECTABLE_DISCOVERABLE) {
                emitDiagnostic("AUX", "DISCOVERABLE_NOT_READY");
                failReadyBluetooth("auxiliary_discovery", null);
                return;
            }
        } catch (RuntimeException error) {
            failReadyBluetooth("auxiliary_discovery", error);
            return;
        }
        emitDiagnostic("AUX", "DISCOVERABLE_CONFIRMED");
        if (auxiliaryServerSocket != null) {
            emitReady();
            return;
        }
        emitDiagnostic("AUX", "RFCOMM_SERVER_START");
        try {
            auxiliaryServerSocket = bluetoothAdapter.listenUsingInsecureRfcommWithServiceRecord(
                SERVICE_NAME,
                SERVICE_UUID
            );
        } catch (IOException | RuntimeException error) {
            failReadyBluetooth("auxiliary_advertising", error);
            return;
        }
        if (auxiliaryServerSocket == null) {
            failReadyBluetooth("auxiliary_advertising", null);
            return;
        }
        emitDiagnostic("AUX", "RFCOMM_SERVER_READY");
        emitReady();
        startAuxiliaryAcceptLoop(auxiliaryServerSocket);
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
                } catch (IOException | SecurityException error) {
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

            // CORRECCIÓN RELOJ: Permitimos la conexión offline aunque haya desfase
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
        readyServiceRequestId = "";
        emitError(code);
    }

    private synchronized void failReadyBluetooth(String operation, Throwable error) {
        stopReadyRuntime();
        role = Role.IDLE;
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

        stopAllInternal(false);
        role = Role.LEADER;
        attemptId = nextAttemptId;
        scanServiceRequestId = serviceRequestId;
        challenge = nextChallenge;
        challengeSentAt = 0L;
        expectedProofCount = nextExpectedProofCount;
        leaderTimeoutMs = timeoutMs;
        proofsByKey.clear();
        discoveredDevices.clear();
        sdpRequestedAddresses.clear();
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
            registerLeaderReceiver();
            if (bluetoothAdapter.isDiscovering()) bluetoothAdapter.cancelDiscovery();

            // CORRECCIÓN: Evitar que Android ignore auxiliares si ya fueron emparejados en el pasado
            try {
                Set<BluetoothDevice> bonded = bluetoothAdapter.getBondedDevices();
                if (bonded != null) {
                    for (BluetoothDevice dev : bonded) {
                        rememberDiscoveredDevice(dev);
                    }
                }
            } catch (SecurityException ignored) {}

            emitDiagnostic("ENC", "CLASSIC_DISCOVERY_START");
            if (!bluetoothAdapter.startDiscovery()) {
                failLeaderBluetooth("leader_discovery", null);
                return;
            }
            challengeSentAt = System.currentTimeMillis();
            emitLeaderScanStarted();
            scheduleLeaderTimeout(nextAttemptId, timeoutMs);
            scheduleLeaderInquiryCheckpoint(nextAttemptId);
        } catch (RuntimeException error) {
            failLeaderBluetooth("leader_discovery", error);
        }
    }

    private final BroadcastReceiver leaderDiscoveryReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            String action = intent.getAction();
            if (BluetoothAdapter.ACTION_DISCOVERY_STARTED.equals(action)) {
                synchronized (NearbyPresenceManager.this) {
                    if (role != Role.LEADER) return;
                    emitDiagnostic("ENC", "CLASSIC_DISCOVERY_READY");
                }
                return;
            }
            if (BluetoothDevice.ACTION_FOUND.equals(action)) {
                BluetoothDevice device = parcelableDevice(intent);
                rememberDiscoveredDevice(device);
                return;
            }
            if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(action)) {
                synchronized (NearbyPresenceManager.this) {
                    if (role != Role.LEADER) return;
                    cancelLeaderInquiryCheckpoint();
                    emitDiagnostic("ENC", "CLASSIC_INQUIRY_FINISHED");
                }
                requestSdpForDiscoveredDevices();
                return;
            }
            if (BluetoothDevice.ACTION_UUID.equals(action)) {
                BluetoothDevice device = parcelableDevice(intent);
                if (device != null && intentContainsServiceUuid(intent, device)) {
                    connectLeaderToAuxiliary(device);
                }
            }
        }
    };

    private synchronized void rememberDiscoveredDevice(BluetoothDevice device) {
        if (role != Role.LEADER || device == null || discoveredDevices.size() >= MAX_DISCOVERED_DEVICES) return;
        String address = safeAddress(device);
        if (address.isEmpty() || discoveredDevices.containsKey(address)) return;
        discoveredDevices.put(address, device);
        emitDiagnostic("ENC", "CLASSIC_DEVICE_FOUND");
    }

    private void requestSdpForDiscoveredDevices() {
        List<BluetoothDevice> devices;
        synchronized (this) {
            if (role != Role.LEADER) return;
            devices = new ArrayList<>(discoveredDevices.values());
        }
        for (BluetoothDevice device : devices) {
            String address = safeAddress(device);
            if (address.isEmpty()) continue;
            if (deviceHasServiceUuid(device)) {
                connectLeaderToAuxiliary(device);
                continue;
            }
            synchronized (this) {
                if (role != Role.LEADER || !sdpRequestedAddresses.add(address)) continue;
            }
            try {
                emitDiagnostic("ENC", "SDP_REQUESTED");
                if (!device.fetchUuidsWithSdp()) {
                    synchronized (this) {
                        sdpRequestedAddresses.remove(address);
                    }
                }
            } catch (RuntimeException error) {
                synchronized (this) {
                    sdpRequestedAddresses.remove(address);
                }
            }
        }
    }

    private void connectLeaderToAuxiliary(BluetoothDevice device) {
        String address = safeAddress(device);
        if (address.isEmpty()) return;
        synchronized (this) {
            if (role != Role.LEADER || !leaderConnectionAddresses.add(address)) return;
            emitDiagnostic("ENC", "SDP_MATCHED");
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
            
            // CORRECCIÓN RELOJ: Aceptamos respuesta sin importar desfase temporal
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

    private synchronized void scheduleLeaderInquiryCheckpoint(String completedAttemptId) {
        cancelLeaderInquiryCheckpoint();
        leaderInquiryCheckpoint = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER || !attemptId.equals(completedAttemptId)) return;
                emitDiagnostic("ENC", "CLASSIC_INQUIRY_CHECKPOINT");
                try {
                    if (bluetoothAdapter != null && bluetoothAdapter.isDiscovering()) {
                        bluetoothAdapter.cancelDiscovery();
                    }
                } catch (RuntimeException ignored) {
                }
            }
            requestSdpForDiscoveredDevices();
        };
        handler.postDelayed(leaderInquiryCheckpoint, INQUIRY_CHECKPOINT_MS);
    }

    private synchronized void cancelLeaderInquiryCheckpoint() {
        if (leaderInquiryCheckpoint != null) handler.removeCallbacks(leaderInquiryCheckpoint);
        leaderInquiryCheckpoint = null;
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
        emitError(code);
    }

    private synchronized void failLeaderBluetooth(String operation, Throwable error) {
        if (role != Role.LEADER) return;
        cancelLeaderTimeouts();
        stopLeaderDiscovery();
        closeLeaderSockets();
        role = Role.IDLE;
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
        discoveredDevices.clear();
        sdpRequestedAddresses.clear();
        leaderConnectionAddresses.clear();
        role = Role.IDLE;
        if (notify) emit("stopped", event -> {});
    }

    private synchronized void stopReadyRuntime() {
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

    private synchronized void registerLeaderReceiver() {
        if (leaderReceiverRegistered) return;
        IntentFilter filter = new IntentFilter();
        filter.addAction(BluetoothAdapter.ACTION_DISCOVERY_STARTED);
        filter.addAction(BluetoothDevice.ACTION_FOUND);
        filter.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
        filter.addAction(BluetoothDevice.ACTION_UUID);
        appContext.registerReceiver(leaderDiscoveryReceiver, filter);
        leaderReceiverRegistered = true;
    }

    private synchronized void stopLeaderDiscovery() {
        cancelLeaderInquiryCheckpoint();
        if (bluetoothAdapter != null) {
            try {
                if (bluetoothAdapter.isDiscovering()) bluetoothAdapter.cancelDiscovery();
            } catch (RuntimeException ignored) {
            }
        }
        if (leaderReceiverRegistered) {
            try {
                appContext.unregisterReceiver(leaderDiscoveryReceiver);
            } catch (RuntimeException ignored) {
            }
        }
        leaderReceiverRegistered = false;
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
        cancelLeaderInquiryCheckpoint();
        if (leaderTimeout != null) handler.removeCallbacks(leaderTimeout);
        if (leaderCompleteTimeout != null) handler.removeCallbacks(leaderCompleteTimeout);
        leaderTimeout = null;
        leaderCompleteTimeout = null;
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

    private static boolean deviceHasServiceUuid(BluetoothDevice device) {
        if (device == null) return false;
        try {
            ParcelUuid[] uuids = device.getUuids();
            if (uuids == null) return false;
            for (ParcelUuid uuid : uuids) {
                if (SERVICE_PARCEL_UUID.equals(uuid)) return true;
            }
        } catch (SecurityException ignored) {
        }
        return false;
    }

    private static boolean intentContainsServiceUuid(Intent intent, BluetoothDevice device) {
        try {
            Parcelable[] raw = intent.getParcelableArrayExtra(BluetoothDevice.EXTRA_UUID);
            if (raw != null) {
                for (Parcelable value : raw) {
                    if (value instanceof ParcelUuid && SERVICE_PARCEL_UUID.equals(value)) return true;
                }
            }
        } catch (RuntimeException ignored) {
        }
        return deviceHasServiceUuid(device);
    }

    @SuppressWarnings("deprecation")
    private static BluetoothDevice parcelableDevice(Intent intent) {
        if (intent == null) return null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice.class);
            }
            return intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
        } catch (RuntimeException ignored) {
            return null;
        }
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

    private void emitBluetoothUnavailable(String actor, String operation, Throwable error) {
        int statusCode = bluetoothStatusCode(error);
        emitDiagnostic(actor, "BLUETOOTH_UNAVAILABLE");
        emit("bluetooth_unavailable", event -> {
            event.put("code", "bluetooth_unavailable");
            event.put("operation", operation == null ? "" : operation);
            event.put(
                "reason",
                statusCode == DISCOVERY_FAILED_STATUS ? "discovery_failed" : "startup_failed"
            );
            if (statusCode > 0) event.put("statusCode", statusCode);
        });
    }

    private static int bluetoothStatusCode(Throwable error) {
        Throwable current = error;
        for (int depth = 0; current != null && depth < 6; depth += 1) {
            String message = current.getMessage();
            if (message != null) {
                if (message.contains(String.valueOf(DISCOVERY_FAILED_STATUS))) {
                    return DISCOVERY_FAILED_STATUS;
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
