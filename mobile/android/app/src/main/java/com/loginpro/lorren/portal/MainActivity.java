package com.loginpro.lorren.portal;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

public final class MainActivity extends Activity {
    private static final int REQUEST_NEARBY = 4101;
    private static final int REQUEST_GEOLOCATION = 4102;
    private static final int REQUEST_CAMERA = 4103;
    private static final int REQUEST_APP_PREPARE = 4104;
    private static final int REQUEST_ENABLE_BLUETOOTH = 4105;
    private static final String PORTAL_PATH = "/operaciones/portal";
    private static final String HANDOFF_PATH = "/operaciones/portal/sesion-transferencia/continuar";
    private static final String NATIVE_USER_AGENT_TOKEN = "LorrenNative/1";

    private WebView webView;
    private PresenceBridge presenceBridge;
    private Uri portalBaseUri;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private PermissionRequest pendingCameraRequest;
    private boolean startupPreparationRequested;
    private boolean systemPromptInFlight;
    private boolean stoppedForSystemPrompt;
    private boolean stoppedForBackground;
    private boolean bluetoothEnableRequested;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        portalBaseUri = Uri.parse(normalizeBaseUrl(BuildConfig.PORTAL_BASE_URL));
        if (!"https".equalsIgnoreCase(portalBaseUri.getScheme()) || portalBaseUri.getHost() == null) {
            throw new IllegalStateException("lorrenPortalBaseUrl must be an https origin");
        }

