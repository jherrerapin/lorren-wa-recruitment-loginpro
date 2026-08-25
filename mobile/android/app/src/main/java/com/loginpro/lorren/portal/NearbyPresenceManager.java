package com.loginpro.lorren.portal;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Status;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionOptions;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionType;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Autoridad nativa única de presencia local de cuadrilla.
 *
 * El encargado es el hub temporal: anuncia solo durante una marcación. Los
 * auxiliares preparados mantienen discovery y solicitan conexión al encontrarlo.
 * Nearby puede usar los radios locales ya disponibles, pero NON_DISRUPTIVE evita
 * que la comprobación cambie el estado de Wi-Fi/Bluetooth. Esta clase no escribe
 * asistencia.
 */
final class NearbyPresenceManager {
    interface EventSink {
        void emit(JSONObject event);
    }

    interface CredentialProvider {
        String credential();
    }

    private static final String SERVICE_ID = "com.loginpro.lorren.portal.crew.presence.v1";
    private static final String ENDPOINT_NAME = "LORREN";
    private static final Strategy STRATEGY = Strategy.P2P_STAR;
    private static final long MIN_SCAN_MS = 4_000L;
    private static final long MAX_SCAN_MS = 30_000L;
    private static final long CONNECTION_GRACE_MS = 1_500L;
    private static final long NEARBY_RESTART_DELAY_MS = 350L;
    private static final int MAX_START_RETRIES = 1;
    private static final int MAX_CONNECTION_REQUEST_RETRIES = 1;

    private enum Role { IDLE, READY, LEADER }

    private final ConnectionsClient client;
    private final EventSink eventSink;
    private final CredentialProvider credentialProvider;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Set<String> requestedEndpoints = new LinkedHashSet<>();
    private final Map<String, JSONObject> proofsByKey = new LinkedHashMap<>();

    private Role role = Role.IDLE;
    private String readyServiceRequestId = "";
    private String attemptId = "";
    private String scanServiceRequestId = "";
    private String challenge = "";
    private long challengeSentAt = 0L;
    private int expectedProofCount = 0;
    private Runnable scanTimeout;
    private Runnable scanCompleteTimeout;

    NearbyPresenceManager(Context context, EventSink eventSink, CredentialProvider credentialProvider) {
        this.client = Nearby.getConnectionsClient(context.getApplicationContext());
        this.eventSink = eventSink;
        this.credentialProvider = credentialProvider;
    }

    synchronized void startReady(String serviceRequestId) {
        String normalizedService = requiredToken(serviceRequestId, "serviceRequestId");
        stopAllInternal(false);
        role = Role.READY;
        readyServiceRequestId = normalizedService;
        emitDiagnostic("AUX", "READY_REQUESTED");
        startReadyDiscovery(normalizedService, 0);
    }

    private void startReadyDiscovery(String normalizedService, int retryCount) {
        DiscoveryOptions options = new DiscoveryOptions.Builder()
            .setStrategy(STRATEGY)
            .setLowPower(true)
            .build();
        emitDiagnostic("AUX", "DISCOVERY_START", Integer.MIN_VALUE, retryCount);
        try {
            client.startDiscovery(SERVICE_ID, endpointDiscoveryCallback, options)
                .addOnSuccessListener(unused -> {
                    synchronized (NearbyPresenceManager.this) {
                        if (role != Role.READY || !readyServiceRequestId.equals(normalizedService)) {
                            client.stopDiscovery();
                            return;
                        }
                    }
                    emitDiagnostic("AUX", "DISCOVERY_READY");
                    emit("ready", event -> event.put("serviceRequestId", normalizedService));
                })
                .addOnFailureListener(error -> handleReadyDiscoveryFailure(
                    normalizedService,
                    retryCount,
                    error
                ));
        } catch (RuntimeException error) {
            handleReadyDiscoveryFailure(normalizedService, retryCount, error);
        }
    }

