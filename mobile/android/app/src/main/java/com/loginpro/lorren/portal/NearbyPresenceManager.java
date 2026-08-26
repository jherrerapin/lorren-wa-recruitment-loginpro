package com.loginpro.lorren.portal;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;

import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
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
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Autoridad nativa única de presencia local de cuadrilla.
 * 
 * Implementación definitiva usando Google Nearby Connections (P2P_STAR).
 * Soluciona los bloqueos de hardware y elimina la necesidad de visibilidad manual.
 */
final class NearbyPresenceManager {
    interface EventSink {
        void emit(JSONObject event);
    }

    interface CredentialProvider {
        String credential();
    }

    private static final String SERVICE_ID = "com.loginpro.lorren.portal.CREW_PRESENCE";
    private static final Strategy STRATEGY = Strategy.P2P_STAR;
    private static final long MIN_SCAN_MS = 35_000L;
    private static final long MAX_SCAN_MS = 45_000L;
    private static final long CONNECTION_GRACE_MS = 1_500L;

    private enum Role { IDLE, READY, LEADER }

    private final ConnectionsClient connectionsClient;
    private final EventSink eventSink;
    private final CredentialProvider credentialProvider;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private Role role = Role.IDLE;

    // Estado AUX (Advertiser)
    private String readyServiceRequestId = "";
    private String connectedLeaderEndpointId = null;

    // Estado ENC (Discoverer)
    private String attemptId = "";
    private String scanServiceRequestId = "";
    private String challenge = "";
    private long challengeSentAt = 0L;
    private int expectedProofCount = 0;
    private long leaderTimeoutMs = MIN_SCAN_MS;
    
    private final Map<String, JSONObject> proofsByKey = new LinkedHashMap<>();
    private final Set<String> leaderConnectionEndpoints = new LinkedHashSet<>();
    private Runnable leaderTimeout;
    private Runnable leaderCompleteTimeout;

    NearbyPresenceManager(Context context, EventSink eventSink, CredentialProvider credentialProvider) {
        this.connectionsClient = Nearby.getConnectionsClient(context.getApplicationContext());
        this.eventSink = eventSink;
        this.credentialProvider = credentialProvider;
    }

    // =========================================================================
    // CALLBACKS COMPARTIDOS (CONEXIÓN Y PAYLOAD)
    // =========================================================================

