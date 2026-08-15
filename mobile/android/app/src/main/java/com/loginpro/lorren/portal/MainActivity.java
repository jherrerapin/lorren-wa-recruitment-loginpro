package com.loginpro.lorren.portal;

import android.Manifest;
import android.app.Activity;
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
    private static final String PORTAL_PATH = "/operaciones/portal";
    private static final String HANDOFF_PATH = "/operaciones/portal/sesion-transferencia/continuar";

    private WebView webView;
    private PresenceBridge presenceBridge;
    private Uri portalBaseUri;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private PermissionRequest pendingCameraRequest;

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
                if (isPortalUrl(Uri.parse(url))) injectNativePresenceScript();
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
                if (hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
                    callback.invoke(origin, true, false);
                    return;
                }
                pendingGeoCallback = callback;
                pendingGeoOrigin = origin;
                requestPermissions(new String[] { Manifest.permission.ACCESS_FINE_LOCATION }, REQUEST_GEOLOCATION);
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
                    requestPermissions(new String[] { Manifest.permission.CAMERA }, REQUEST_CAMERA);
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

    boolean ensureNearbyPermissions() {
        List<String> missing = new ArrayList<>();
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
            missing.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            addIfMissing(missing, Manifest.permission.BLUETOOTH_SCAN);
            addIfMissing(missing, Manifest.permission.BLUETOOTH_CONNECT);
            addIfMissing(missing, Manifest.permission.BLUETOOTH_ADVERTISE);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            addIfMissing(missing, Manifest.permission.NEARBY_WIFI_DEVICES);
        }
        if (missing.isEmpty()) return true;
        runOnUiThread(() -> requestPermissions(missing.toArray(new String[0]), REQUEST_NEARBY));
        return false;
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
        if (requestCode == REQUEST_GEOLOCATION && pendingGeoCallback != null) {
            boolean allowed = hasPermission(Manifest.permission.ACCESS_FINE_LOCATION);
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
        if (requestCode == REQUEST_NEARBY) {
            emitPresenceEvent(event(
                "permissions",
                "granted",
                nearbyPermissionsGranted()
            ));
        }
    }

    private boolean nearbyPermissionsGranted() {
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) return false;
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
