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
import com.google.android.gms.nearby.connection.ConnectionResolution;
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
    private static final long MIN_SCAN_MS = 5_000L;
    private static final long MAX_SCAN_MS = 30_000L;
    private static final long CONNECTION_GRACE_MS = 1_200L;
    private static final long NEARBY_RESTART_DELAY_MS = 350L;
    private static final int MAX_START_RETRIES = 1;

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
        startReadyDiscovery(normalizedService, 0);
    }

    private void startReadyDiscovery(String normalizedService, int retryCount) {
        DiscoveryOptions options = new DiscoveryOptions.Builder().setStrategy(STRATEGY).build();
        try {
            client.startDiscovery(SERVICE_ID, endpointDiscoveryCallback, options)
                .addOnSuccessListener(unused -> {
                    synchronized (NearbyPresenceManager.this) {
                        if (role != Role.READY || !readyServiceRequestId.equals(normalizedService)) {
                            client.stopDiscovery();
                            return;
                        }
                    }
                    emit("ready", event -> event.put("serviceRequestId", normalizedService));
                })
                .addOnFailureListener(error -> handleDiscoveryStartFailure(normalizedService, retryCount, error));
        } catch (RuntimeException error) {
            handleDiscoveryStartFailure(normalizedService, retryCount, error);
        }
    }

    private void handleDiscoveryStartFailure(String normalizedService, int retryCount, Exception error) {
        if (retryCount < MAX_START_RETRIES && isRecoverableStartFailure(error)) {
            resetNearbyClientForRetry();
            handler.postDelayed(() -> {
                synchronized (NearbyPresenceManager.this) {
                    if (role != Role.READY || !readyServiceRequestId.equals(normalizedService)) return;
                }
                startReadyDiscovery(normalizedService, retryCount + 1);
            }, NEARBY_RESTART_DELAY_MS);
            return;
        }
        synchronized (this) {
            if (role == Role.READY && readyServiceRequestId.equals(normalizedService)) role = Role.IDLE;
        }
        emitError(nearbyStartErrorCode(error, "discovery_failed"));
    }

    synchronized void startLeaderScan(JSONObject input) {
        String nextAttemptId = requiredToken(input.optString("attemptId"), "attemptId");
        String serviceRequestId = requiredToken(input.optString("serviceRequestId"), "serviceRequestId");
        String nextChallenge = requiredToken(input.optString("challenge"), "challenge");
        long timeoutMs = Math.max(MIN_SCAN_MS, Math.min(MAX_SCAN_MS, input.optLong("timeoutMs", 12_000L)));

        stopAllInternal(false);
        role = Role.LEADER;
        attemptId = nextAttemptId;
        scanServiceRequestId = serviceRequestId;
        challenge = nextChallenge;
        challengeSentAt = System.currentTimeMillis();
        proofsByKey.clear();
        requestedEndpoints.clear();
        startLeaderAdvertising(nextAttemptId, serviceRequestId, timeoutMs, 0);
    }

    private void startLeaderAdvertising(
        String nextAttemptId,
        String serviceRequestId,
        long timeoutMs,
        int retryCount
    ) {
        AdvertisingOptions options = new AdvertisingOptions.Builder().setStrategy(STRATEGY).build();
        try {
            client.startAdvertising(ENDPOINT_NAME, SERVICE_ID, connectionLifecycleCallback, options)
                .addOnSuccessListener(unused -> {
                    synchronized (NearbyPresenceManager.this) {
                        if (role != Role.LEADER || !attemptId.equals(nextAttemptId)) {
                            client.stopAdvertising();
                            return;
                        }
                    }
                    emit("scan_started", event -> {
                        event.put("attemptId", nextAttemptId);
                        event.put("serviceRequestId", serviceRequestId);
                        event.put("timeoutMs", timeoutMs);
                    });
                    scheduleLeaderScanTimeout(nextAttemptId, timeoutMs);
                })
                .addOnFailureListener(error -> handleAdvertisingStartFailure(
                    nextAttemptId,
                    serviceRequestId,
                    timeoutMs,
                    retryCount,
                    error
                ));
        } catch (RuntimeException error) {
            handleAdvertisingStartFailure(
                nextAttemptId,
                serviceRequestId,
                timeoutMs,
                retryCount,
                error
            );
        }
    }

    private void handleAdvertisingStartFailure(
        String nextAttemptId,
        String serviceRequestId,
        long timeoutMs,
        int retryCount,
        Exception error
    ) {
        if (retryCount < MAX_START_RETRIES && isRecoverableStartFailure(error)) {
            resetNearbyClientForRetry();
            handler.postDelayed(() -> {
                synchronized (NearbyPresenceManager.this) {
                    if (role != Role.LEADER || !attemptId.equals(nextAttemptId)) return;
                }
                startLeaderAdvertising(nextAttemptId, serviceRequestId, timeoutMs, retryCount + 1);
            }, NEARBY_RESTART_DELAY_MS);
            return;
        }
        synchronized (this) {
            if (role == Role.LEADER && attemptId.equals(nextAttemptId)) role = Role.IDLE;
            cancelLeaderTimers();
        }
        emitError(nearbyStartErrorCode(error, "advertising_failed"));
    }

    private synchronized void scheduleLeaderScanTimeout(String nextAttemptId, long timeoutMs) {
        if (role != Role.LEADER || !attemptId.equals(nextAttemptId)) return;
        if (scanTimeout != null) handler.removeCallbacks(scanTimeout);
        scanTimeout = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER || !attemptId.equals(nextAttemptId)) return;
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
            for (JSONObject proof : proofsByKey.values()) proofs.put(new JSONObject(proof.toString()));
            result.put("proofs", proofs);
        } catch (Exception ignored) {
            // JSONObject fields above use non-null primitives/strings and should not fail.
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
                if (role != Role.READY || !SERVICE_ID.equals(info.getServiceId())) return;
                if (!requestedEndpoints.add(endpointId)) return;
                emit("leader_found", event -> event.put("candidateCount", requestedEndpoints.size()));
                client.requestConnection(ENDPOINT_NAME, endpointId, connectionLifecycleCallback)
                    .addOnFailureListener(error -> {
                        synchronized (NearbyPresenceManager.this) {
                            requestedEndpoints.remove(endpointId);
                        }
                        emitError("connection_request_failed");
                    });
            }
        }

        @Override
        public void onEndpointLost(String endpointId) {
            synchronized (NearbyPresenceManager.this) {
                if (role == Role.READY) requestedEndpoints.remove(endpointId);
            }
        }
    };

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
                if (role == Role.LEADER && requestedEndpoints.add(endpointId)) {
                    emit("endpoint_found", event -> event.put("pendingCount", requestedEndpoints.size()));
                }
                client.acceptConnection(endpointId, payloadCallback)
                    .addOnFailureListener(error -> emitError("connection_accept_failed"));
            }
        }

        @Override
        public void onConnectionResult(String endpointId, ConnectionResolution resolution) {
            synchronized (NearbyPresenceManager.this) {
                Status status = resolution.getStatus();
                if (!status.isSuccess()) {
                    requestedEndpoints.remove(endpointId);
                    emitError("connection_failed");
                    return;
                }
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
            byte[] bytes = payload.asBytes();
            if (bytes == null || bytes.length == 0 || bytes.length > 64 * 1024) return;
            try {
                JSONObject message = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                String type = message.optString("type");
                synchronized (NearbyPresenceManager.this) {
                    if (role == Role.READY && "challenge".equals(type)) {
                        respondToChallenge(endpointId, message);
                    } else if (role == Role.LEADER && "proof".equals(type)) {
                        acceptProof(endpointId, message);
                    }
                }
            } catch (Exception ignored) {
                emitError("payload_invalid");
            }
        }

        @Override
        public void onPayloadTransferUpdate(String endpointId, PayloadTransferUpdate update) {
            if (
                update.getStatus() == PayloadTransferUpdate.Status.FAILURE
                || update.getStatus() == PayloadTransferUpdate.Status.CANCELED
            ) {
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
        } catch (Exception ignored) {
            emitError("challenge_build_failed");
        }
    }

    private void respondToChallenge(String endpointId, JSONObject message) {
        try {
            String incomingAttemptId = requiredToken(message.optString("attemptId"), "attemptId");
            String incomingServiceRequestId = requiredToken(message.optString("serviceRequestId"), "serviceRequestId");
            String incomingChallenge = requiredToken(message.optString("challenge"), "challenge");
            if (!readyServiceRequestId.equals(incomingServiceRequestId)) {
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
            if (respondedAt <= 0L || Math.abs(respondedAt - System.currentTimeMillis()) > 2 * 60 * 1000L) return;
            String publicKey = requiredToken(proof.optString("publicKey"), "publicKey");
            String signature = requiredToken(proof.optString("signature"), "signature");
            String canonical = canonicalProof(attemptId, scanServiceRequestId, challenge, respondedAt);
            if (!DeviceKeyStore.verifyBase64(publicKey, canonical, signature)) {
                emitError("proof_signature_invalid");
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
            emit("proof_received", event -> {
                event.put("deviceKeyId", keyId);
                event.put("verifiedCount", proofsByKey.size());
                event.put("pendingCount", requestedEndpoints.size());
                event.put("credentialProvisioned", !stored.optString("credential").isEmpty());
            });
            client.disconnectFromEndpoint(endpointId);
        } catch (Exception ignored) {
            emitError("proof_invalid");
        }
    }

    private void sendBytes(String endpointId, JSONObject payload) {
        client.sendPayload(endpointId, Payload.fromBytes(payload.toString().getBytes(StandardCharsets.UTF_8)))
            .addOnFailureListener(error -> emitError("payload_send_failed"));
    }

    private synchronized void completeLeaderScan(String completedAttemptId) {
        if (role != Role.LEADER || !attemptId.equals(completedAttemptId)) return;
        scanTimeout = null;
        emit("scan_complete", event -> {
            event.put("attemptId", completedAttemptId);
            event.put("verifiedCount", proofsByKey.size());
            event.put("pendingCount", requestedEndpoints.size());
        });
        client.stopAllEndpoints();
        requestedEndpoints.clear();
        role = Role.IDLE;
        scanCompleteTimeout = null;
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

    private static String nearbyStartErrorCode(Exception error, String fallback) {
        int statusCode = nearbyStatusCode(error);
        if (isMissingPermissionStatus(statusCode)) return "permissions_required";
        if (statusCode == ConnectionsStatusCodes.STATUS_RADIO_ERROR) return "nearby_radio_error";
        if (statusCode == ConnectionsStatusCodes.API_CONNECTION_FAILED_ALREADY_IN_USE) return "nearby_in_use";
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
            // Los eventos de UI nunca cambian la autoridad de presencia.
        }
    }

    private void emitError(String code) {
        emit("error", event -> event.put("code", code));
    }
}