    private final ConnectionLifecycleCallback connectionLifecycleCallback = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            synchronized (NearbyPresenceManager.this) {
                if (role == Role.IDLE) {
                    connectionsClient.rejectConnection(endpointId);
                    return;
                }
                emitDiagnostic(role == Role.LEADER ? "ENC" : "AUX", "CONNECTION_INITIATED");
            }
            connectionsClient.acceptConnection(endpointId, payloadCallback);
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution result) {
            synchronized (NearbyPresenceManager.this) {
                if (role == Role.IDLE) return;
                
                if (result.getStatus().isSuccess()) {
                    emitDiagnostic(role == Role.LEADER ? "ENC" : "AUX", "CONNECTION_ESTABLISHED");
                    
                    if (role == Role.LEADER) {
                        leaderConnectionEndpoints.add(endpointId);
                        sendChallengeToAuxiliary(endpointId);
                    } else if (role == Role.READY) {
                        connectedLeaderEndpointId = endpointId;
                    }
                } else {
                    emitDiagnostic(role == Role.LEADER ? "ENC" : "AUX", "CONNECTION_FAILED");
                    if (role == Role.LEADER) leaderConnectionEndpoints.remove(endpointId);
                }
            }
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            synchronized (NearbyPresenceManager.this) {
                if (role == Role.LEADER) leaderConnectionEndpoints.remove(endpointId);
                else if (role == Role.READY && endpointId.equals(connectedLeaderEndpointId)) {
                    connectedLeaderEndpointId = null;
                }
            }
        }
    };

    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            if (payload.getType() != Payload.Type.BYTES) return;
            
            try {
                String jsonString = new String(payload.asBytes(), StandardCharsets.UTF_8);
                JSONObject message = new JSONObject(jsonString);
                String type = message.optString("type", "");

                synchronized (NearbyPresenceManager.this) {
                    if (role == Role.READY && "challenge".equals(type)) {
                        handleIncomingChallenge(endpointId, message);
                    } else if (role == Role.LEADER && "proof".equals(type)) {
                        handleIncomingProof(endpointId, message);
                    }
                }
            } catch (Exception error) {
                emitDiagnostic(role == Role.LEADER ? "ENC" : "AUX", "PAYLOAD_FAILED");
            }
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {}
    };

    // =========================================================================
    // LÓGICA DEL AUXILIAR (READY / ADVERTISING)
    // =========================================================================

    synchronized void startReady(String serviceRequestId) {
        String normalizedService = requiredToken(serviceRequestId, "serviceRequestId");
        stopAllInternal(false);
        role = Role.READY;
        readyServiceRequestId = normalizedService;
        emitDiagnostic("AUX", "READY_REQUESTED");

        AdvertisingOptions options = new AdvertisingOptions.Builder().setStrategy(STRATEGY).build();
        connectionsClient.startAdvertising("LorrenAux", SERVICE_ID, connectionLifecycleCallback, options)
            .addOnSuccessListener(unused -> {
                synchronized (NearbyPresenceManager.this) {
                    if (role == Role.READY) {
                        emitDiagnostic("AUX", "ADVERTISING_READY");
                        emitReady();
                    }
                }
            })
            .addOnFailureListener(e -> {
                failReady("advertising_failed");
            });
    }

    private void handleIncomingChallenge(String endpointId, JSONObject message) throws Exception {
        String incomingAttemptId = requiredToken(message.optString("attemptId"), "attemptId");
        String incomingServiceRequestId = requiredToken(message.optString("serviceRequestId"), "serviceRequestId");
        String incomingChallenge = requiredToken(message.optString("challenge"), "challenge");

        if (!readyServiceRequestId.equals(incomingServiceRequestId)) return;
        emitDiagnostic("AUX", "CHALLENGE_RECEIVED");

        long respondedAt = System.currentTimeMillis();
        String publicKey = DeviceKeyStore.publicKeyBase64();
        String canonical = canonicalProof(incomingAttemptId, incomingServiceRequestId, incomingChallenge, respondedAt);
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

        Payload bytesPayload = Payload.fromBytes(response.toString().getBytes(StandardCharsets.UTF_8));
        connectionsClient.sendPayload(endpointId, bytesPayload);
        
        emitDiagnostic("AUX", "PROOF_DISPATCHED");
        String completedService = readyServiceRequestId;
        emit("proof_sent", event -> event.put("serviceRequestId", completedService));
    }

    private synchronized void emitReady() {
        String service = readyServiceRequestId;
        emit("ready", event -> event.put("serviceRequestId", service));
    }

    private synchronized void failReady(String code) {
        stopAllInternal(false);
        emitError(code);
    }

    // =========================================================================
    // LÓGICA DEL ENCARGADO (LEADER / DISCOVERY)
    // =========================================================================

    private final EndpointDiscoveryCallback endpointDiscoveryCallback = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER) return;
                emitDiagnostic("ENC", "ENDPOINT_FOUND");
                connectionsClient.requestConnection("LorrenLeader", endpointId, connectionLifecycleCallback)
                    .addOnSuccessListener(unused -> emitDiagnostic("ENC", "CONNECTION_REQUEST"))
                    .addOnFailureListener(e -> emitDiagnostic("ENC", "CONNECTION_REQUEST_FAILED"));
            }
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {
            emitDiagnostic("ENC", "ENDPOINT_LOST");
        }
    };

    synchronized void startLeaderScan(JSONObject input) {
        String nextAttemptId = requiredToken(input.optString("attemptId"), "attemptId");
        String serviceRequestId = requiredToken(input.optString("serviceRequestId"), "serviceRequestId");
        String nextChallenge = requiredToken(input.optString("challenge"), "challenge");
        long timeoutMs = Math.max(MIN_SCAN_MS, Math.min(MAX_SCAN_MS, input.optLong("timeoutMs", MIN_SCAN_MS)));
        int nextExpectedProofCount = Math.max(0, input.optInt("expectedProofCount", 0));

        stopAllInternal(false);
        role = Role.LEADER;
        attemptId = nextAttemptId;
        scanServiceRequestId = serviceRequestId;
        challenge = nextChallenge;
        expectedProofCount = nextExpectedProofCount;
        leaderTimeoutMs = timeoutMs;
        proofsByKey.clear();
        leaderConnectionEndpoints.clear();

        emitDiagnostic("ENC", "SCAN_REQUESTED");

        if (expectedProofCount == 0) {
            challengeSentAt = System.currentTimeMillis();
            emitLeaderScanStarted();
            completeLeaderScan(nextAttemptId);
            return;
        }

        DiscoveryOptions options = new DiscoveryOptions.Builder().setStrategy(STRATEGY).build();
        connectionsClient.startDiscovery(SERVICE_ID, endpointDiscoveryCallback, options)
            .addOnSuccessListener(unused -> {
                synchronized (NearbyPresenceManager.this) {
                    if (role == Role.LEADER) {
                        emitDiagnostic("ENC", "DISCOVERY_READY");
                        challengeSentAt = System.currentTimeMillis();
                        emitLeaderScanStarted();
                        scheduleLeaderTimeout(nextAttemptId, leaderTimeoutMs);
                    }
                }
            })
            .addOnFailureListener(e -> failLeaderStart("discovery_failed"));
    }

    private void sendChallengeToAuxiliary(String endpointId) {
        try {
            JSONObject payloadJson = new JSONObject();
            payloadJson.put("type", "challenge");
            payloadJson.put("version", 1);
            payloadJson.put("attemptId", attemptId);
            payloadJson.put("serviceRequestId", scanServiceRequestId);
            payloadJson.put("challenge", challenge);
            payloadJson.put("sentAt", challengeSentAt);

            Payload bytesPayload = Payload.fromBytes(payloadJson.toString().getBytes(StandardCharsets.UTF_8));
            connectionsClient.sendPayload(endpointId, bytesPayload);
            emitDiagnostic("ENC", "CHALLENGE_DISPATCHED");
        } catch (Exception e) {
            emitDiagnostic("ENC", "PAYLOAD_FAILED");
        }
    }

    private void handleIncomingProof(String endpointId, JSONObject proof) {
        emitDiagnostic("ENC", "PROOF_RECEIVED_RAW");
        try {
            if (!attemptId.equals(proof.optString("attemptId")) ||
                !scanServiceRequestId.equals(proof.optString("serviceRequestId")) ||
                !challenge.equals(proof.optString("challenge"))) {
                throw new Exception("proof_mismatch");
            }

            long respondedAt = proof.optLong("respondedAt", 0L);
            String publicKey = requiredToken(proof.optString("publicKey"), "publicKey");
            String signature = requiredToken(proof.optString("signature"), "signature");
            
            String canonical = canonicalProof(attemptId, scanServiceRequestId, challenge, respondedAt);
            if (!DeviceKeyStore.verifyBase64(publicKey, canonical, signature)) {
                emitDiagnostic("ENC", "PROOF_SIGNATURE_INVALID");
                throw new Exception("invalid_signature");
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
            
            // Ya obtuvimos la prueba, desconectamos para liberar recursos
            connectionsClient.disconnectFromEndpoint(endpointId);
            leaderConnectionEndpoints.remove(endpointId);

            int verifiedCount = proofsByKey.size();
            int pendingCount = leaderConnectionEndpoints.size();
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
        } catch (Exception e) {
            emitDiagnostic("ENC", "PROOF_INVALID");
            connectionsClient.disconnectFromEndpoint(endpointId);
        }
    }

    private synchronized void scheduleLeaderTimeout(String completedAttemptId, long timeoutMs) {
        if (leaderTimeout != null) handler.removeCallbacks(leaderTimeout);
        leaderTimeout = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER || !attemptId.equals(completedAttemptId)) return;
                emitDiagnostic("ENC", "WINDOW_CLOSED");
                connectionsClient.stopDiscovery();
                
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
        stopAllInternal(false);
        emitError(code);
    }

    private synchronized void completeLeaderScan(String completedAttemptId) {
        if (role != Role.LEADER || !attemptId.equals(completedAttemptId)) return;
        
        int verifiedCount = proofsByKey.size();
        int pendingCount = leaderConnectionEndpoints.size();

        emitDiagnostic("ENC", "SCAN_COMPLETE");
        emit("scan_complete", event -> {
            event.put("attemptId", completedAttemptId);
            event.put("verifiedCount", verifiedCount);
            event.put("pendingCount", pendingCount);
            event.put("expectedProofCount", expectedProofCount);
        });
        
        stopAllInternal(false);
    }

    // =========================================================================
    // CONTROL DE CICLO DE VIDA Y UTILIDADES
    // =========================================================================

    synchronized void stopReady() {
        if (role == Role.READY) stopAllInternal(true);
    }

    synchronized void stopLeaderScan() {
        if (role == Role.LEADER) stopAllInternal(true);
    }

    synchronized void shutdown() {
        stopAllInternal(false);
    }

    private synchronized void stopAllInternal(boolean notify) {
        if (leaderTimeout != null) handler.removeCallbacks(leaderTimeout);
        if (leaderCompleteTimeout != null) handler.removeCallbacks(leaderCompleteTimeout);
        leaderTimeout = null;
        leaderCompleteTimeout = null;

        connectionsClient.stopAdvertising();
        connectionsClient.stopDiscovery();
        connectionsClient.stopAllEndpoints();

        readyServiceRequestId = "";
        attemptId = "";
        scanServiceRequestId = "";
        challenge = "";
        challengeSentAt = 0L;
        expectedProofCount = 0;
        leaderTimeoutMs = MIN_SCAN_MS;
        proofsByKey.clear();
        leaderConnectionEndpoints.clear();
        connectedLeaderEndpointId = null;
        
        role = Role.IDLE;
        if (notify) emit("stopped", event -> {});
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
        } catch (Exception ignored) {}
        return result;
    }

    private static String canonicalProof(String attemptId, String serviceRequestId, String challenge, long respondedAt) {
        return "lorren-presence-v1\n" + attemptId + "\n" + serviceRequestId + "\n" + challenge + "\n" + respondedAt;
    }

    private static String keyId(String publicKeyBase64) throws Exception {
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(android.util.Base64.decode(publicKeyBase64, android.util.Base64.NO_WRAP));
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < 6; index += 1) {
            builder.append(String.format("%02x", digest[index] & 0xff));
        }
        return builder.toString();
    }

    private static String requiredToken(String value, String label) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.isEmpty() || normalized.length() > 2_048) throw new IllegalArgumentException(label + "_invalid");
        return normalized;
    }

    private String safeCredential() {
        String credential = credentialProvider.credential();
        if (credential == null) return "";
        String normalized = credential.trim();
        return normalized.length() > MAX_MESSAGE_BYTES ? "" : normalized;
    }

    private interface EventWriter {
        void write(JSONObject event) throws Exception;
    }

    private void emit(String type, EventWriter writer) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", type);
            writer.write(event);
            // Aseguramos que se emite en el hilo principal
            handler.post(() -> eventSink.emit(event));
        } catch (Exception ignored) {}
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
}
