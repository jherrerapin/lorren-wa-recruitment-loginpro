package com.loginpro.lorren.portal;

import android.content.Context;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.util.Locale;

final class PresenceBridge {
    static final String JS_NAME = "LorrenAndroidPresence";
    private static final String PREFS = "lorren_presence_native_v1";
    private static final String CREDENTIAL_KEY = "presence_credential";
    private static final String NATIVE_ATTENDANCE_LOCATION_CONTEXT = "lorren-native-attendance-location-v1";
    private static final long MAX_LAST_LOCATION_AGE_MS = 30_000L;
    private static final long LOCATION_TIMEOUT_MS = 15_000L;

    private interface NativeLocationSink {
        void onLocation(Location location);
        void onError(String code);
    }

    private final MainActivity activity;
    private final SharedPreferences preferences;
    private final NearbyPresenceManager manager;
    private final LocationManager locationManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private LocationListener pendingLocationListener;
    private Runnable pendingLocationTimeout;
    private JSONObject leaderLocationProof;

    PresenceBridge(MainActivity activity) {
        this.activity = activity;
        this.preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.manager = new NearbyPresenceManager(
            activity,
            activity::emitPresenceEvent,
            () -> preferences.getString(CREDENTIAL_KEY, "")
        );
        this.locationManager = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
    }

    @JavascriptInterface
    public String getCapabilities() {
        JSONObject result = new JSONObject();
        try {
            result.put("androidNative", true);
            result.put("appVersionCode", BuildConfig.VERSION_CODE);
            result.put("appVersionName", BuildConfig.VERSION_NAME);
            result.put("offlineNearby", true);
            result.put("nativeAttendanceLocation", true);
            result.put("mockLocationSignal", true);
            result.put("protocolVersion", 1);
            result.put("attendanceWriter", false);
        } catch (Exception ignored) {
        }
        return result.toString();
    }

    @JavascriptInterface
    public String getPublicKey() {
        try {
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("publicKey", DeviceKeyStore.publicKeyBase64());
            return result.toString();
        } catch (Exception error) {
            return jsonError("device_key_unavailable");
        }
    }

    @JavascriptInterface
    public String setPresenceCredential(String credential) {
        String normalized = credential == null ? "" : credential.trim();
        if (normalized.length() > 16_384) return jsonError("credential_too_large");
        preferences.edit().putString(CREDENTIAL_KEY, normalized).apply();
        return jsonOk();
    }

    @JavascriptInterface
    public String setReady(String serviceRequestId) {
        if (!activity.ensureNearbyPermissions()) return jsonError("permissions_required");
        String readinessError = activity.ensureNearbyRadioReady();
        if (readinessError != null) return jsonError(readinessError);
        try {
            manager.startReady(serviceRequestId);
            return jsonOk();
        } catch (Exception error) {
            return jsonError("ready_failed");
        }
    }

    @JavascriptInterface
    public String stopReady() {
        manager.stopReady();
        return jsonOk();
    }

    @JavascriptInterface
    public String startCrewScan(String inputJson) {
        if (!activity.ensureNearbyPermissions()) return jsonError("permissions_required");
        String readinessError = activity.ensureNearbyRadioReady();
        if (readinessError != null) return jsonError(readinessError);
        try {
            JSONObject input = new JSONObject(inputJson == null ? "{}" : inputJson);
            synchronized (this) {
                leaderLocationProof = null;
            }
            manager.startLeaderScan(input);
            captureLeaderLocation(input);
            return jsonOk();
        } catch (Exception error) {
            return jsonError("scan_input_invalid");
        }
    }

    @JavascriptInterface
    public String stopCrewScan() {
        cancelPendingLocation();
        manager.stopLeaderScan();
        return jsonOk();
    }

