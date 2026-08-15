package com.loginpro.lorren.portal;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

final class PresenceBridge {
    static final String JS_NAME = "LorrenAndroidPresence";
    private static final String PREFS = "lorren_presence_native_v1";
    private static final String CREDENTIAL_KEY = "presence_credential";

    private final MainActivity activity;
    private final SharedPreferences preferences;
    private final NearbyPresenceManager manager;

    PresenceBridge(MainActivity activity) {
        this.activity = activity;
        this.preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.manager = new NearbyPresenceManager(
            activity,
            activity::emitPresenceEvent,
            () -> preferences.getString(CREDENTIAL_KEY, "")
        );
    }

    @JavascriptInterface
    public String getCapabilities() {
        JSONObject result = new JSONObject();
        try {
            result.put("androidNative", true);
            result.put("offlineNearby", true);
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
        try {
            manager.startLeaderScan(new JSONObject(inputJson == null ? "{}" : inputJson));
            return jsonOk();
        } catch (Exception error) {
            return jsonError("scan_input_invalid");
        }
    }

    @JavascriptInterface
    public String stopCrewScan() {
        manager.stopLeaderScan();
        return jsonOk();
    }

    @JavascriptInterface
    public String getProofBundle() {
        return manager.proofBundle().toString();
    }

    void shutdown() {
        manager.shutdown();
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