        webView = new WebView(this);
        setContentView(webView);
        presenceBridge = new PresenceBridge(this);
        configureWebView();
        handleLaunchIntent(getIntent(), true);
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (stoppedForSystemPrompt) {
            stoppedForSystemPrompt = false;
            return;
        }
        if (!stoppedForBackground) return;
        stoppedForBackground = false;
        refreshPortalSilently();
    }

    @Override
    protected void onStop() {
        if (!isChangingConfigurations()) {
            if (systemPromptInFlight) stoppedForSystemPrompt = true;
            else stoppedForBackground = true;
        }
        super.onStop();
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        String userAgent = settings.getUserAgentString();
        if (userAgent != null && !userAgent.contains(NATIVE_USER_AGENT_TOKEN)) {
            settings.setUserAgentString(userAgent + " " + NATIVE_USER_AGENT_TOKEN);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);

        android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, false);

        webView.addJavascriptInterface(presenceBridge, PresenceBridge.JS_NAME);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri target = request.getUrl();
                if (isPortalUrl(target)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, target));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (!isPortalUrl(Uri.parse(url))) return;
                injectNativePresenceScript();
                prepareAttendanceDeviceOnce();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(
                String origin,
                GeolocationPermissions.Callback callback
            ) {
                if (!isPortalOrigin(origin)) {
                    callback.invoke(origin, false, false);
                    return;
                }
                if (hasPreciseLocationPermission()) {
                    callback.invoke(origin, true, false);
                    return;
                }
                pendingGeoCallback = callback;
                pendingGeoOrigin = origin;
                requestRuntimePermissions(locationRuntimePermissions(), REQUEST_GEOLOCATION);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!isPortalOrigin(request.getOrigin().toString())) {
                        request.deny();
                        return;
                    }
                    boolean asksForVideo = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) asksForVideo = true;
                    }
                    if (!asksForVideo) {
                        request.deny();
                        return;
                    }
                    if (hasPermission(Manifest.permission.CAMERA)) {
                        request.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
                        return;
                    }
                    pendingCameraRequest = request;
                    requestRuntimePermissions(new String[] { Manifest.permission.CAMERA }, REQUEST_CAMERA);
                });
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleLaunchIntent(intent, false);
    }

    private void handleLaunchIntent(Intent intent, boolean initial) {
        Uri data = intent == null ? null : intent.getData();
        if (isHandoffDeepLink(data)) {
            String token = data.getQueryParameter("transferencia");
            if (token != null && !token.trim().isEmpty()) {
                webView.loadUrl(baseUrl() + HANDOFF_PATH + "?transferencia=" + Uri.encode(token.trim()));
                return;
            }
        }
        if (initial) webView.loadUrl(baseUrl() + PORTAL_PATH);
    }

    private boolean isHandoffDeepLink(Uri uri) {
        return uri != null
            && "lorren".equalsIgnoreCase(uri.getScheme())
            && "portal".equalsIgnoreCase(uri.getHost())
            && uri.getPath() != null
            && uri.getPath().startsWith("/transferencia");
    }

    private String baseUrl() {
        return normalizeBaseUrl(BuildConfig.PORTAL_BASE_URL);
    }

    private static String normalizeBaseUrl(String value) {
        String normalized = value == null ? "" : value.trim();
        while (normalized.endsWith("/")) normalized = normalized.substring(0, normalized.length() - 1);
        return normalized;
    }

    private boolean isPortalUrl(Uri uri) {
        if (!isPortalOriginUri(uri)) return false;
        String path = uri.getPath();
        return path != null && (path.equals(PORTAL_PATH) || path.startsWith(PORTAL_PATH + "/"));
    }

    private boolean isPortalOrigin(String origin) {
        try {
            return isPortalOriginUri(Uri.parse(origin));
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean isPortalOriginUri(Uri uri) {
        return uri != null
            && "https".equalsIgnoreCase(uri.getScheme())
            && portalBaseUri.getHost().equalsIgnoreCase(uri.getHost())
            && effectivePort(portalBaseUri) == effectivePort(uri);
    }

    private static int effectivePort(Uri uri) {
        if (uri.getPort() > 0) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : -1;
    }

    private void injectNativePresenceScript() {
        try {
            BufferedReader reader = new BufferedReader(
                new InputStreamReader(getAssets().open("native-presence.js"), StandardCharsets.UTF_8)
            );
            String script = reader.lines().collect(Collectors.joining("\n"));
            reader.close();
            webView.evaluateJavascript(script, null);
        } catch (Exception ignored) {
            emitPresenceEvent(event("error", "code", "native_script_unavailable"));
        }
    }

    private void prepareAttendanceDeviceOnce() {
        if (startupPreparationRequested) return;
        startupPreparationRequested = true;
        List<String> missing = attendancePermissions(true);
        if (!missing.isEmpty()) {
            requestRuntimePermissions(missing.toArray(new String[0]), REQUEST_APP_PREPARE);
            return;
        }
        ensureNearbyRadioReady();
    }

    boolean ensureNearbyPermissions() {
        List<String> missing = attendancePermissions(false);
        if (missing.isEmpty()) return true;
        runOnUiThread(() -> requestRuntimePermissions(missing.toArray(new String[0]), REQUEST_NEARBY));
        return false;
    }

    String ensureNearbyRadioReady() {
        if (!nearbyPermissionsGranted()) {
            ensureNearbyPermissions();
            return "permissions_required";
        }
        BluetoothAdapter adapter = bluetoothAdapter();
        if (adapter == null) return "bluetooth_unavailable";
        try {
            if (adapter.isEnabled()) return null;
        } catch (SecurityException error) {
            ensureNearbyPermissions();
            return "permissions_required";
        }
        requestBluetoothEnable();
        return "bluetooth_disabled";
    }

    private String[] locationRuntimePermissions() {
        return new String[] {
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION
        };
    }

    private boolean hasPreciseLocationPermission() {
        return hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
            && hasPermission(Manifest.permission.ACCESS_FINE_LOCATION);
    }

    private void addPreciseLocationPermissionsIfNeeded(List<String> permissions) {
        if (hasPreciseLocationPermission()) return;
        permissions.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
    }

    private List<String> attendancePermissions(boolean includeCamera) {
        List<String> missing = new ArrayList<>();
        if (includeCamera) addIfMissing(missing, Manifest.permission.CAMERA);
        addPreciseLocationPermissionsIfNeeded(missing);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            addIfMissing(missing, Manifest.permission.BLUETOOTH_SCAN);
            addIfMissing(missing, Manifest.permission.BLUETOOTH_CONNECT);
            addIfMissing(missing, Manifest.permission.BLUETOOTH_ADVERTISE);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            addIfMissing(missing, Manifest.permission.NEARBY_WIFI_DEVICES);
        }
        return missing;
    }

    private BluetoothAdapter bluetoothAdapter() {
        BluetoothManager manager = getSystemService(BluetoothManager.class);
        return manager == null ? null : manager.getAdapter();
    }

    private void requestBluetoothEnable() {
        if (bluetoothEnableRequested) return;
        bluetoothEnableRequested = true;
        systemPromptInFlight = true;
        try {
            startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQUEST_ENABLE_BLUETOOTH);
        } catch (Exception error) {
            bluetoothEnableRequested = false;
            systemPromptInFlight = false;
            emitPresenceEvent(event("bluetooth", "enabled", false));
        }
    }

    private void requestRuntimePermissions(String[] permissions, int requestCode) {
        systemPromptInFlight = true;
        requestPermissions(permissions, requestCode);
    }

    private void refreshPortalSilently() {
        if (webView == null) return;
        Uri current;
        try {
            current = Uri.parse(webView.getUrl());
        } catch (Exception ignored) {
            return;
        }
        if (!isPortalUrl(current)) return;
        webView.evaluateJavascript(
            "(() => { if (!navigator.onLine) return; if (document.querySelector('#mark-dialog[open],#enrollment-dialog[open]')) return; window.location.reload(); })();",
            null
        );
    }

    private void addIfMissing(List<String> missing, String permission) {
        if (!hasPermission(permission)) missing.add(permission);
    }

    private boolean hasPermission(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        systemPromptInFlight = false;
        if (requestCode == REQUEST_GEOLOCATION && pendingGeoCallback != null) {
            boolean allowed = hasPreciseLocationPermission();
            pendingGeoCallback.invoke(pendingGeoOrigin, allowed, false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
            return;
        }
        if (requestCode == REQUEST_CAMERA && pendingCameraRequest != null) {
            if (hasPermission(Manifest.permission.CAMERA)) {
                pendingCameraRequest.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
            } else {
                pendingCameraRequest.deny();
            }
            pendingCameraRequest = null;
            return;
        }
        if (requestCode == REQUEST_APP_PREPARE) {
            if (nearbyPermissionsGranted()) ensureNearbyRadioReady();
            return;
        }
        if (requestCode == REQUEST_NEARBY) {
            boolean granted = nearbyPermissionsGranted();
            emitPresenceEvent(event("permissions", "granted", granted));
            if (granted) ensureNearbyRadioReady();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_ENABLE_BLUETOOTH) return;
        systemPromptInFlight = false;
        bluetoothEnableRequested = false;
        BluetoothAdapter adapter = bluetoothAdapter();
        boolean enabled = false;
        try {
            enabled = adapter != null && adapter.isEnabled();
        } catch (SecurityException ignored) {
        }
        emitPresenceEvent(event("bluetooth", "enabled", enabled));
    }

    private boolean nearbyPermissionsGranted() {
        if (!hasPreciseLocationPermission()) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!hasPermission(Manifest.permission.BLUETOOTH_SCAN)) return false;
            if (!hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) return false;
            if (!hasPermission(Manifest.permission.BLUETOOTH_ADVERTISE)) return false;
        }
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || hasPermission(Manifest.permission.NEARBY_WIFI_DEVICES);
    }

    void emitPresenceEvent(JSONObject event) {
        if (event == null || webView == null) return;
        String payload = event.toString();
        runOnUiThread(() -> webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('lorren-native-presence',{detail:" + payload + "}));",
            null
        ));
    }

    private static JSONObject event(String type, String key, Object value) {
        JSONObject event = new JSONObject();
        try {
            event.put("type", type);
            event.put(key, value);
        } catch (Exception ignored) {
        }
        return event;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (presenceBridge != null) presenceBridge.shutdown();
        if (webView != null) {
            webView.removeJavascriptInterface(PresenceBridge.JS_NAME);
            webView.destroy();
        }
        super.onDestroy();
    }
}