    @JavascriptInterface
    public String getProofBundle() {
        JSONObject bundle = manager.proofBundle();
        try {
            JSONObject proof;
            synchronized (this) {
                proof = leaderLocationProof == null ? null : new JSONObject(leaderLocationProof.toString());
            }
            if (proof != null
                && bundle.optString("attemptId").equals(proof.optString("attemptId"))
                && bundle.optString("serviceRequestId").equals(proof.optString("serviceRequestId"))) {
                bundle.put("leaderLocationProof", proof);
            } else {
                bundle.put("leaderLocationState", "UNAVAILABLE");
            }
        } catch (Exception ignored) {
        }
        return bundle.toString();
    }

    @JavascriptInterface
    public String requestAttendanceLocation(String inputJson) {
        if (!activity.ensureNearbyPermissions()) return jsonError("permissions_required");
        String credential = presenceCredential();
        if (credential.isEmpty()) return jsonError("native_location_credential_required");
        try {
            JSONObject input = new JSONObject(inputJson == null ? "{}" : inputJson);
            String assignmentId = requiredToken(input.optString("assignmentId"), "assignmentId");
            String markType = normalizedMarkType(input.optString("markType"));
            String idempotencyKey = requiredToken(input.optString("idempotencyKey"), "idempotencyKey");
            captureNativeLocation(false, new NativeLocationSink() {
                @Override
                public void onLocation(Location location) {
                    storeAttendanceLocationProof(
                        assignmentId,
                        markType,
                        idempotencyKey,
                        credential,
                        location
                    );
                }

                @Override
                public void onError(String code) {
                    emitAttendanceLocationError(assignmentId, markType, idempotencyKey, code);
                }
            });
            return jsonOk();
        } catch (Exception error) {
            return jsonError("native_attendance_location_input_invalid");
        }
    }

    void shutdown() {
        cancelPendingLocation();
        manager.shutdown();
    }

    private void captureLeaderLocation(JSONObject input) {
        String attemptId = requiredToken(input.optString("attemptId"), "attemptId");
        String serviceRequestId = requiredToken(input.optString("serviceRequestId"), "serviceRequestId");
        captureNativeLocation(true, new NativeLocationSink() {
            @Override
            public void onLocation(Location location) {
                storeLeaderLocationProof(attemptId, serviceRequestId, location);
            }

            @Override
            public void onError(String code) {
                emitLocationError(code);
            }
        });
    }

    private void captureNativeLocation(boolean allowRecent, NativeLocationSink sink) {
        if (locationManager == null) {
            sink.onError("native_location_unavailable");
            return;
        }

        Location recent = allowRecent ? freshestLastKnownLocation() : null;
        boolean deliveredRecent = recent != null;
        if (deliveredRecent) sink.onLocation(recent);

        String provider = preferredProvider();
        if (provider == null) {
            if (!deliveredRecent) sink.onError("native_location_unavailable");
            return;
        }

        cancelPendingLocation();
        LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                cancelPendingLocation();
                sink.onLocation(location);
            }

            @Override
            public void onProviderEnabled(String providerName) {
            }