    private void handleReadyDiscoveryFailure(
        String normalizedService,
        int retryCount,
        Exception error
    ) {
        int statusCode = nearbyStatusCode(error);
        if (retryCount < MAX_START_RETRIES && isRecoverableStartFailure(error)) {
            emitDiagnostic("AUX", "DISCOVERY_RETRY", statusCode, retryCount + 1);
            resetNearbyClientForRetry();
            handler.postDelayed(() -> {
                synchronized (NearbyPresenceManager.this) {
                    if (role != Role.READY || !readyServiceRequestId.equals(normalizedService)) return;
                }
                startReadyDiscovery(normalizedService, retryCount + 1);
            }, NEARBY_RESTART_DELAY_MS);
            return;
        }
        emitDiagnostic("AUX", "DISCOVERY_FAILED", statusCode, retryCount);
        synchronized (this) {
            if (role == Role.READY && readyServiceRequestId.equals(normalizedService)) {
                role = Role.IDLE;
                readyServiceRequestId = "";
            }
        }
        client.stopDiscovery();
        client.stopAllEndpoints();
        requestedEndpoints.clear();
        emitError(nearbyStartErrorCode(error, "discovery_failed"));
    }

    synchronized void startLeaderScan(JSONObject input) {
        String nextAttemptId = requiredToken(input.optString("attemptId"), "attemptId");
        String serviceRequestId = requiredToken(input.optString("serviceRequestId"), "serviceRequestId");
        String nextChallenge = requiredToken(input.optString("challenge"), "challenge");
        long timeoutMs = Math.max(
            MIN_SCAN_MS,
            Math.min(MAX_SCAN_MS, input.optLong("timeoutMs", 6_000L))
        );
        int nextExpectedProofCount = Math.max(0, input.optInt("expectedProofCount", 0));

        stopAllInternal(false);
        role = Role.LEADER;
        attemptId = nextAttemptId;
        scanServiceRequestId = serviceRequestId;
        challenge = nextChallenge;
        challengeSentAt = System.currentTimeMillis();
        expectedProofCount = nextExpectedProofCount;
        proofsByKey.clear();
        requestedEndpoints.clear();
        emitDiagnostic("ENC", "SCAN_REQUESTED");

        if (expectedProofCount == 0) {
            emitLeaderScanStarted(nextAttemptId, serviceRequestId, timeoutMs);
            completeLeaderScan(nextAttemptId);
            return;
        }
        startLeaderAdvertising(nextAttemptId, serviceRequestId, timeoutMs, 0);
    }

    private void startLeaderAdvertising(
        String nextAttemptId,
        String serviceRequestId,
        long timeoutMs,
        int retryCount
    ) {
        AdvertisingOptions options = new AdvertisingOptions.Builder()
            .setStrategy(STRATEGY)
            .setLowPower(false)
            .setConnectionType(ConnectionType.NON_DISRUPTIVE)
            .build();
        emitDiagnostic("ENC", "ADVERTISING_START", Integer.MIN_VALUE, retryCount);
        try {
            client.startAdvertising(
                ENDPOINT_NAME,
                SERVICE_ID,
                connectionLifecycleCallback,
                options
            )
                .addOnSuccessListener(unused -> {
                    synchronized (NearbyPresenceManager.this) {
                        if (role != Role.LEADER || !attemptId.equals(nextAttemptId)) {
                            client.stopAdvertising();
                            return;
                        }
                    }
                    emitDiagnostic("ENC", "ADVERTISING_READY");
                    emitLeaderScanStarted(nextAttemptId, serviceRequestId, timeoutMs);
                    scheduleLeaderScanTimeout(nextAttemptId, timeoutMs);
                })
                .addOnFailureListener(error -> handleLeaderAdvertisingFailure(
                    nextAttemptId,
                    serviceRequestId,
                    timeoutMs,
                    retryCount,
                    error
                ));
        } catch (RuntimeException error) {
            handleLeaderAdvertisingFailure(
                nextAttemptId,
                serviceRequestId,
                timeoutMs,
                retryCount,
                error
            );
        }
    }

    private void handleLeaderAdvertisingFailure(
        String nextAttemptId,
        String serviceRequestId,
        long timeoutMs,
        int retryCount,
        Exception error
    ) {
        int statusCode = nearbyStatusCode(error);
        if (retryCount < MAX_START_RETRIES && isRecoverableStartFailure(error)) {
            emitDiagnostic("ENC", "ADVERTISING_RETRY", statusCode, retryCount + 1);
            resetNearbyClientForRetry();
            handler.postDelayed(() -> {
                synchronized (NearbyPresenceManager.this) {
                    if (role != Role.LEADER || !attemptId.equals(nextAttemptId)) return;
                }
                startLeaderAdvertising(
                    nextAttemptId,
                    serviceRequestId,
                    timeoutMs,
                    retryCount + 1
                );
            }, NEARBY_RESTART_DELAY_MS);
            return;
        }
        emitDiagnostic("ENC", "ADVERTISING_FAILED", statusCode, retryCount);
        synchronized (this) {
            if (role == Role.LEADER && attemptId.equals(nextAttemptId)) role = Role.IDLE;
            cancelLeaderTimers();
        }
        client.stopAdvertising();
        client.stopAllEndpoints();
        requestedEndpoints.clear();
        emitError(nearbyStartErrorCode(error, "advertising_failed"));
    }

