package com.loginpro.lorren.portal;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Autoridad nativa única de presencia local de cuadrilla.
 *
 * El nombre histórico de la clase se conserva para no crear un segundo manager/bridge,
 * pero el transporte es BLE Android nativo: advertiser + scanner + GATT. No usa Google
 * Nearby Connections ni Wi-Fi.
 */
final class NearbyPresenceManager {
    interface EventSink {
        void emit(JSONObject event);
    }

    interface CredentialProvider {
        String credential();
    }

    private static final UUID SERVICE_UUID = UUID.fromString("6f727265-6e2d-4352-4557-505245530001");
    private static final UUID CHALLENGE_UUID = UUID.fromString("6f727265-6e2d-4352-4557-505245530002");
    private static final UUID PROOF_UUID = UUID.fromString("6f727265-6e2d-4352-4557-505245530003");
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final ParcelUuid SERVICE_PARCEL_UUID = new ParcelUuid(SERVICE_UUID);

    private static final long MIN_SCAN_MS = 4_000L;
    private static final long MAX_SCAN_MS = 30_000L;
    private static final long FILTERED_SCAN_FALLBACK_MS = 2_000L;
    private static final long CONNECTION_GRACE_MS = 1_500L;
    private static final long SERVICE_DISCOVERY_FALLBACK_MS = 700L;
    private static final int REQUESTED_MTU = 517;
    private static final int DEFAULT_MTU = 23;
    private static final int MAX_FRAME_BYTES = 16_384;
    private static final int FRAME_HEADER_BYTES = 6;
    private static final int FRAME_MAGIC = 0x4c;
    private static final int FRAME_VERSION = 1;
    private static final int FRAME_TYPE_CHALLENGE = 1;
    private static final int FRAME_TYPE_PROOF = 2;
    private static final int FRAME_FLAG_FINAL = 1;

    private enum Role { IDLE, READY, LEADER }

    private final Context appContext;
    private final BluetoothManager bluetoothManager;
    private final BluetoothAdapter bluetoothAdapter;
    private final EventSink eventSink;
    private final CredentialProvider credentialProvider;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private final Map<String, JSONObject> proofsByKey = new LinkedHashMap<>();
    private final Map<String, LeaderPeer> leaderPeers = new LinkedHashMap<>();
    private final Set<String> attemptedAddresses = new LinkedHashSet<>();
    private final Map<String, FrameAccumulator> incomingChallenges = new LinkedHashMap<>();
    private final Map<String, Integer> serverMtuByAddress = new LinkedHashMap<>();
    private final Set<String> notificationSubscribers = new LinkedHashSet<>();
    private final Map<String, OutgoingProof> outgoingProofs = new LinkedHashMap<>();

    private Role role = Role.IDLE;
    private String readyServiceRequestId = "";
    private String attemptId = "";
    private String scanServiceRequestId = "";
    private String challenge = "";
    private long challengeSentAt = 0L;
    private int expectedProofCount = 0;
    private Runnable scanFilterFallback;
    private Runnable scanTimeout;
    private Runnable scanCompleteTimeout;
    private boolean softwareFilteredScan = false;

    private BluetoothLeAdvertiser advertiser;
    private BluetoothLeScanner scanner;
    private BluetoothGattServer gattServer;
    private BluetoothGattCharacteristic challengeCharacteristic;
    private BluetoothGattCharacteristic proofCharacteristic;

    NearbyPresenceManager(Context context, EventSink eventSink, CredentialProvider credentialProvider) {
        this.appContext = context.getApplicationContext();
        this.bluetoothManager = (BluetoothManager) appContext.getSystemService(Context.BLUETOOTH_SERVICE);
        this.bluetoothAdapter = bluetoothManager == null ? null : bluetoothManager.getAdapter();
        this.eventSink = eventSink;
        this.credentialProvider = credentialProvider;
    }

    synchronized void startReady(String serviceRequestId) {
        String normalizedService = requiredToken(serviceRequestId, "serviceRequestId");
        stopAllInternal(false);
        role = Role.READY;
        readyServiceRequestId = normalizedService;
        startReadyGattServer();
    }