            @Override
            public void onProviderDisabled(String providerName) {
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onStatusChanged(String providerName, int status, Bundle extras) {
            }
        };
        synchronized (this) {
            pendingLocationListener = listener;
            pendingLocationTimeout = () -> {
                cancelPendingLocation();
                if (!deliveredRecent) sink.onError("native_location_unavailable");
            };
        }
        try {
            activity.runOnUiThread(() -> {
                try {
                    locationManager.requestSingleUpdate(provider, listener, Looper.getMainLooper());
                    Runnable timeout;
                    synchronized (PresenceBridge.this) {
                        timeout = pendingLocationTimeout;
                    }
                    if (timeout != null) mainHandler.postDelayed(timeout, LOCATION_TIMEOUT_MS);
                } catch (SecurityException error) {
                    cancelPendingLocation();
                    sink.onError("permissions_required");
                } catch (Exception error) {
                    cancelPendingLocation();
                    sink.onError("native_location_unavailable");
                }
            });
        } catch (Exception error) {
            cancelPendingLocation();
            sink.onError("native_location_unavailable");
        }
    }

    private Location freshestLastKnownLocation() {
        Location best = null;
        for (String provider : new String[] { LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
            try {
                if (!locationManager.isProviderEnabled(provider)) continue;
                Location candidate = locationManager.getLastKnownLocation(provider);
                if (candidate == null || locationAgeMs(candidate) > MAX_LAST_LOCATION_AGE_MS) continue;
                if (best == null || candidate.getAccuracy() < best.getAccuracy()) best = candidate;
            } catch (SecurityException ignored) {
                return null;
            } catch (Exception ignored) {
            }
        }
        return best;
    }

    private String preferredProvider() {
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) return LocationManager.GPS_PROVIDER;
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) return LocationManager.NETWORK_PROVIDER;
        } catch (Exception ignored) {
        }
        return null;
    }

    private static long locationAgeMs(Location location) {
        long elapsedNanos = location.getElapsedRealtimeNanos();
        if (elapsedNanos <= 0L) return Long.MAX_VALUE;
        long ageNanos = SystemClock.elapsedRealtimeNanos() - elapsedNanos;
        return Math.max(0L, ageNanos / 1_000_000L);
    }

    private void storeLeaderLocationProof(String attemptId, String serviceRequestId, Location location) {
        if (location == null) return;
        try {
            String latitude = latitude(location);
            String longitude = longitude(location);
            String accuracy = accuracy(location);
            long capturedAt = capturedAt(location);
            boolean mock = isMockLocation(location);
            String canonical = canonicalLocationProof(
                attemptId,
                serviceRequestId,
                latitude,
                longitude,
                accuracy,
                capturedAt,
                mock
            );

            JSONObject proof = new JSONObject();
            proof.put("version", 1);
            proof.put("attemptId", attemptId);
            proof.put("serviceRequestId", serviceRequestId);
            proof.put("latitude", latitude);
            proof.put("longitude", longitude);
            proof.put("accuracyMeters", accuracy);
            proof.put("capturedAt", capturedAt);
            proof.put("isMock", mock);
            proof.put("publicKey", DeviceKeyStore.publicKeyBase64());
            proof.put("signature", DeviceKeyStore.signBase64(canonical));
            proof.put("credential", presenceCredential());
            synchronized (this) {
                leaderLocationProof = proof;
            }
            JSONObject event = new JSONObject();
            event.put("type", "native_location_ready");
            event.put("mock", mock);
            activity.emitPresenceEvent(event);
        } catch (Exception error) {
            emitLocationError("native_location_proof_failed");
        }
    }

    private void storeAttendanceLocationProof(
        String assignmentId,
        String markType,
        String idempotencyKey,
        String credential,
        Location location
    ) {
        if (location == null) return;
        try {
            String latitude = latitude(location);
            String longitude = longitude(location);
            String accuracy = accuracy(location);
            long capturedAt = capturedAt(location);
            boolean mock = isMockLocation(location);
            if (mock) {
                emitAttendanceLocationError(
                    assignmentId,
                    markType,
                    idempotencyKey,
                    "mock_location_detected"
                );
                return;
            }
            String canonical = canonicalAttendanceLocationProof(
                assignmentId,
                markType,
                idempotencyKey,
                latitude,
                longitude,
                accuracy,
                capturedAt,
                false
            );
            JSONObject proof = new JSONObject();
            proof.put("version", 1);
            proof.put("assignmentId", assignmentId);
            proof.put("markType", markType);
            proof.put("idempotencyKey", idempotencyKey);
            proof.put("latitude", latitude);
            proof.put("longitude", longitude);
            proof.put("accuracyMeters", accuracy);
            proof.put("capturedAt", capturedAt);
            proof.put("isMock", false);
            proof.put("publicKey", DeviceKeyStore.publicKeyBase64());
            proof.put("signature", DeviceKeyStore.signBase64(canonical));
            proof.put("credential", credential);

            JSONObject event = new JSONObject();
            event.put("type", "attendance_location_ready");
            event.put("assignmentId", assignmentId);
            event.put("markType", markType);
            event.put("idempotencyKey", idempotencyKey);
            event.put("proof", proof);
            activity.emitPresenceEvent(event);
        } catch (Exception error) {
            emitAttendanceLocationError(
                assignmentId,
                markType,
                idempotencyKey,
                "native_location_proof_failed"
            );
        }
    }

    private static String latitude(Location location) {
        return String.format(Locale.US, "%.7f", location.getLatitude());
    }

    private static String longitude(Location location) {
        return String.format(Locale.US, "%.7f", location.getLongitude());
    }

    private static String accuracy(Location location) {
        return String.format(Locale.US, "%.2f", Math.max(0f, location.getAccuracy()));
    }

    private static long capturedAt(Location location) {
        return location.getTime() > 0L ? location.getTime() : System.currentTimeMillis();
    }

    private String presenceCredential() {
        String credential = preferences.getString(CREDENTIAL_KEY, "");
        return credential == null ? "" : credential.trim();
    }

    private static boolean isMockLocation(Location location) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return location.isMock();
        return location.isFromMockProvider();
    }

    private static String canonicalLocationProof(
        String attemptId,
        String serviceRequestId,
        String latitude,
        String longitude,
        String accuracyMeters,
        long capturedAt,
        boolean mock
    ) {
        return "lorren-native-location-v1\n"
            + attemptId + "\n"
            + serviceRequestId + "\n"
            + latitude + "\n"
            + longitude + "\n"
            + accuracyMeters + "\n"
            + capturedAt + "\n"
            + (mock ? "1" : "0");
    }

    private static String canonicalAttendanceLocationProof(
        String assignmentId,
        String markType,
        String idempotencyKey,
        String latitude,
        String longitude,
        String accuracyMeters,
        long capturedAt,
        boolean mock
    ) {
        return NATIVE_ATTENDANCE_LOCATION_CONTEXT + "\n"
            + assignmentId + "\n"
            + markType + "\n"
            + idempotencyKey + "\n"
            + latitude + "\n"
            + longitude + "\n"
            + accuracyMeters + "\n"
            + capturedAt + "\n"
            + (mock ? "1" : "0");
    }

    private synchronized void cancelPendingLocation() {
        if (pendingLocationTimeout != null) mainHandler.removeCallbacks(pendingLocationTimeout);
        pendingLocationTimeout = null;
        LocationListener listener = pendingLocationListener;
        pendingLocationListener = null;
        if (listener == null || locationManager == null) return;
        activity.runOnUiThread(() -> {
            try {
                locationManager.removeUpdates(listener);
            } catch (SecurityException ignored) {
            }
        });
    }

    private void emitLocationError(String code) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "error");
            event.put("code", code);
            activity.emitPresenceEvent(event);
        } catch (Exception ignored) {
        }
    }

    private void emitAttendanceLocationError(
        String assignmentId,
        String markType,
        String idempotencyKey,
        String code
    ) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "attendance_location_error");
            event.put("assignmentId", assignmentId);
            event.put("markType", markType);
            event.put("idempotencyKey", idempotencyKey);
            event.put("code", code);
            activity.emitPresenceEvent(event);
        } catch (Exception ignored) {
        }
    }

    private static String normalizedMarkType(String value) {
        String normalized = requiredToken(value, "markType").toUpperCase(Locale.ROOT);
        if (
            !"ARRIVAL".equals(normalized)
            && !"BREAK_START".equals(normalized)
            && !"BREAK_END".equals(normalized)
            && !"DEPARTURE".equals(normalized)
        ) {
            throw new IllegalArgumentException("markType_invalid");
        }
        return normalized;
    }

    private static String requiredToken(String value, String label) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.isEmpty() || normalized.length() > 2_048) {
            throw new IllegalArgumentException(label + "_invalid");
        }
        return normalized;
    }

    private static String jsonOk() {
        return "{\"ok\":true}";
    }

    private static String jsonError(String code) {
        try {
            JSONObject result = new JSONObject();
            result.put("ok", false);
            result.put("error", code);
            return result.toString();
        } catch (Exception ignored) {
            return "{\"ok\":false,\"error\":\"native_error\"}";
        }
    }
}