    private void emitLeaderScanStarted(
        String nextAttemptId,
        String serviceRequestId,
        long timeoutMs
    ) {
        emit("scan_started", event -> {
            event.put("attemptId", nextAttemptId);
            event.put("serviceRequestId", serviceRequestId);
            event.put("timeoutMs", timeoutMs);
            event.put("expectedProofCount", expectedProofCount);
        });
    }

    private synchronized void scheduleLeaderScanTimeout(String nextAttemptId, long timeoutMs) {
        if (role != Role.LEADER || !attemptId.equals(nextAttemptId)) return;
        if (scanTimeout != null) handler.removeCallbacks(scanTimeout);
        scanTimeout = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER || !attemptId.equals(nextAttemptId)) return;
                emitDiagnostic("ENC", "WINDOW_CLOSED");
                client.stopAdvertising();
                scanCompleteTimeout = () -> completeLeaderScan(nextAttemptId);
                handler.postDelayed(scanCompleteTimeout, CONNECTION_GRACE_MS);
            }
        };
        handler.postDelayed(scanTimeout, timeoutMs);
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
            // Los campos se construyen con primitivas y cadenas ya validadas.
        }
        return result;
    }

    synchronized void shutdown() {
        stopAllInternal(false);
    }

    private final EndpointDiscoveryCallback endpointDiscoveryCallback = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(String endpointId, DiscoveredEndpointInfo info) {
            synchronized (NearbyPresenceManager.this) {
                if (
                    role != Role.READY
                    || info == null
                    || !SERVICE_ID.equals(info.getServiceId())
                    || !requestedEndpoints.add(endpointId)
                ) return;
            }
            emitDiagnostic("AUX", "ENDPOINT_FOUND");
            requestAuxiliaryConnection(endpointId, 0);
        }

        @Override
        public void onEndpointLost(String endpointId) {
            synchronized (NearbyPresenceManager.this) {
                if (role == Role.READY && requestedEndpoints.remove(endpointId)) {
                    emitDiagnostic("AUX", "ENDPOINT_LOST");
                }
            }
        }
    };

    private void requestAuxiliaryConnection(String endpointId, int retryCount) {
        ConnectionOptions connectionOptions = new ConnectionOptions.Builder()
            .setLowPower(true)
            .setConnectionType(ConnectionType.NON_DISRUPTIVE)
            .build();
        emitDiagnostic("AUX", "CONNECTION_REQUEST", Integer.MIN_VALUE, retryCount);
        client.requestConnection(
            ENDPOINT_NAME,
            endpointId,
            connectionLifecycleCallback,
            connectionOptions
        ).addOnFailureListener(error -> {
            int statusCode = nearbyStatusCode(error);
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.READY || !requestedEndpoints.contains(endpointId)) return;
                if (
                    retryCount < MAX_CONNECTION_REQUEST_RETRIES
                    && isRecoverableConnectionRequestFailure(error)
                ) {
                    emitDiagnostic("AUX", "CONNECTION_REQUEST_RETRY", statusCode, retryCount + 1);
                    handler.postDelayed(() -> {
                        synchronized (NearbyPresenceManager.this) {
                            if (role != Role.READY || !requestedEndpoints.contains(endpointId)) return;
                        }
                        requestAuxiliaryConnection(endpointId, retryCount + 1);
                    }, NEARBY_RESTART_DELAY_MS);
                    return;
                }
                requestedEndpoints.remove(endpointId);
            }
            emitDiagnostic("AUX", "CONNECTION_REQUEST_FAILED", statusCode, retryCount);
            emitError("connection_request_failed");
        });
    }

    private final ConnectionLifecycleCallback connectionLifecycleCallback = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(String endpointId, ConnectionInfo info) {
            synchronized (NearbyPresenceManager.this) {
                if (role == Role.IDLE) {
                    client.rejectConnection(endpointId);
                    return;
                }
                if (role == Role.READY && !requestedEndpoints.contains(endpointId)) {
                    client.rejectConnection(endpointId);
                    return;
                }
                String actor = role == Role.LEADER ? "ENC" : "AUX";
                emitDiagnostic(actor, "CONNECTION_INITIATED");
                if (role == Role.LEADER && requestedEndpoints.add(endpointId)) {
                    int pendingCount = requestedEndpoints.size();
                    emit("endpoint_found", event -> event.put("pendingCount", pendingCount));
                }
                client.acceptConnection(endpointId, payloadCallback)
                    .addOnSuccessListener(unused -> emitDiagnostic(actor, "CONNECTION_ACCEPTED"))
                    .addOnFailureListener(error -> {
                        synchronized (NearbyPresenceManager.this) {
                            requestedEndpoints.remove(endpointId);
                        }
                        emitDiagnostic(
                            actor,
                            "CONNECTION_ACCEPT_FAILED",
                            nearbyStatusCode(error),
                            -1
                        );
                        emitError("connection_accept_failed");
                    });
            }
        }

        @Override
        public void onConnectionResult(String endpointId, ConnectionResolution resolution) {
            synchronized (NearbyPresenceManager.this) {
                Status status = resolution == null ? null : resolution.getStatus();
                String actor = role == Role.LEADER ? "ENC" : role == Role.READY ? "AUX" : "APP";
                if (status == null || !status.isSuccess()) {
                    requestedEndpoints.remove(endpointId);
                    emitDiagnostic(
                        actor,
                        "CONNECTION_FAILED",
                        status == null ? Integer.MIN_VALUE : status.getStatusCode(),
                        -1
                    );
                    emitError("connection_failed");
                    return;
                }
                emitDiagnostic(actor, "CONNECTION_ESTABLISHED");
                if (role == Role.LEADER) sendChallenge(endpointId);
            }
        }

        @Override
        public void onDisconnected(String endpointId) {
            synchronized (NearbyPresenceManager.this) {
                requestedEndpoints.remove(endpointId);
            }
        }
    };

    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(String endpointId, Payload payload) {
            byte[] bytes = payload == null ? null : payload.asBytes();
            if (bytes == null || bytes.length == 0 || bytes.length > 32 * 1024) return;
            try {
                JSONObject message = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                String type = message.optString("type");
                synchronized (NearbyPresenceManager.this) {
                    if (role == Role.READY && "challenge".equals(type)) {
                        emitDiagnostic("AUX", "CHALLENGE_RECEIVED");
                        respondToChallenge(endpointId, message);
                    } else if (role == Role.LEADER && "proof".equals(type)) {
                        emitDiagnostic("ENC", "PROOF_RECEIVED_RAW");
                        acceptProof(endpointId, message);
                    }
                }
            } catch (Exception ignored) {
                emitError("payload_invalid");
            }
        }

        @Override
        public void onPayloadTransferUpdate(String endpointId, PayloadTransferUpdate update) {
            if (update == null) return;
            if (
                update.getStatus() == PayloadTransferUpdate.Status.FAILURE
                || update.getStatus() == PayloadTransferUpdate.Status.CANCELED
            ) {
                String actor = role == Role.LEADER ? "ENC" : role == Role.READY ? "AUX" : "APP";
                emitDiagnostic(actor, "PAYLOAD_FAILED");
                emitError("payload_transfer_failed");
            }
        }
    };

    private void sendChallenge(String endpointId) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("type", "challenge");
            payload.put("version", 1);
            payload.put("attemptId", attemptId);
            payload.put("serviceRequestId", scanServiceRequestId);
            payload.put("challenge", challenge);
            payload.put("sentAt", challengeSentAt);
            sendBytes(endpointId, payload);
            emitDiagnostic("ENC", "CHALLENGE_DISPATCHED");
        } catch (Exception ignored) {
            emitError("challenge_build_failed");
        }
    }

    private void respondToChallenge(String endpointId, JSONObject message) {
        try {
            String incomingAttemptId = requiredToken(message.optString("attemptId"), "attemptId");
            String incomingServiceRequestId = requiredToken(
                message.optString("serviceRequestId"),
                "serviceRequestId"
            );
            String incomingChallenge = requiredToken(message.optString("challenge"), "challenge");
            if (!readyServiceRequestId.equals(incomingServiceRequestId)) {
                client.disconnectFromEndpoint(endpointId);
                return;
            }
            if (!incomingChallenge.startsWith("lorren-mark-v1:")) {
                client.disconnectFromEndpoint(endpointId);
                return;
            }
            long sentAt = message.optLong("sentAt", 0L);
            if (sentAt <= 0L || Math.abs(sentAt - System.currentTimeMillis()) > 2 * 60 * 1000L) {
                client.disconnectFromEndpoint(endpointId);
                return;
            }

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
            sendBytes(endpointId, response);
            emitDiagnostic("AUX", "PROOF_DISPATCHED");
            emit("proof_sent", event -> event.put("serviceRequestId", incomingServiceRequestId));
        } catch (Exception ignored) {
            emitError("proof_sign_failed");
        }
    }

    private void acceptProof(String endpointId, JSONObject proof) {
        try {
            if (!attemptId.equals(proof.optString("attemptId"))) return;
            if (!scanServiceRequestId.equals(proof.optString("serviceRequestId"))) return;
            if (!challenge.equals(proof.optString("challenge"))) return;
            long respondedAt = proof.optLong("respondedAt", 0L);
            if (
                respondedAt <= 0L
                || Math.abs(respondedAt - System.currentTimeMillis()) > 2 * 60 * 1000L
            ) return;

            String publicKey = requiredToken(proof.optString("publicKey"), "publicKey");
            String signature = requiredToken(proof.optString("signature"), "signature");
            String canonical = canonicalProof(attemptId, scanServiceRequestId, challenge, respondedAt);
            if (!DeviceKeyStore.verifyBase64(publicKey, canonical, signature)) {
                emitDiagnostic("ENC", "PROOF_SIGNATURE_INVALID");
                emitError("proof_signature_invalid");
                client.disconnectFromEndpoint(endpointId);
                requestedEndpoints.remove(endpointId);
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
            stored.put("credentialState", proof.optString("credentialState", "UNPROVISIONED"));
            stored.put("deviceKeyId", keyId);
            proofsByKey.put(keyId, stored);
            requestedEndpoints.remove(endpointId);

            int verifiedCount = proofsByKey.size();
            int pendingCount = requestedEndpoints.size();
            emitDiagnostic("ENC", "PROOF_VERIFIED");
            emit("proof_received", event -> {
                event.put("deviceKeyId", keyId);
                event.put("verifiedCount", verifiedCount);
                event.put("pendingCount", pendingCount);
                event.put("credentialProvisioned", !stored.optString("credential").isEmpty());
            });

            if (expectedProofCount > 0 && verifiedCount >= expectedProofCount) {
                completeLeaderScan(attemptId);
            } else {
                client.disconnectFromEndpoint(endpointId);
            }
        } catch (Exception ignored) {
            requestedEndpoints.remove(endpointId);
            client.disconnectFromEndpoint(endpointId);
            emitDiagnostic("ENC", "PROOF_INVALID");
            emitError("proof_invalid");
        }
    }

    private void sendBytes(String endpointId, JSONObject payload) {
        client.sendPayload(
            endpointId,
            Payload.fromBytes(payload.toString().getBytes(StandardCharsets.UTF_8))
        ).addOnFailureListener(error -> emitError("payload_send_failed"));
    }

    private synchronized void completeLeaderScan(String completedAttemptId) {
        if (role != Role.LEADER || !attemptId.equals(completedAttemptId)) return;
        cancelLeaderTimers();
        client.stopAdvertising();

        int verifiedCount = proofsByKey.size();
        int pendingCount = requestedEndpoints.size();
        emitDiagnostic("ENC", "SCAN_COMPLETE");
        emit("scan_complete", event -> {
            event.put("attemptId", completedAttemptId);
            event.put("verifiedCount", verifiedCount);
            event.put("pendingCount", pendingCount);
            event.put("expectedProofCount", expectedProofCount);
        });

        client.stopAllEndpoints();
        requestedEndpoints.clear();
        role = Role.IDLE;
    }

    private synchronized void cancelLeaderTimers() {
        if (scanTimeout != null) handler.removeCallbacks(scanTimeout);
        if (scanCompleteTimeout != null) handler.removeCallbacks(scanCompleteTimeout);
        scanTimeout = null;
        scanCompleteTimeout = null;
    }

    private synchronized void resetNearbyClientForRetry() {
        cancelLeaderTimers();
        client.stopAdvertising();
        client.stopDiscovery();
        client.stopAllEndpoints();
        requestedEndpoints.clear();
    }

    private synchronized void stopAllInternal(boolean notify) {
        cancelLeaderTimers();
        client.stopAdvertising();
        client.stopDiscovery();
        client.stopAllEndpoints();
        requestedEndpoints.clear();
        readyServiceRequestId = "";
        attemptId = "";
        scanServiceRequestId = "";
        challenge = "";
        challengeSentAt = 0L;
        expectedProofCount = 0;
        proofsByKey.clear();
        role = Role.IDLE;
        if (notify) emit("stopped", event -> {});
    }

    private static boolean isRecoverableStartFailure(Exception error) {
        int statusCode = nearbyStatusCode(error);
        return statusCode == ConnectionsStatusCodes.STATUS_ALREADY_ADVERTISING
            || statusCode == ConnectionsStatusCodes.STATUS_ALREADY_DISCOVERING
            || statusCode == ConnectionsStatusCodes.STATUS_ALREADY_HAVE_ACTIVE_STRATEGY
            || statusCode == ConnectionsStatusCodes.STATUS_OUT_OF_ORDER_API_CALL;
    }

    private static boolean isRecoverableConnectionRequestFailure(Exception error) {
        int statusCode = nearbyStatusCode(error);
        return statusCode == ConnectionsStatusCodes.STATUS_RADIO_ERROR
            || statusCode == ConnectionsStatusCodes.STATUS_ERROR;
    }

    private static String nearbyStartErrorCode(Exception error, String fallback) {
        int statusCode = nearbyStatusCode(error);
        if (isMissingPermissionStatus(statusCode)) return "permissions_required";
        if (statusCode == ConnectionsStatusCodes.STATUS_RADIO_ERROR) return "nearby_radio_error";
        if (statusCode == ConnectionsStatusCodes.API_CONNECTION_FAILED_ALREADY_IN_USE) {
            return "nearby_in_use";
        }
        if (isRecoverableStartFailure(error)) return "nearby_state_conflict";
        return fallback;
    }

    private static int nearbyStatusCode(Exception error) {
        return error instanceof ApiException ? ((ApiException) error).getStatusCode() : Integer.MIN_VALUE;
    }

    private static boolean isMissingPermissionStatus(int statusCode) {
        return statusCode == ConnectionsStatusCodes.MISSING_PERMISSION_ACCESS_COARSE_LOCATION
            || statusCode == ConnectionsStatusCodes.MISSING_PERMISSION_ACCESS_FINE_LOCATION
            || statusCode == ConnectionsStatusCodes.MISSING_PERMISSION_ACCESS_WIFI_STATE
            || statusCode == ConnectionsStatusCodes.MISSING_PERMISSION_CHANGE_WIFI_STATE
            || statusCode == ConnectionsStatusCodes.MISSING_PERMISSION_BLUETOOTH
            || statusCode == ConnectionsStatusCodes.MISSING_PERMISSION_BLUETOOTH_ADMIN
            || statusCode == ConnectionsStatusCodes.MISSING_PERMISSION_BLUETOOTH_ADVERTISE
            || statusCode == ConnectionsStatusCodes.MISSING_PERMISSION_BLUETOOTH_CONNECT
            || statusCode == ConnectionsStatusCodes.MISSING_PERMISSION_BLUETOOTH_SCAN
            || statusCode == ConnectionsStatusCodes.MISSING_PERMISSION_NEARBY_WIFI_DEVICES;
    }

    private String safeCredential() {
        String credential = credentialProvider.credential();
        if (credential == null) return "";
        String normalized = credential.trim();
        return normalized.length() > 16_384 ? "" : normalized;
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
        emitDiagnostic(actor, stage, Integer.MIN_VALUE, -1);
    }

    private void emitDiagnostic(String actor, String stage, int statusCode, int retryCount) {
        emit("diagnostic", event -> {
            event.put("actor", actor);
            event.put("stage", stage);
            if (statusCode != Integer.MIN_VALUE) event.put("statusCode", statusCode);
            if (retryCount >= 0) event.put("retryCount", retryCount);
        });
    }

    private void emitError(String code) {
        emit("error", event -> event.put("code", code));
    }
}