    private synchronized void startReadyGattServer() {
        if (role != Role.READY || bluetoothManager == null || bluetoothAdapter == null) {
            failReady("advertising_failed");
            return;
        }
        try {
            advertiser = bluetoothAdapter.getBluetoothLeAdvertiser();
            if (advertiser == null) {
                failReady("advertising_failed");
                return;
            }
            gattServer = bluetoothManager.openGattServer(appContext, gattServerCallback);
            if (gattServer == null) {
                failReady("advertising_failed");
                return;
            }

            BluetoothGattService service = new BluetoothGattService(
                SERVICE_UUID,
                BluetoothGattService.SERVICE_TYPE_PRIMARY
            );
            challengeCharacteristic = new BluetoothGattCharacteristic(
                CHALLENGE_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_WRITE
            );
            proofCharacteristic = new BluetoothGattCharacteristic(
                PROOF_UUID,
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ
            );
            BluetoothGattDescriptor cccd = new BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE
            );
            proofCharacteristic.addDescriptor(cccd);
            service.addCharacteristic(challengeCharacteristic);
            service.addCharacteristic(proofCharacteristic);
            if (!gattServer.addService(service)) {
                failReady("advertising_failed");
            }
        } catch (RuntimeException error) {
            failReady("advertising_failed");
        }
    }

    private synchronized void startReadyAdvertising() {
        if (role != Role.READY || advertiser == null || gattServer == null) return;
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .setTimeout(0)
            .build();
        AdvertiseData data = new AdvertiseData.Builder()
            .addServiceUuid(SERVICE_PARCEL_UUID)
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .build();
        try {
            advertiser.startAdvertising(settings, data, advertiseCallback);
        } catch (RuntimeException error) {
            failReady("advertising_failed");
        }
    }

    private synchronized void failReady(String code) {
        stopReadyResources();
        role = Role.IDLE;
        emitError(code);
    }

    synchronized void startLeaderScan(JSONObject input) {
        String nextAttemptId = requiredToken(input.optString("attemptId"), "attemptId");
        String serviceRequestId = requiredToken(input.optString("serviceRequestId"), "serviceRequestId");
        String nextChallenge = requiredToken(input.optString("challenge"), "challenge");
        long timeoutMs = Math.max(MIN_SCAN_MS, Math.min(MAX_SCAN_MS, input.optLong("timeoutMs", 6_000L)));
        int nextExpectedProofCount = Math.max(0, input.optInt("expectedProofCount", 0));

        stopAllInternal(false);
        role = Role.LEADER;
        attemptId = nextAttemptId;
        scanServiceRequestId = serviceRequestId;
        challenge = nextChallenge;
        challengeSentAt = System.currentTimeMillis();
        expectedProofCount = nextExpectedProofCount;
        proofsByKey.clear();
        leaderPeers.clear();
        attemptedAddresses.clear();
        softwareFilteredScan = false;

        if (bluetoothAdapter == null) {
            role = Role.IDLE;
            emitError("discovery_failed");
            return;
        }
        try {
            scanner = bluetoothAdapter.getBluetoothLeScanner();
            if (scanner == null) {
                role = Role.IDLE;
                emitError("discovery_failed");
                return;
            }
            scanner.startScan(
                Collections.singletonList(lorrenScanFilter()),
                leaderScanSettings(),
                scanCallback
            );
            emit("scan_started", event -> {
                event.put("attemptId", nextAttemptId);
                event.put("serviceRequestId", serviceRequestId);
                event.put("timeoutMs", timeoutMs);
                event.put("expectedProofCount", expectedProofCount);
            });
            if (expectedProofCount == 0) {
                completeLeaderScan(nextAttemptId);
                return;
            }
            scheduleSoftwareFilterFallback(nextAttemptId, timeoutMs);
            scheduleLeaderScanTimeout(nextAttemptId, timeoutMs);
        } catch (RuntimeException error) {
            stopLeaderScanner();
            role = Role.IDLE;
            emitError("discovery_failed");
        }
    }

    private static ScanFilter lorrenScanFilter() {
        return new ScanFilter.Builder()
            .setServiceUuid(SERVICE_PARCEL_UUID)
            .build();
    }

    private static ScanSettings leaderScanSettings() {
        return new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setReportDelay(0L)
            .build();
    }

    private synchronized void scheduleSoftwareFilterFallback(String nextAttemptId, long timeoutMs) {
        cancelScanFilterFallback();
        long fallbackDelayMs = Math.min(
            FILTERED_SCAN_FALLBACK_MS,
            Math.max(500L, timeoutMs / 2L)
        );
        scanFilterFallback = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (
                    role != Role.LEADER
                    || !attemptId.equals(nextAttemptId)
                    || scanner == null
                    || !attemptedAddresses.isEmpty()
                ) return;
                try {
                    scanner.stopScan(scanCallback);
                    softwareFilteredScan = true;
                    scanner.startScan(Collections.emptyList(), leaderScanSettings(), scanCallback);
                } catch (RuntimeException error) {
                    softwareFilteredScan = false;
                    emitError("discovery_failed");
                }
            }
        };
        handler.postDelayed(scanFilterFallback, fallbackDelayMs);
    }

    private synchronized void scheduleLeaderScanTimeout(String nextAttemptId, long timeoutMs) {
        if (role != Role.LEADER || !attemptId.equals(nextAttemptId)) return;
        if (scanTimeout != null) handler.removeCallbacks(scanTimeout);
        scanTimeout = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER || !attemptId.equals(nextAttemptId)) return;
                cancelScanFilterFallback();
                stopLeaderScanner();
                if (leaderPeers.isEmpty()) {
                    completeLeaderScan(nextAttemptId);
                    return;
                }
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
        }
        return result;
    }

    synchronized void shutdown() {
        stopAllInternal(false);
    }

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.READY) {
                    stopReadyAdvertising();
                    return;
                }
                emit("ready", event -> event.put("serviceRequestId", readyServiceRequestId));
            }
        }

        @Override
        public void onStartFailure(int errorCode) {
            synchronized (NearbyPresenceManager.this) {
                if (role == Role.READY) failReady("advertising_failed");
            }
        }
    };

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            if (!isLorrenAdvertisement(result)) return;
            BluetoothDevice device = result.getDevice();
            if (device == null) return;
            connectDiscoveredDevice(device);
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            if (results == null) return;
            for (ScanResult result : results) onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, result);
        }

        @Override
        public void onScanFailed(int errorCode) {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER) return;
                cancelLeaderTimers();
                closeAllLeaderPeers();
                role = Role.IDLE;
                emitError("discovery_failed");
            }
        }
    };

    private static boolean isLorrenAdvertisement(ScanResult result) {
        if (result == null) return false;
        ScanRecord record = result.getScanRecord();
        List<ParcelUuid> serviceUuids = record == null ? null : record.getServiceUuids();
        return serviceUuids != null && serviceUuids.contains(SERVICE_PARCEL_UUID);
    }

    private synchronized void connectDiscoveredDevice(BluetoothDevice device) {
        if (role != Role.LEADER) return;
        String address = safeAddress(device);
        if (address.isEmpty() || !attemptedAddresses.add(address)) return;
        cancelScanFilterFallback();
        LeaderPeer peer = new LeaderPeer(device, address);
        leaderPeers.put(address, peer);
        emit("endpoint_found", event -> event.put("pendingCount", leaderPeers.size()));
        try {
            BluetoothGatt gatt = device.connectGatt(
                appContext,
                false,
                gattClientCallback,
                BluetoothDevice.TRANSPORT_LE
            );
            if (gatt == null) {
                failLeaderPeer(peer, "connection_request_failed");
                return;
            }
            peer.gatt = gatt;
        } catch (RuntimeException error) {
            failLeaderPeer(peer, "connection_request_failed");
        }
    }

    private final BluetoothGattCallback gattClientCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            synchronized (NearbyPresenceManager.this) {
                LeaderPeer peer = leaderPeer(gatt);
                if (peer == null || role != Role.LEADER) {
                    closeGatt(gatt);
                    return;
                }
                if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
                    failLeaderPeer(peer, "connection_failed");
                    return;
                }
                if (newState != BluetoothProfile.STATE_CONNECTED) return;
                try {
                    gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                    boolean mtuRequested = gatt.requestMtu(REQUESTED_MTU);
                    peer.serviceFallback = () -> {
                        synchronized (NearbyPresenceManager.this) {
                            requestServices(peer);
                        }
                    };
                    handler.postDelayed(peer.serviceFallback, SERVICE_DISCOVERY_FALLBACK_MS);
                    if (!mtuRequested) requestServices(peer);
                } catch (RuntimeException error) {
                    failLeaderPeer(peer, "connection_failed");
                }
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            synchronized (NearbyPresenceManager.this) {
                LeaderPeer peer = leaderPeer(gatt);
                if (peer == null || role != Role.LEADER) return;
                if (status == BluetoothGatt.GATT_SUCCESS && mtu >= DEFAULT_MTU) peer.mtu = mtu;
                requestServices(peer);
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            synchronized (NearbyPresenceManager.this) {
                LeaderPeer peer = leaderPeer(gatt);
                if (peer == null || role != Role.LEADER) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    failLeaderPeer(peer, "connection_failed");
                    return;
                }
                BluetoothGattService service = gatt.getService(SERVICE_UUID);
                if (service == null) {
                    failLeaderPeer(peer, "connection_failed");
                    return;
                }
                peer.challengeCharacteristic = service.getCharacteristic(CHALLENGE_UUID);
                peer.proofCharacteristic = service.getCharacteristic(PROOF_UUID);
                if (peer.challengeCharacteristic == null || peer.proofCharacteristic == null) {
                    failLeaderPeer(peer, "connection_failed");
                    return;
                }
                BluetoothGattDescriptor cccd = peer.proofCharacteristic.getDescriptor(CCCD_UUID);
                if (cccd == null || !gatt.setCharacteristicNotification(peer.proofCharacteristic, true)) {
                    failLeaderPeer(peer, "connection_failed");
                    return;
                }
                cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                try {
                    if (!gatt.writeDescriptor(cccd)) failLeaderPeer(peer, "connection_failed");
                } catch (RuntimeException error) {
                    failLeaderPeer(peer, "connection_failed");
                }
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            synchronized (NearbyPresenceManager.this) {
                LeaderPeer peer = leaderPeer(gatt);
                if (peer == null || role != Role.LEADER || !CCCD_UUID.equals(descriptor.getUuid())) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    failLeaderPeer(peer, "connection_failed");
                    return;
                }
                try {
                    JSONObject payload = new JSONObject();
                    payload.put("type", "challenge");
                    payload.put("version", 1);
                    payload.put("attemptId", attemptId);
                    payload.put("serviceRequestId", scanServiceRequestId);
                    payload.put("challenge", challenge);
                    payload.put("sentAt", challengeSentAt);
                    peer.challengeFrames = buildFrames(
                        payload.toString().getBytes(StandardCharsets.UTF_8),
                        FRAME_TYPE_CHALLENGE,
                        peer.mtu
                    );
                    peer.challengeIndex = 0;
                    sendNextChallengeFrame(peer);
                } catch (Exception error) {
                    failLeaderPeer(peer, "payload_send_failed");
                }
            }
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            synchronized (NearbyPresenceManager.this) {
                LeaderPeer peer = leaderPeer(gatt);
                if (peer == null || role != Role.LEADER || !CHALLENGE_UUID.equals(characteristic.getUuid())) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    failLeaderPeer(peer, "payload_send_failed");
                    return;
                }
                peer.challengeIndex += 1;
                sendNextChallengeFrame(peer);
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            handleProofNotification(gatt, characteristic, characteristic.getValue());
        }

        @Override
        public void onCharacteristicChanged(
            BluetoothGatt gatt,
            BluetoothGattCharacteristic characteristic,
            byte[] value
        ) {
            handleProofNotification(gatt, characteristic, value);
        }
    };

    private synchronized void requestServices(LeaderPeer peer) {
        if (peer == null || role != Role.LEADER || peer.servicesRequested || peer.gatt == null) return;
        peer.servicesRequested = true;
        if (peer.serviceFallback != null) handler.removeCallbacks(peer.serviceFallback);
        peer.serviceFallback = null;
        try {
            if (!peer.gatt.discoverServices()) failLeaderPeer(peer, "connection_failed");
        } catch (RuntimeException error) {
            failLeaderPeer(peer, "connection_failed");
        }
    }

    private synchronized void sendNextChallengeFrame(LeaderPeer peer) {
        if (peer == null || role != Role.LEADER || peer.gatt == null || peer.challengeCharacteristic == null) return;
        if (peer.challengeIndex >= peer.challengeFrames.size()) return;
        byte[] frame = peer.challengeFrames.get(peer.challengeIndex);
        peer.challengeCharacteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        peer.challengeCharacteristic.setValue(frame);
        try {
            if (!peer.gatt.writeCharacteristic(peer.challengeCharacteristic)) {
                failLeaderPeer(peer, "payload_send_failed");
            }
        } catch (RuntimeException error) {
            failLeaderPeer(peer, "payload_send_failed");
        }
    }

    private void handleProofNotification(
        BluetoothGatt gatt,
        BluetoothGattCharacteristic characteristic,
        byte[] value
    ) {
        synchronized (this) {
            LeaderPeer peer = leaderPeer(gatt);
            if (
                peer == null
                || role != Role.LEADER
                || characteristic == null
                || !PROOF_UUID.equals(characteristic.getUuid())
                || value == null
            ) return;
            try {
                byte[] complete = peer.proofFrames.accept(value, FRAME_TYPE_PROOF);
                if (complete == null) return;
                acceptProof(peer, new JSONObject(new String(complete, StandardCharsets.UTF_8)));
            } catch (Exception error) {
                failLeaderPeer(peer, "proof_invalid");
            }
        }
    }

    private final BluetoothGattServerCallback gattServerCallback = new BluetoothGattServerCallback() {
        @Override
        public void onServiceAdded(int status, BluetoothGattService service) {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.READY || service == null || !SERVICE_UUID.equals(service.getUuid())) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    failReady("advertising_failed");
                    return;
                }
                startReadyAdvertising();
            }
        }

        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            synchronized (NearbyPresenceManager.this) {
                String address = safeAddress(device);
                if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    cleanupServerPeer(address);
                    return;
                }
                if (role != Role.READY && gattServer != null) {
                    try {
                        gattServer.cancelConnection(device);
                    } catch (SecurityException ignored) {
                    }
                }
            }
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int mtu) {
            synchronized (NearbyPresenceManager.this) {
                String address = safeAddress(device);
                if (!address.isEmpty() && mtu >= DEFAULT_MTU) serverMtuByAddress.put(address, mtu);
            }
        }

        @Override
        public void onDescriptorWriteRequest(
            BluetoothDevice device,
            int requestId,
            BluetoothGattDescriptor descriptor,
            boolean preparedWrite,
            boolean responseNeeded,
            int offset,
            byte[] value
        ) {
            synchronized (NearbyPresenceManager.this) {
                int status = BluetoothGatt.GATT_FAILURE;
                String address = safeAddress(device);
                if (
                    role == Role.READY
                    && descriptor != null
                    && CCCD_UUID.equals(descriptor.getUuid())
                    && !preparedWrite
                    && offset == 0
                    && Arrays.equals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE, value)
                    && !address.isEmpty()
                ) {
                    notificationSubscribers.add(address);
                    status = BluetoothGatt.GATT_SUCCESS;
                }
                sendServerResponse(device, requestId, responseNeeded, status);
            }
        }

        @Override
        public void onCharacteristicWriteRequest(
            BluetoothDevice device,
            int requestId,
            BluetoothGattCharacteristic characteristic,
            boolean preparedWrite,
            boolean responseNeeded,
            int offset,
            byte[] value
        ) {
            synchronized (NearbyPresenceManager.this) {
                String address = safeAddress(device);
                if (
                    role != Role.READY
                    || characteristic == null
                    || !CHALLENGE_UUID.equals(characteristic.getUuid())
                    || preparedWrite
                    || offset != 0
                    || value == null
                    || address.isEmpty()
                ) {
                    sendServerResponse(device, requestId, responseNeeded, BluetoothGatt.GATT_FAILURE);
                    return;
                }
                try {
                    FrameAccumulator accumulator = incomingChallenges.computeIfAbsent(
                        address,
                        ignored -> new FrameAccumulator()
                    );
                    byte[] complete = accumulator.accept(value, FRAME_TYPE_CHALLENGE);
                    sendServerResponse(device, requestId, responseNeeded, BluetoothGatt.GATT_SUCCESS);
                    if (complete != null) {
                        incomingChallenges.remove(address);
                        respondToChallenge(device, complete);
                    }
                } catch (Exception error) {
                    incomingChallenges.remove(address);
                    sendServerResponse(device, requestId, responseNeeded, BluetoothGatt.GATT_FAILURE);
                    emitError("payload_invalid");
                }
            }
        }

        @Override
        public void onNotificationSent(BluetoothDevice device, int status) {
            synchronized (NearbyPresenceManager.this) {
                String address = safeAddress(device);
                OutgoingProof outgoing = outgoingProofs.get(address);
                if (outgoing == null) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    outgoingProofs.remove(address);
                    emitError("payload_transfer_failed");
                    return;
                }
                outgoing.index += 1;
                if (outgoing.index >= outgoing.frames.size()) {
                    outgoingProofs.remove(address);
                    emit("proof_sent", event -> event.put("serviceRequestId", outgoing.serviceRequestId));
                    if (gattServer != null) {
                        try {
                            gattServer.cancelConnection(device);
                        } catch (SecurityException ignored) {
                        }
                    }
                    return;
                }
                sendNextProofFrame(device, outgoing);
            }
        }
    };

    private synchronized void respondToChallenge(BluetoothDevice device, byte[] payloadBytes) {
        try {
            JSONObject message = new JSONObject(new String(payloadBytes, StandardCharsets.UTF_8));
            String incomingAttemptId = requiredToken(message.optString("attemptId"), "attemptId");
            String incomingServiceRequestId = requiredToken(message.optString("serviceRequestId"), "serviceRequestId");
            String incomingChallenge = requiredToken(message.optString("challenge"), "challenge");
            if (!readyServiceRequestId.equals(incomingServiceRequestId)) {
                cancelServerConnection(device);
                return;
            }
            long sentAt = message.optLong("sentAt", 0L);
            if (sentAt <= 0L || Math.abs(sentAt - System.currentTimeMillis()) > 2 * 60 * 1000L) {
                cancelServerConnection(device);
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

            String address = safeAddress(device);
            if (address.isEmpty() || !notificationSubscribers.contains(address)) {
                emitError("payload_send_failed");
                return;
            }
            int mtu = serverMtuByAddress.getOrDefault(address, DEFAULT_MTU);
            OutgoingProof outgoing = new OutgoingProof(
                incomingServiceRequestId,
                buildFrames(response.toString().getBytes(StandardCharsets.UTF_8), FRAME_TYPE_PROOF, mtu)
            );
            outgoingProofs.put(address, outgoing);
            sendNextProofFrame(device, outgoing);
        } catch (Exception error) {
            emitError("proof_sign_failed");
        }
    }

    private synchronized void sendNextProofFrame(BluetoothDevice device, OutgoingProof outgoing) {
        if (
            role != Role.READY
            || gattServer == null
            || proofCharacteristic == null
            || outgoing == null
            || outgoing.index >= outgoing.frames.size()
        ) return;
        byte[] frame = outgoing.frames.get(outgoing.index);
        proofCharacteristic.setValue(frame);
        try {
            if (!gattServer.notifyCharacteristicChanged(device, proofCharacteristic, false)) {
                outgoingProofs.remove(safeAddress(device));
                emitError("payload_send_failed");
            }
        } catch (RuntimeException error) {
            outgoingProofs.remove(safeAddress(device));
            emitError("payload_send_failed");
        }
    }

    private synchronized void acceptProof(LeaderPeer peer, JSONObject proof) {
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
                failLeaderPeer(peer, null);
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
            removeLeaderPeer(peer);
            emit("proof_received", event -> {
                event.put("deviceKeyId", keyId);
                event.put("verifiedCount", proofsByKey.size());
                event.put("pendingCount", leaderPeers.size());
                event.put("credentialProvisioned", !stored.optString("credential").isEmpty());
            });
            if (expectedProofCount > 0 && proofsByKey.size() >= expectedProofCount) {
                completeLeaderScan(attemptId);
            }
        } catch (Exception ignored) {
            failLeaderPeer(peer, "proof_invalid");
        }
    }

    private synchronized void completeLeaderScan(String completedAttemptId) {
        if (role != Role.LEADER || !attemptId.equals(completedAttemptId)) return;
        cancelLeaderTimers();
        stopLeaderScanner();
        emit("scan_complete", event -> {
            event.put("attemptId", completedAttemptId);
            event.put("verifiedCount", proofsByKey.size());
            event.put("pendingCount", leaderPeers.size());
            event.put("expectedProofCount", expectedProofCount);
        });
        closeAllLeaderPeers();
        role = Role.IDLE;
    }

    private synchronized void cancelScanFilterFallback() {
        if (scanFilterFallback != null) handler.removeCallbacks(scanFilterFallback);
        scanFilterFallback = null;
    }

    private synchronized void cancelLeaderTimers() {
        cancelScanFilterFallback();
        if (scanTimeout != null) handler.removeCallbacks(scanTimeout);
        if (scanCompleteTimeout != null) handler.removeCallbacks(scanCompleteTimeout);
        scanTimeout = null;
        scanCompleteTimeout = null;
    }

    private synchronized void stopAllInternal(boolean notify) {
        cancelLeaderTimers();
        stopReadyResources();
        stopLeaderScanner();
        closeAllLeaderPeers();
        attemptedAddresses.clear();
        incomingChallenges.clear();
        serverMtuByAddress.clear();
        notificationSubscribers.clear();
        outgoingProofs.clear();
        readyServiceRequestId = "";
        expectedProofCount = 0;
        softwareFilteredScan = false;
        role = Role.IDLE;
        if (notify) emit("stopped", event -> {});
    }

    private synchronized void stopReadyResources() {
        stopReadyAdvertising();
        if (gattServer != null) {
            try {
                gattServer.clearServices();
                gattServer.close();
            } catch (RuntimeException ignored) {
            }
        }
        gattServer = null;
        challengeCharacteristic = null;
        proofCharacteristic = null;
        incomingChallenges.clear();
        serverMtuByAddress.clear();
        notificationSubscribers.clear();
        outgoingProofs.clear();
    }

    private synchronized void stopReadyAdvertising() {
        if (advertiser != null) {
            try {
                advertiser.stopAdvertising(advertiseCallback);
            } catch (RuntimeException ignored) {
            }
        }
        advertiser = null;
    }

    private synchronized void stopLeaderScanner() {
        if (scanner != null) {
            try {
                scanner.stopScan(scanCallback);
            } catch (RuntimeException ignored) {
            }
        }
        scanner = null;
        softwareFilteredScan = false;
    }

    private synchronized void closeAllLeaderPeers() {
        List<LeaderPeer> peers = new ArrayList<>(leaderPeers.values());
        leaderPeers.clear();
        for (LeaderPeer peer : peers) closeLeaderPeer(peer);
    }

    private synchronized void failLeaderPeer(LeaderPeer peer, String code) {
        if (peer == null) return;
        removeLeaderPeer(peer);
        if (code != null && !code.isEmpty()) emitError(code);
    }

    private synchronized void removeLeaderPeer(LeaderPeer peer) {
        if (peer == null) return;
        leaderPeers.remove(peer.address);
        closeLeaderPeer(peer);
    }

    private void closeLeaderPeer(LeaderPeer peer) {
        if (peer == null) return;
        if (peer.serviceFallback != null) handler.removeCallbacks(peer.serviceFallback);
        peer.serviceFallback = null;
        if (peer.gatt != null) {
            try {
                peer.gatt.disconnect();
            } catch (RuntimeException ignored) {
            }
            closeGatt(peer.gatt);
            peer.gatt = null;
        }
    }

    private static void closeGatt(BluetoothGatt gatt) {
        if (gatt == null) return;
        try {
            gatt.close();
        } catch (RuntimeException ignored) {
        }
    }

    private synchronized LeaderPeer leaderPeer(BluetoothGatt gatt) {
        if (gatt == null || gatt.getDevice() == null) return null;
        return leaderPeers.get(safeAddress(gatt.getDevice()));
    }

    private synchronized void cleanupServerPeer(String address) {
        if (address == null || address.isEmpty()) return;
        incomingChallenges.remove(address);
        serverMtuByAddress.remove(address);
        notificationSubscribers.remove(address);
        outgoingProofs.remove(address);
    }

    private synchronized void cancelServerConnection(BluetoothDevice device) {
        if (gattServer == null || device == null) return;
        try {
            gattServer.cancelConnection(device);
        } catch (SecurityException ignored) {
        }
    }

    private synchronized void sendServerResponse(
        BluetoothDevice device,
        int requestId,
        boolean responseNeeded,
        int status
    ) {
        if (!responseNeeded || gattServer == null || device == null) return;
        try {
            gattServer.sendResponse(device, requestId, status, 0, null);
        } catch (RuntimeException ignored) {
        }
    }

    private String safeCredential() {
        String credential = credentialProvider.credential();
        if (credential == null) return "";
        String normalized = credential.trim();
        return normalized.length() > 16_384 ? "" : normalized;
    }

    private static List<byte[]> buildFrames(byte[] payload, int type, int mtu) {
        if (payload == null || payload.length > MAX_FRAME_BYTES) {
            throw new IllegalArgumentException("ble_frame_payload_invalid");
        }
        int attPayload = Math.max(20, Math.max(DEFAULT_MTU, mtu) - 3);
        int chunkSize = Math.max(1, attPayload - FRAME_HEADER_BYTES);
        List<byte[]> frames = new ArrayList<>();
        int sequence = 0;
        for (int offset = 0; offset < Math.max(1, payload.length); offset += chunkSize) {
            int remaining = payload.length - offset;
            int length = Math.min(chunkSize, Math.max(0, remaining));
            boolean last = offset + length >= payload.length;
            byte[] frame = new byte[FRAME_HEADER_BYTES + length];
            frame[0] = (byte) FRAME_MAGIC;
            frame[1] = (byte) FRAME_VERSION;
            frame[2] = (byte) type;
            frame[3] = (byte) (last ? FRAME_FLAG_FINAL : 0);
            frame[4] = (byte) ((sequence >>> 8) & 0xff);
            frame[5] = (byte) (sequence & 0xff);
            if (length > 0) System.arraycopy(payload, offset, frame, FRAME_HEADER_BYTES, length);
            frames.add(frame);
            sequence += 1;
            if (payload.length == 0) break;
        }
        return frames;
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

    private static String safeAddress(BluetoothDevice device) {
        if (device == null) return "";
        try {
            String address = device.getAddress();
            return address == null ? "" : address;
        } catch (SecurityException error) {
            return "";
        }
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
        }
    }

    private void emitError(String code) {
        emit("error", event -> event.put("code", code));
    }

    private static final class FrameAccumulator {
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private int nextSequence = 0;

        byte[] accept(byte[] frame, int expectedType) {
            if (frame == null || frame.length < FRAME_HEADER_BYTES) {
                throw new IllegalArgumentException("ble_frame_invalid");
            }
            int magic = frame[0] & 0xff;
            int version = frame[1] & 0xff;
            int type = frame[2] & 0xff;
            int flags = frame[3] & 0xff;
            int sequence = ((frame[4] & 0xff) << 8) | (frame[5] & 0xff);
            if (
                magic != FRAME_MAGIC
                || version != FRAME_VERSION
                || type != expectedType
                || sequence != nextSequence
            ) {
                reset();
                throw new IllegalArgumentException("ble_frame_sequence_invalid");
            }
            int bodyLength = frame.length - FRAME_HEADER_BYTES;
            if (bytes.size() + bodyLength > MAX_FRAME_BYTES) {
                reset();
                throw new IllegalArgumentException("ble_frame_too_large");
            }
            if (bodyLength > 0) bytes.write(frame, FRAME_HEADER_BYTES, bodyLength);
            nextSequence += 1;
            if ((flags & FRAME_FLAG_FINAL) == 0) return null;
            byte[] completed = bytes.toByteArray();
            reset();
            return completed;
        }

        private void reset() {
            bytes.reset();
            nextSequence = 0;
        }
    }

    private static final class LeaderPeer {
        final BluetoothDevice device;
        final String address;
        final FrameAccumulator proofFrames = new FrameAccumulator();
        BluetoothGatt gatt;
        BluetoothGattCharacteristic challengeCharacteristic;
        BluetoothGattCharacteristic proofCharacteristic;
        List<byte[]> challengeFrames = Collections.emptyList();
        int challengeIndex = 0;
        int mtu = DEFAULT_MTU;
        boolean servicesRequested = false;
        Runnable serviceFallback;

        LeaderPeer(BluetoothDevice device, String address) {
            this.device = device;
            this.address = address;
        }
    }

    private static final class OutgoingProof {
        final String serviceRequestId;
        final List<byte[]> frames;
        int index = 0;

        OutgoingProof(String serviceRequestId, List<byte[]> frames) {
            this.serviceRequestId = serviceRequestId;
            this.frames = frames;
        }
    }
}
