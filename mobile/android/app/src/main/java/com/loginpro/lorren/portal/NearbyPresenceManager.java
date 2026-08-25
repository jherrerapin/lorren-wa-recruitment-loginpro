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
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Autoridad nativa única de presencia local de cuadrilla.
 *
 * El transporte de presencia usa BLE Android de extremo a extremo: el auxiliar
 * preparado mantiene un scan foreground y actúa como cliente GATT; el encargado
 * anuncia temporalmente la marcación y actúa como servidor GATT. Internet, Wi-Fi,
 * persistencia, membresía, geocerca e idempotencia no forman parte de esta clase.
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
    private static final long LEADER_START_TIMEOUT_MS = 25_000L;
    private static final long AUXILIARY_EXCHANGE_TIMEOUT_MS = 12_000L;
    private static final long CONNECTION_GRACE_MS = 1_500L;
    private static final long SERVICE_DISCOVERY_FALLBACK_MS = 700L;
    private static final long SUCCESSFUL_PEER_SUPPRESSION_MS = 3_000L;
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

    private Role role = Role.IDLE;

    // AUX: scan BLE persistente y un intercambio GATT transitorio.
    private String readyServiceRequestId = "";
    private BluetoothLeScanner readyScanner;
    private BluetoothGatt auxiliaryGatt;
    private String auxiliaryLeaderAddress = "";
    private String suppressedLeaderAddress = "";
    private long suppressedLeaderUntilMs = 0L;
    private int auxiliaryMtu = DEFAULT_MTU;
    private boolean auxiliaryServicesRequested = false;
    private Runnable auxiliaryServiceFallback;
    private Runnable auxiliaryExchangeTimeout;
    private final FrameAccumulator auxiliaryChallengeFrames = new FrameAccumulator();
    private BluetoothGattCharacteristic auxiliaryChallengeCharacteristic;
    private BluetoothGattCharacteristic auxiliaryProofCharacteristic;
    private List<byte[]> auxiliaryProofFrames = Collections.emptyList();
    private int auxiliaryProofIndex = 0;

    // ENC: advertising efímero + GATT server de una marcación.
    private String attemptId = "";
    private String scanServiceRequestId = "";
    private String challenge = "";
    private long challengeSentAt = 0L;
    private int expectedProofCount = 0;
    private long leaderTimeoutMs = 6_000L;
    private final Map<String, JSONObject> proofsByKey = new LinkedHashMap<>();
    private final Map<String, ServerPeer> leaderPeers = new LinkedHashMap<>();
    private final Deque<PendingNotification> leaderNotificationQueue = new ArrayDeque<>();
    private PendingNotification leaderNotificationInFlight;
    private BluetoothLeAdvertiser leaderAdvertiser;
    private BluetoothGattServer leaderGattServer;
    private BluetoothGattCharacteristic leaderChallengeCharacteristic;
    private BluetoothGattCharacteristic leaderProofCharacteristic;
    private Runnable leaderStartTimeout;
    private Runnable leaderTimeout;
    private Runnable leaderCompleteTimeout;

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
        emitDiagnostic("AUX", "READY_REQUESTED");
        startReadyScanner(true);
    }

    private synchronized void startReadyScanner(boolean emitReadyEvent) {
        if (role != Role.READY || bluetoothAdapter == null) {
            failReady("discovery_failed");
            return;
        }
        if (readyScanner != null) {
            if (emitReadyEvent) emitReady();
            return;
        }
        emitDiagnostic("AUX", "DISCOVERY_START");
        try {
            readyScanner = bluetoothAdapter.getBluetoothLeScanner();
            if (readyScanner == null) {
                failReady("discovery_failed");
                return;
            }
            readyScanner.startScan(
                Collections.emptyList(),
                readyScanSettings(),
                auxiliaryScanCallback
            );
            emitDiagnostic("AUX", "DISCOVERY_READY");
            if (emitReadyEvent) emitReady();
        } catch (RuntimeException error) {
            failReady("discovery_failed");
        }
    }

    private synchronized void emitReady() {
        String serviceRequestId = readyServiceRequestId;
        emit("ready", event -> event.put("serviceRequestId", serviceRequestId));
    }

    private static ScanSettings readyScanSettings() {
        return new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setReportDelay(0L)
            .build();
    }

    private static boolean isLorrenAdvertisement(ScanResult result) {
        if (result == null) return false;
        ScanRecord record = result.getScanRecord();
        List<ParcelUuid> serviceUuids = record == null ? null : record.getServiceUuids();
        return serviceUuids != null && serviceUuids.contains(SERVICE_PARCEL_UUID);
    }

    private synchronized boolean isSuppressedLeader(BluetoothDevice device) {
        String address = safeAddress(device);
        if (address.isEmpty() || !address.equals(suppressedLeaderAddress)) return false;
        if (System.currentTimeMillis() >= suppressedLeaderUntilMs) {
            suppressedLeaderAddress = "";
            suppressedLeaderUntilMs = 0L;
            return false;
        }
        return true;
    }

    private synchronized void suppressCurrentLeader() {
        if (auxiliaryLeaderAddress.isEmpty()) return;
        suppressedLeaderAddress = auxiliaryLeaderAddress;
        suppressedLeaderUntilMs = System.currentTimeMillis() + SUCCESSFUL_PEER_SUPPRESSION_MS;
    }

    private synchronized void failReady(String code) {
        emitDiagnostic("AUX", "DISCOVERY_FAILED");
        stopReadyRuntime();
        role = Role.IDLE;
        readyServiceRequestId = "";
        emitError(code);
    }

    private final ScanCallback auxiliaryScanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            if (!isLorrenAdvertisement(result)) return;
            BluetoothDevice device = result.getDevice();
            if (device == null || isSuppressedLeader(device)) return;
            connectAuxiliaryToLeader(device);
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            if (results == null) return;
            for (ScanResult result : results) {
                onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, result);
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.READY) return;
                emitDiagnostic("AUX", "DISCOVERY_FAILED", errorCode, -1);
                stopReadyRuntime();
                role = Role.IDLE;
                readyServiceRequestId = "";
                emitError("discovery_failed");
            }
        }
    };

    private synchronized void connectAuxiliaryToLeader(BluetoothDevice device) {
        if (role != Role.READY || readyScanner == null || auxiliaryGatt != null) return;
        String address = safeAddress(device);
        if (address.isEmpty()) return;

        auxiliaryLeaderAddress = address;
        auxiliaryMtu = DEFAULT_MTU;
        auxiliaryServicesRequested = false;
        auxiliaryChallengeFrames.reset();
        auxiliaryProofFrames = Collections.emptyList();
        auxiliaryProofIndex = 0;
        auxiliaryChallengeCharacteristic = null;
        auxiliaryProofCharacteristic = null;

        emitDiagnostic("AUX", "ENDPOINT_FOUND");
        emitDiagnostic("AUX", "CONNECTION_REQUEST");
        try {
            BluetoothGatt gatt = device.connectGatt(
                appContext,
                false,
                auxiliaryGattCallback,
                BluetoothDevice.TRANSPORT_LE
            );
            auxiliaryGatt = gatt;
            if (gatt == null) {
                emitDiagnostic("AUX", "CONNECTION_REQUEST_FAILED");
                resumeAuxiliaryAfterFailure("connection_request_failed");
                return;
            }
            scheduleAuxiliaryExchangeTimeout(gatt);
        } catch (RuntimeException error) {
            emitDiagnostic("AUX", "CONNECTION_REQUEST_FAILED");
            resumeAuxiliaryAfterFailure("connection_request_failed");
        }
    }

    private synchronized void scheduleAuxiliaryExchangeTimeout(BluetoothGatt gatt) {
        cancelAuxiliaryExchangeTimeout();
        auxiliaryExchangeTimeout = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.READY || auxiliaryGatt != gatt) return;
                emitDiagnostic("AUX", "CONNECTION_FAILED");
                resumeAuxiliaryAfterFailure("connection_failed");
            }
        };
        handler.postDelayed(auxiliaryExchangeTimeout, AUXILIARY_EXCHANGE_TIMEOUT_MS);
    }

    private final BluetoothGattCallback auxiliaryGattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            synchronized (NearbyPresenceManager.this) {
                if (gatt != auxiliaryGatt || role != Role.READY) {
                    closeGatt(gatt);
                    return;
                }
                if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
                    emitDiagnostic("AUX", "CONNECTION_FAILED", status, -1);
                    resumeAuxiliaryAfterFailure("connection_failed");
                    return;
                }
                if (newState != BluetoothProfile.STATE_CONNECTED) return;

                emitDiagnostic("AUX", "CONNECTION_ESTABLISHED");
                scheduleAuxiliaryExchangeTimeout(gatt);
                try {
                    gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                    boolean mtuRequested = gatt.requestMtu(REQUESTED_MTU);
                    auxiliaryServiceFallback = () -> {
                        synchronized (NearbyPresenceManager.this) {
                            requestAuxiliaryServices(gatt);
                        }
                    };
                    handler.postDelayed(auxiliaryServiceFallback, SERVICE_DISCOVERY_FALLBACK_MS);
                    if (!mtuRequested) requestAuxiliaryServices(gatt);
                } catch (RuntimeException error) {
                    resumeAuxiliaryAfterFailure("connection_failed");
                }
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            synchronized (NearbyPresenceManager.this) {
                if (gatt != auxiliaryGatt || role != Role.READY) return;
                if (status == BluetoothGatt.GATT_SUCCESS && mtu >= DEFAULT_MTU) {
                    auxiliaryMtu = mtu;
                }
                requestAuxiliaryServices(gatt);
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            synchronized (NearbyPresenceManager.this) {
                if (gatt != auxiliaryGatt || role != Role.READY) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    resumeAuxiliaryAfterFailure("connection_failed");
                    return;
                }
                BluetoothGattService service = gatt.getService(SERVICE_UUID);
                if (service == null) {
                    resumeAuxiliaryAfterFailure("connection_failed");
                    return;
                }
                auxiliaryChallengeCharacteristic = service.getCharacteristic(CHALLENGE_UUID);
                auxiliaryProofCharacteristic = service.getCharacteristic(PROOF_UUID);
                if (auxiliaryChallengeCharacteristic == null || auxiliaryProofCharacteristic == null) {
                    resumeAuxiliaryAfterFailure("connection_failed");
                    return;
                }
                BluetoothGattDescriptor cccd = auxiliaryChallengeCharacteristic.getDescriptor(CCCD_UUID);
                if (
                    cccd == null
                    || !gatt.setCharacteristicNotification(auxiliaryChallengeCharacteristic, true)
                ) {
                    resumeAuxiliaryAfterFailure("connection_failed");
                    return;
                }
                cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                try {
                    if (!gatt.writeDescriptor(cccd)) {
                        resumeAuxiliaryAfterFailure("connection_failed");
                    }
                } catch (RuntimeException error) {
                    resumeAuxiliaryAfterFailure("connection_failed");
                }
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            synchronized (NearbyPresenceManager.this) {
                if (
                    gatt != auxiliaryGatt
                    || role != Role.READY
                    || descriptor == null
                    || !CCCD_UUID.equals(descriptor.getUuid())
                ) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    resumeAuxiliaryAfterFailure("connection_failed");
                }
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            handleAuxiliaryChallenge(
                gatt,
                characteristic,
                characteristic == null ? null : characteristic.getValue()
            );
        }

        @Override
        public void onCharacteristicChanged(
            BluetoothGatt gatt,
            BluetoothGattCharacteristic characteristic,
            byte[] value
        ) {
            handleAuxiliaryChallenge(gatt, characteristic, value);
        }

        @Override
        public void onCharacteristicWrite(
            BluetoothGatt gatt,
            BluetoothGattCharacteristic characteristic,
            int status
        ) {
            synchronized (NearbyPresenceManager.this) {
                if (
                    gatt != auxiliaryGatt
                    || role != Role.READY
                    || characteristic == null
                    || !PROOF_UUID.equals(characteristic.getUuid())
                ) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    resumeAuxiliaryAfterFailure("payload_transfer_failed");
                    return;
                }
                auxiliaryProofIndex += 1;
                if (auxiliaryProofIndex >= auxiliaryProofFrames.size()) {
                    String completedService = readyServiceRequestId;
                    emitDiagnostic("AUX", "PROOF_DISPATCHED");
                    emit("proof_sent", event -> event.put("serviceRequestId", completedService));
                    finishAuxiliaryExchange();
                    return;
                }
                sendNextAuxiliaryProofFrame();
            }
        }
    };

    private synchronized void requestAuxiliaryServices(BluetoothGatt gatt) {
        if (
            role != Role.READY
            || gatt == null
            || gatt != auxiliaryGatt
            || auxiliaryServicesRequested
        ) return;
        auxiliaryServicesRequested = true;
        cancelAuxiliaryServiceFallback();
        try {
            if (!gatt.discoverServices()) resumeAuxiliaryAfterFailure("connection_failed");
        } catch (RuntimeException error) {
            resumeAuxiliaryAfterFailure("connection_failed");
        }
    }

    private void handleAuxiliaryChallenge(
        BluetoothGatt gatt,
        BluetoothGattCharacteristic characteristic,
        byte[] value
    ) {
        synchronized (this) {
            if (
                role != Role.READY
                || gatt == null
                || gatt != auxiliaryGatt
                || characteristic == null
                || !CHALLENGE_UUID.equals(characteristic.getUuid())
                || value == null
            ) return;
            try {
                byte[] complete = auxiliaryChallengeFrames.accept(value, FRAME_TYPE_CHALLENGE);
                if (complete == null) return;
                emitDiagnostic("AUX", "CHALLENGE_RECEIVED");
                prepareAuxiliaryProof(new JSONObject(new String(complete, StandardCharsets.UTF_8)));
            } catch (Exception error) {
                resumeAuxiliaryAfterFailure("payload_invalid");
            }
        }
    }

    private synchronized void prepareAuxiliaryProof(JSONObject message) {
        try {
            String incomingAttemptId = requiredToken(message.optString("attemptId"), "attemptId");
            String incomingServiceRequestId = requiredToken(
                message.optString("serviceRequestId"),
                "serviceRequestId"
            );
            String incomingChallenge = requiredToken(message.optString("challenge"), "challenge");
            long sentAt = message.optLong("sentAt", 0L);

            if (!readyServiceRequestId.equals(incomingServiceRequestId)) {
                finishAuxiliaryExchange();
                return;
            }
            if (sentAt <= 0L || Math.abs(sentAt - System.currentTimeMillis()) > 2 * 60 * 1000L) {
                finishAuxiliaryExchange();
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

            auxiliaryProofFrames = buildFrames(
                response.toString().getBytes(StandardCharsets.UTF_8),
                FRAME_TYPE_PROOF,
                auxiliaryMtu
            );
            auxiliaryProofIndex = 0;
            sendNextAuxiliaryProofFrame();
        } catch (Exception error) {
            resumeAuxiliaryAfterFailure("proof_sign_failed");
        }
    }

    private synchronized void sendNextAuxiliaryProofFrame() {
        if (
            role != Role.READY
            || auxiliaryGatt == null
            || auxiliaryProofCharacteristic == null
            || auxiliaryProofIndex >= auxiliaryProofFrames.size()
        ) return;

        byte[] frame = auxiliaryProofFrames.get(auxiliaryProofIndex);
        try {
            boolean accepted;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                accepted = auxiliaryGatt.writeCharacteristic(
                    auxiliaryProofCharacteristic,
                    frame,
                    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                ) == BluetoothStatusCodes.SUCCESS;
            } else {
                auxiliaryProofCharacteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                auxiliaryProofCharacteristic.setValue(frame);
                accepted = auxiliaryGatt.writeCharacteristic(auxiliaryProofCharacteristic);
            }
            if (!accepted) resumeAuxiliaryAfterFailure("payload_send_failed");
        } catch (RuntimeException error) {
            resumeAuxiliaryAfterFailure("payload_send_failed");
        }
    }

    private synchronized void resumeAuxiliaryAfterFailure(String code) {
        if (role != Role.READY) return;
        closeAuxiliaryGatt();
        if (code != null && !code.isEmpty()) emitError(code);
    }

    private synchronized void finishAuxiliaryExchange() {
        if (role != Role.READY) return;
        suppressCurrentLeader();
        closeAuxiliaryGatt();
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
        challengeSentAt = 0L;
        expectedProofCount = nextExpectedProofCount;
        leaderTimeoutMs = timeoutMs;
        proofsByKey.clear();
        leaderPeers.clear();
        clearLeaderNotificationQueue();
        emitDiagnostic("ENC", "SCAN_REQUESTED");

        if (expectedProofCount == 0) {
            challengeSentAt = System.currentTimeMillis();
            emitLeaderScanStarted();
            completeLeaderScan(nextAttemptId);
            return;
        }

        if (bluetoothAdapter == null || bluetoothManager == null) {
            failLeaderStart("advertising_failed");
            return;
        }

        try {
            leaderAdvertiser = bluetoothAdapter.getBluetoothLeAdvertiser();
            if (leaderAdvertiser == null) {
                failLeaderStart("advertising_unsupported");
                return;
            }

            leaderGattServer = bluetoothManager.openGattServer(appContext, gattServerCallback);
            if (leaderGattServer == null) {
                failLeaderStart("advertising_failed");
                return;
            }

            BluetoothGattService service = new BluetoothGattService(
                SERVICE_UUID,
                BluetoothGattService.SERVICE_TYPE_PRIMARY
            );
            leaderChallengeCharacteristic = new BluetoothGattCharacteristic(
                CHALLENGE_UUID,
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ
            );
            BluetoothGattDescriptor cccd = new BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE
            );
            leaderChallengeCharacteristic.addDescriptor(cccd);
            leaderProofCharacteristic = new BluetoothGattCharacteristic(
                PROOF_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_WRITE
            );
            service.addCharacteristic(leaderChallengeCharacteristic);
            service.addCharacteristic(leaderProofCharacteristic);

            emitDiagnostic("ENC", "ADVERTISING_START");
            scheduleLeaderStartTimeout(nextAttemptId);
            if (!leaderGattServer.addService(service)) {
                failLeaderStart("advertising_failed");
            }
        } catch (RuntimeException error) {
            failLeaderStart("advertising_failed");
        }
    }

    private synchronized void scheduleLeaderStartTimeout(String nextAttemptId) {
        cancelLeaderStartTimeout();
        leaderStartTimeout = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER || !attemptId.equals(nextAttemptId)) return;
                emitDiagnostic("ENC", "ADVERTISING_FAILED");
                failLeaderStart("advertising_failed");
            }
        };
        handler.postDelayed(leaderStartTimeout, LEADER_START_TIMEOUT_MS);
    }

    private synchronized void startLeaderAdvertising() {
        if (
            role != Role.LEADER
            || leaderAdvertiser == null
            || leaderGattServer == null
            || leaderChallengeCharacteristic == null
            || leaderProofCharacteristic == null
        ) {
            failLeaderStart("advertising_failed");
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
            .setIncludeTxPowerLevel(false)
            .build();

        try {
            leaderAdvertiser.startAdvertising(settings, data, leaderAdvertiseCallback);
        } catch (RuntimeException error) {
            failLeaderStart("advertising_failed");
        }
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

    private final AdvertiseCallback leaderAdvertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER) {
                    stopLeaderAdvertising();
                    return;
                }
                cancelLeaderStartTimeout();
                challengeSentAt = System.currentTimeMillis();
                emitDiagnostic("ENC", "ADVERTISING_READY");
                emitLeaderScanStarted();
                scheduleLeaderTimeout(attemptId, leaderTimeoutMs);
            }
        }

        @Override
        public void onStartFailure(int errorCode) {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER) return;
                emitDiagnostic("ENC", "ADVERTISING_FAILED", errorCode, -1);
                failLeaderStart(
                    errorCode == AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED
                        ? "advertising_unsupported"
                        : "advertising_failed"
                );
            }
        }
    };

    private final BluetoothGattServerCallback gattServerCallback = new BluetoothGattServerCallback() {
        @Override
        public void onServiceAdded(int status, BluetoothGattService service) {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER || service == null || !SERVICE_UUID.equals(service.getUuid())) {
                    return;
                }
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    emitDiagnostic("ENC", "ADVERTISING_FAILED", status, -1);
                    failLeaderStart("advertising_failed");
                    return;
                }
                startLeaderAdvertising();
            }
        }

        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER) {
                    cancelLeaderConnection(device);
                    return;
                }
                String address = safeAddress(device);
                if (address.isEmpty()) return;

                if (
                    status != BluetoothGatt.GATT_SUCCESS
                    || newState == BluetoothProfile.STATE_DISCONNECTED
                ) {
                    removeServerPeer(address, false);
                    return;
                }
                if (newState != BluetoothProfile.STATE_CONNECTED) return;

                ServerPeer peer = leaderPeers.get(address);
                if (peer == null) {
                    peer = new ServerPeer(device, address);
                    leaderPeers.put(address, peer);
                    int pendingCount = leaderPeers.size();
                    emitDiagnostic("ENC", "CONNECTION_INITIATED");
                    emitDiagnostic("ENC", "CONNECTION_ESTABLISHED");
                    emit("endpoint_found", event -> event.put("pendingCount", pendingCount));
                }
            }
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int mtu) {
            synchronized (NearbyPresenceManager.this) {
                ServerPeer peer = leaderPeers.get(safeAddress(device));
                if (peer != null && mtu >= DEFAULT_MTU) peer.mtu = mtu;
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
                String address = safeAddress(device);
                ServerPeer peer = leaderPeers.get(address);
                int responseStatus = BluetoothGatt.GATT_FAILURE;
                if (
                    role == Role.LEADER
                    && peer != null
                    && descriptor != null
                    && CCCD_UUID.equals(descriptor.getUuid())
                    && !preparedWrite
                    && offset == 0
                    && Arrays.equals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE, value)
                ) {
                    responseStatus = BluetoothGatt.GATT_SUCCESS;
                }
                sendLeaderServerResponse(device, requestId, responseNeeded, responseStatus);
                if (responseStatus != BluetoothGatt.GATT_SUCCESS || peer == null || peer.challengeQueued) {
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
                    peer.challengeQueued = true;
                    enqueueLeaderChallengeFrames(
                        peer,
                        buildFrames(
                            payload.toString().getBytes(StandardCharsets.UTF_8),
                            FRAME_TYPE_CHALLENGE,
                            peer.mtu
                        )
                    );
                } catch (Exception error) {
                    failServerPeer(peer, "payload_send_failed");
                }
            }
        }

        @Override
        public void onNotificationSent(BluetoothDevice device, int status) {
            synchronized (NearbyPresenceManager.this) {
                PendingNotification inFlight = leaderNotificationInFlight;
                leaderNotificationInFlight = null;
                if (inFlight == null) {
                    drainLeaderNotificationQueue();
                    return;
                }
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    ServerPeer peer = leaderPeers.get(inFlight.address);
                    if (peer != null) failServerPeer(peer, "payload_transfer_failed");
                }
                drainLeaderNotificationQueue();
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
                ServerPeer peer = leaderPeers.get(address);
                if (
                    role != Role.LEADER
                    || peer == null
                    || characteristic == null
                    || !PROOF_UUID.equals(characteristic.getUuid())
                    || preparedWrite
                    || offset != 0
                    || value == null
                ) {
                    sendLeaderServerResponse(
                        device,
                        requestId,
                        responseNeeded,
                        BluetoothGatt.GATT_FAILURE
                    );
                    return;
                }

                try {
                    byte[] complete = peer.proofFrames.accept(value, FRAME_TYPE_PROOF);
                    sendLeaderServerResponse(
                        device,
                        requestId,
                        responseNeeded,
                        BluetoothGatt.GATT_SUCCESS
                    );
                    if (complete != null) {
                        emitDiagnostic("ENC", "PROOF_RECEIVED_RAW");
                        acceptLeaderProof(
                            peer,
                            new JSONObject(new String(complete, StandardCharsets.UTF_8))
                        );
                    }
                } catch (Exception error) {
                    sendLeaderServerResponse(
                        device,
                        requestId,
                        responseNeeded,
                        BluetoothGatt.GATT_FAILURE
                    );
                    failServerPeer(peer, "proof_invalid");
                }
            }
        }
    };

    private synchronized void enqueueLeaderChallengeFrames(ServerPeer peer, List<byte[]> frames) {
        if (peer == null || frames == null || frames.isEmpty()) {
            failServerPeer(peer, "payload_send_failed");
            return;
        }
        for (byte[] frame : frames) {
            leaderNotificationQueue.addLast(new PendingNotification(peer.address, frame));
        }
        emitDiagnostic("ENC", "CHALLENGE_DISPATCHED");
        drainLeaderNotificationQueue();
    }

    private synchronized void drainLeaderNotificationQueue() {
        if (role != Role.LEADER || leaderGattServer == null || leaderChallengeCharacteristic == null) {
            return;
        }
        if (leaderNotificationInFlight != null) return;

        while (!leaderNotificationQueue.isEmpty()) {
            PendingNotification pending = leaderNotificationQueue.removeFirst();
            ServerPeer peer = leaderPeers.get(pending.address);
            if (peer == null) continue;

            leaderNotificationInFlight = pending;
            try {
                boolean accepted;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    accepted = leaderGattServer.notifyCharacteristicChanged(
                        peer.device,
                        leaderChallengeCharacteristic,
                        false,
                        pending.frame
                    ) == BluetoothStatusCodes.SUCCESS;
                } else {
                    leaderChallengeCharacteristic.setValue(pending.frame);
                    accepted = leaderGattServer.notifyCharacteristicChanged(
                        peer.device,
                        leaderChallengeCharacteristic,
                        false
                    );
                }
                if (accepted) return;
            } catch (RuntimeException error) {
                // Se maneja igual que un rechazo inmediato del stack.
            }

            leaderNotificationInFlight = null;
            failServerPeer(peer, "payload_send_failed");
        }
    }

    private synchronized void acceptLeaderProof(ServerPeer peer, JSONObject proof) {
        try {
            if (!attemptId.equals(proof.optString("attemptId"))) {
                failServerPeer(peer, "proof_invalid");
                return;
            }
            if (!scanServiceRequestId.equals(proof.optString("serviceRequestId"))) {
                failServerPeer(peer, "proof_invalid");
                return;
            }
            if (!challenge.equals(proof.optString("challenge"))) {
                failServerPeer(peer, "proof_invalid");
                return;
            }
            long respondedAt = proof.optLong("respondedAt", 0L);
            if (
                respondedAt <= 0L
                || Math.abs(respondedAt - System.currentTimeMillis()) > 2 * 60 * 1000L
            ) {
                failServerPeer(peer, "proof_invalid");
                return;
            }

            String publicKey = requiredToken(proof.optString("publicKey"), "publicKey");
            String signature = requiredToken(proof.optString("signature"), "signature");
            String canonical = canonicalProof(attemptId, scanServiceRequestId, challenge, respondedAt);
            if (!DeviceKeyStore.verifyBase64(publicKey, canonical, signature)) {
                emitDiagnostic("ENC", "PROOF_SIGNATURE_INVALID");
                emitError("proof_signature_invalid");
                removeServerPeer(peer.address, true);
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

            removeServerPeer(peer.address, true);
            int verifiedCount = proofsByKey.size();
            int pendingCount = leaderPeers.size();
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
            failServerPeer(peer, "proof_invalid");
        }
    }

    private synchronized void scheduleLeaderTimeout(String completedAttemptId, long timeoutMs) {
        cancelLeaderTimeouts();
        leaderTimeout = () -> {
            synchronized (NearbyPresenceManager.this) {
                if (role != Role.LEADER || !attemptId.equals(completedAttemptId)) return;
                emitDiagnostic("ENC", "WINDOW_CLOSED");
                stopLeaderAdvertising();
                leaderCompleteTimeout = () -> completeLeaderScan(completedAttemptId);
                handler.postDelayed(leaderCompleteTimeout, CONNECTION_GRACE_MS);
            }
        };
        handler.postDelayed(leaderTimeout, timeoutMs);
    }

    private synchronized void failLeaderStart(String code) {
        if (role != Role.LEADER) return;
        cancelLeaderStartTimeout();
        cancelLeaderTimeouts();
        stopLeaderAdvertising();
        closeLeaderGattServer();
        role = Role.IDLE;
        emitError(code);
    }

    private synchronized void completeLeaderScan(String completedAttemptId) {
        if (role != Role.LEADER || !attemptId.equals(completedAttemptId)) return;
        cancelLeaderStartTimeout();
        cancelLeaderTimeouts();
        stopLeaderAdvertising();

        int verifiedCount = proofsByKey.size();
        int pendingCount = leaderPeers.size();
        emitDiagnostic("ENC", "SCAN_COMPLETE");
        emit("scan_complete", event -> {
            event.put("attemptId", completedAttemptId);
            event.put("verifiedCount", verifiedCount);
            event.put("pendingCount", pendingCount);
            event.put("expectedProofCount", expectedProofCount);
        });

        closeLeaderGattServer();
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
        cancelAuxiliaryServiceFallback();
        cancelAuxiliaryExchangeTimeout();
        cancelLeaderStartTimeout();
        cancelLeaderTimeouts();
        stopReadyRuntime();
        stopLeaderAdvertising();
        closeLeaderGattServer();

        readyServiceRequestId = "";
        suppressedLeaderAddress = "";
        suppressedLeaderUntilMs = 0L;
        attemptId = "";
        scanServiceRequestId = "";
        challenge = "";
        challengeSentAt = 0L;
        expectedProofCount = 0;
        leaderTimeoutMs = 6_000L;
        proofsByKey.clear();
        role = Role.IDLE;

        if (notify) emit("stopped", event -> {});
    }

    private synchronized void stopReadyRuntime() {
        stopReadyScanner();
        closeAuxiliaryGatt();
    }

    private synchronized void stopReadyScanner() {
        if (readyScanner != null) {
            try {
                readyScanner.stopScan(auxiliaryScanCallback);
            } catch (RuntimeException ignored) {
            }
        }
        readyScanner = null;
    }

    private synchronized void closeAuxiliaryGatt() {
        cancelAuxiliaryServiceFallback();
        cancelAuxiliaryExchangeTimeout();
        BluetoothGatt gatt = auxiliaryGatt;
        auxiliaryGatt = null;
        auxiliaryLeaderAddress = "";
        auxiliaryMtu = DEFAULT_MTU;
        auxiliaryServicesRequested = false;
        auxiliaryChallengeFrames.reset();
        auxiliaryChallengeCharacteristic = null;
        auxiliaryProofCharacteristic = null;
        auxiliaryProofFrames = Collections.emptyList();
        auxiliaryProofIndex = 0;

        if (gatt != null) {
            try {
                gatt.disconnect();
            } catch (RuntimeException ignored) {
            }
            closeGatt(gatt);
        }
    }

    private synchronized void cancelAuxiliaryServiceFallback() {
        if (auxiliaryServiceFallback != null) {
            handler.removeCallbacks(auxiliaryServiceFallback);
        }
        auxiliaryServiceFallback = null;
    }

    private synchronized void cancelAuxiliaryExchangeTimeout() {
        if (auxiliaryExchangeTimeout != null) {
            handler.removeCallbacks(auxiliaryExchangeTimeout);
        }
        auxiliaryExchangeTimeout = null;
    }

    private synchronized void stopLeaderAdvertising() {
        if (leaderAdvertiser != null) {
            try {
                leaderAdvertiser.stopAdvertising(leaderAdvertiseCallback);
            } catch (RuntimeException ignored) {
            }
        }
        leaderAdvertiser = null;
    }

    private synchronized void closeLeaderGattServer() {
        List<ServerPeer> peers = new ArrayList<>(leaderPeers.values());
        leaderPeers.clear();
        clearLeaderNotificationQueue();
        if (leaderGattServer != null) {
            for (ServerPeer peer : peers) {
                try {
                    leaderGattServer.cancelConnection(peer.device);
                } catch (RuntimeException ignored) {
                }
            }
            try {
                leaderGattServer.clearServices();
                leaderGattServer.close();
            } catch (RuntimeException ignored) {
            }
        }
        leaderGattServer = null;
        leaderChallengeCharacteristic = null;
        leaderProofCharacteristic = null;
    }

    private synchronized void clearLeaderNotificationQueue() {
        leaderNotificationQueue.clear();
        leaderNotificationInFlight = null;
    }

    private synchronized void removeQueuedNotifications(String address) {
        if (address == null || address.isEmpty()) return;
        Iterator<PendingNotification> iterator = leaderNotificationQueue.iterator();
        while (iterator.hasNext()) {
            if (address.equals(iterator.next().address)) iterator.remove();
        }
    }

    private synchronized void failServerPeer(ServerPeer peer, String code) {
        if (peer == null) return;
        removeServerPeer(peer.address, true);
        if (code != null && !code.isEmpty()) emitError(code);
    }

    private synchronized void removeServerPeer(String address, boolean cancelConnection) {
        if (address == null || address.isEmpty()) return;
        ServerPeer peer = leaderPeers.remove(address);
        removeQueuedNotifications(address);
        if (cancelConnection && peer != null && leaderGattServer != null) {
            try {
                leaderGattServer.cancelConnection(peer.device);
            } catch (RuntimeException ignored) {
            }
        }
    }

    private synchronized void cancelLeaderConnection(BluetoothDevice device) {
        if (leaderGattServer == null || device == null) return;
        try {
            leaderGattServer.cancelConnection(device);
        } catch (RuntimeException ignored) {
        }
    }

    private synchronized void sendLeaderServerResponse(
        BluetoothDevice device,
        int requestId,
        boolean responseNeeded,
        int status
    ) {
        if (!responseNeeded || leaderGattServer == null || device == null) return;
        try {
            leaderGattServer.sendResponse(device, requestId, status, 0, null);
        } catch (RuntimeException ignored) {
        }
    }

    private synchronized void cancelLeaderStartTimeout() {
        if (leaderStartTimeout != null) handler.removeCallbacks(leaderStartTimeout);
        leaderStartTimeout = null;
    }

    private synchronized void cancelLeaderTimeouts() {
        if (leaderTimeout != null) handler.removeCallbacks(leaderTimeout);
        if (leaderCompleteTimeout != null) handler.removeCallbacks(leaderCompleteTimeout);
        leaderTimeout = null;
        leaderCompleteTimeout = null;
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
            if (length > 0) {
                System.arraycopy(payload, offset, frame, FRAME_HEADER_BYTES, length);
            }
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

    private static void closeGatt(BluetoothGatt gatt) {
        if (gatt == null) return;
        try {
            gatt.close();
        } catch (RuntimeException ignored) {
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

        void reset() {
            bytes.reset();
            nextSequence = 0;
        }
    }

    private static final class ServerPeer {
        final BluetoothDevice device;
        final String address;
        final FrameAccumulator proofFrames = new FrameAccumulator();
        int mtu = DEFAULT_MTU;
        boolean challengeQueued = false;

        ServerPeer(BluetoothDevice device, String address) {
            this.device = device;
            this.address = address;
        }
    }

    private static final class PendingNotification {
        final String address;
        final byte[] frame;

        PendingNotification(String address, byte[] frame) {
            this.address = address;
            this.frame = frame;
        }
    }
}
