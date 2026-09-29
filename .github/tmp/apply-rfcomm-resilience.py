from pathlib import Path

root = Path('.')
manager_path = root / 'mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'
activity_path = root / 'mobile/android/app/src/main/java/com/loginpro/lorren/portal/MainActivity.java'

manager = manager_path.read_text(encoding='utf-8')
activity = activity_path.read_text(encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, got {count}')
    return text.replace(old, new, 1)

activity = replace_once(
    activity,
    'import android.webkit.WebViewClient;\n',
    'import android.webkit.WebViewClient;\nimport android.view.WindowManager;\n',
    'MainActivity WindowManager import'
)

activity = replace_once(
    activity,
    '''    boolean ensureNearbyDiscoverable() {\n        BluetoothAdapter adapter = bluetoothAdapter();\n        if (adapter == null) return false;\n        try {\n            if (adapter.getScanMode() == BluetoothAdapter.SCAN_MODE_CONNECTABLE_DISCOVERABLE) return true;\n        } catch (SecurityException error) {\n            ensureNearbyPermissions();\n            return false;\n        }\n        requestBluetoothDiscoverable();\n        return false;\n    }\n''',
    '''    boolean ensureNearbyDiscoverable() {\n        BluetoothAdapter adapter = bluetoothAdapter();\n        if (adapter == null) return false;\n        try {\n            if (adapter.getScanMode() == BluetoothAdapter.SCAN_MODE_CONNECTABLE_DISCOVERABLE) return true;\n        } catch (SecurityException error) {\n            ensureNearbyPermissions();\n            return false;\n        }\n        requestBluetoothDiscoverable();\n        return false;\n    }\n\n    void refreshNearbyDiscoverableWindow() {\n        if (!nearbyTransportPermissionsGranted()) {\n            ensureNearbyPermissions();\n            return;\n        }\n        runOnUiThread(() -> {\n            if (bluetoothDiscoverableRequested || systemPromptInFlight) return;\n            requestBluetoothDiscoverable();\n        });\n    }\n\n    void setPresenceKeepScreenOn(boolean enabled) {\n        runOnUiThread(() -> {\n            if (enabled) {\n                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);\n            } else {\n                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);\n            }\n        });\n    }\n''',
    'MainActivity discoverability/screen helpers'
)

manager = replace_once(
    manager,
    '''    private static final long RFCOMM_EXCHANGE_TIMEOUT_MS = 12_000L;\n    private static final int MAX_DISCOVERED_DEVICES = 24;\n''',
    '''    private static final long RFCOMM_EXCHANGE_TIMEOUT_MS = 12_000L;\n    private static final long DISCOVERY_RESTART_DELAY_MS = 1_500L;\n    private static final long DISCOVERABILITY_REFRESH_MS = 240_000L;\n    private static final int MAX_DISCOVERY_BURSTS = 3;\n    private static final int MAX_DISCOVERED_DEVICES = 24;\n''',
    'manager constants'
)

manager = replace_once(
    manager,
    '''    private Thread auxiliaryAcceptThread;\n    private Thread auxiliaryExchangeThread;\n    private Runnable auxiliaryExchangeTimeout;\n''',
    '''    private Thread auxiliaryAcceptThread;\n    private Thread auxiliaryExchangeThread;\n    private Runnable auxiliaryExchangeTimeout;\n    private Runnable auxiliaryDiscoverabilityRefresh;\n''',
    'aux refresh field'
)

manager = replace_once(
    manager,
    '''    private boolean leaderReceiverRegistered = false;\n    private Runnable leaderInquiryCheckpoint;\n    private Runnable leaderTimeout;\n    private Runnable leaderCompleteTimeout;\n''',
    '''    private boolean leaderReceiverRegistered = false;\n    private int leaderDiscoveryBurst = 0;\n    private Runnable leaderDiscoveryRestart;\n    private Runnable leaderInquiryCheckpoint;\n    private Runnable leaderTimeout;\n    private Runnable leaderCompleteTimeout;\n''',
    'leader burst fields'
)

manager = replace_once(
    manager,
    '''        role = Role.READY;\n        readyServiceRequestId = normalizedService;\n''',
    '''        role = Role.READY;\n        activity.setPresenceKeepScreenOn(true);\n        readyServiceRequestId = normalizedService;\n''',
    'READY keep screen'
)

manager = replace_once(
    manager,
    '''        emitDiagnostic("AUX", "RFCOMM_SERVER_READY");\n        emitReady();\n        startAuxiliaryAcceptLoop(auxiliaryServerSocket);\n''',
    '''        emitDiagnostic("AUX", "RFCOMM_SERVER_READY");\n        scheduleAuxiliaryDiscoverabilityRefresh();\n        emitReady();\n        startAuxiliaryAcceptLoop(auxiliaryServerSocket);\n''',
    'aux discoverability schedule'
)

manager = replace_once(
    manager,
    '''    private synchronized void scheduleAuxiliaryExchangeTimeout(BluetoothSocket socket) {\n''',
    '''    private synchronized void scheduleAuxiliaryDiscoverabilityRefresh() {\n        cancelAuxiliaryDiscoverabilityRefresh();\n        auxiliaryDiscoverabilityRefresh = () -> {\n            synchronized (NearbyPresenceManager.this) {\n                if (role != Role.READY || auxiliaryServerSocket == null) return;\n                emitDiagnostic("AUX", "DISCOVERABLE_REFRESH_REQUESTED");\n            }\n            activity.refreshNearbyDiscoverableWindow();\n            synchronized (NearbyPresenceManager.this) {\n                if (role == Role.READY && auxiliaryServerSocket != null) {\n                    scheduleAuxiliaryDiscoverabilityRefresh();\n                }\n            }\n        };\n        handler.postDelayed(auxiliaryDiscoverabilityRefresh, DISCOVERABILITY_REFRESH_MS);\n    }\n\n    private synchronized void cancelAuxiliaryDiscoverabilityRefresh() {\n        if (auxiliaryDiscoverabilityRefresh != null) {\n            handler.removeCallbacks(auxiliaryDiscoverabilityRefresh);\n        }\n        auxiliaryDiscoverabilityRefresh = null;\n    }\n\n    private synchronized void scheduleAuxiliaryExchangeTimeout(BluetoothSocket socket) {\n''',
    'aux discoverability helpers'
)

for label, old, new in [
    ('failReady', '''        role = Role.IDLE;\n        readyServiceRequestId = "";\n        emitError(code);\n''', '''        role = Role.IDLE;\n        activity.setPresenceKeepScreenOn(false);\n        readyServiceRequestId = "";\n        emitError(code);\n'''),
    ('failReadyPermissions', '''        role = Role.IDLE;\n        readyServiceRequestId = "";\n        emitPermissionsRequired("AUX", operation, error);\n''', '''        role = Role.IDLE;\n        activity.setPresenceKeepScreenOn(false);\n        readyServiceRequestId = "";\n        emitPermissionsRequired("AUX", operation, error);\n'''),
    ('failReadyBluetooth', '''        role = Role.IDLE;\n        readyServiceRequestId = "";\n        emitBluetoothUnavailable("AUX", operation, error);\n''', '''        role = Role.IDLE;\n        activity.setPresenceKeepScreenOn(false);\n        readyServiceRequestId = "";\n        emitBluetoothUnavailable("AUX", operation, error);\n''')
]:
    manager = replace_once(manager, old, new, label)

manager = replace_once(
    manager,
    '''        role = Role.LEADER;\n        attemptId = nextAttemptId;\n''',
    '''        role = Role.LEADER;\n        activity.setPresenceKeepScreenOn(true);\n        attemptId = nextAttemptId;\n''',
    'LEADER keep screen'
)

manager = replace_once(
    manager,
    '''        leaderTimeoutMs = timeoutMs;\n        proofsByKey.clear();\n''',
    '''        leaderTimeoutMs = timeoutMs;\n        leaderDiscoveryBurst = 0;\n        proofsByKey.clear();\n''',
    'reset leader burst'
)

manager = replace_once(
    manager,
    '''            emitDiagnostic("ENC", "CLASSIC_DISCOVERY_START");\n            if (!bluetoothAdapter.startDiscovery()) {\n                failLeaderBluetooth("leader_discovery", null);\n                return;\n            }\n            challengeSentAt = System.currentTimeMillis();\n            emitLeaderScanStarted();\n            scheduleLeaderTimeout(nextAttemptId, timeoutMs);\n            scheduleLeaderInquiryCheckpoint(nextAttemptId);\n''',
    '''            challengeSentAt = System.currentTimeMillis();\n            emitLeaderScanStarted();\n            scheduleLeaderTimeout(nextAttemptId, timeoutMs);\n            if (!startLeaderDiscoveryBurst(nextAttemptId)) {\n                failLeaderBluetooth("leader_discovery", null);\n            }\n''',
    'initial leader discovery'
)

manager = replace_once(
    manager,
    '''            if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(action)) {\n                synchronized (NearbyPresenceManager.this) {\n                    if (role != Role.LEADER) return;\n                    cancelLeaderInquiryCheckpoint();\n                    emitDiagnostic("ENC", "CLASSIC_INQUIRY_FINISHED");\n                }\n                requestSdpForDiscoveredDevices();\n                return;\n            }\n''',
    '''            if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(action)) {\n                String completedAttemptId;\n                boolean retryDiscovery;\n                synchronized (NearbyPresenceManager.this) {\n                    if (role != Role.LEADER) return;\n                    cancelLeaderInquiryCheckpoint();\n                    emitDiagnostic("ENC", "CLASSIC_INQUIRY_FINISHED");\n                    completedAttemptId = attemptId;\n                    retryDiscovery = proofsByKey.size() < expectedProofCount\n                        && leaderDiscoveryBurst < MAX_DISCOVERY_BURSTS;\n                }\n                requestSdpForDiscoveredDevices();\n                if (retryDiscovery) scheduleLeaderDiscoveryRestart(completedAttemptId);\n                return;\n            }\n''',
    'discovery finished retry'
)

manager = replace_once(
    manager,
    '''    private synchronized void rememberDiscoveredDevice(BluetoothDevice device) {\n''',
    '''    private synchronized boolean startLeaderDiscoveryBurst(String currentAttemptId) {\n        if (role != Role.LEADER || !attemptId.equals(currentAttemptId)) return false;\n        if (leaderDiscoveryBurst >= MAX_DISCOVERY_BURSTS || bluetoothAdapter == null) return false;\n        try {\n            ensureNearbyTransportPermissions();\n            if (bluetoothAdapter.isDiscovering()) bluetoothAdapter.cancelDiscovery();\n            sdpRequestedAddresses.clear();\n            leaderDiscoveryBurst += 1;\n            emitDiagnostic("ENC", "CLASSIC_DISCOVERY_START");\n            if (!bluetoothAdapter.startDiscovery()) {\n                leaderDiscoveryBurst -= 1;\n                return false;\n            }\n            scheduleLeaderInquiryCheckpoint(currentAttemptId);\n            return true;\n        } catch (SecurityException error) {\n            failLeaderPermissions("leader_discovery", error);\n            return false;\n        } catch (RuntimeException error) {\n            failLeaderBluetooth("leader_discovery", error);\n            return false;\n        }\n    }\n\n    private synchronized void scheduleLeaderDiscoveryRestart(String completedAttemptId) {\n        cancelLeaderDiscoveryRestart();\n        leaderDiscoveryRestart = () -> {\n            synchronized (NearbyPresenceManager.this) {\n                if (role != Role.LEADER || !attemptId.equals(completedAttemptId)) return;\n                if (proofsByKey.size() >= expectedProofCount) return;\n                if (leaderDiscoveryBurst >= MAX_DISCOVERY_BURSTS) return;\n                if (!leaderConnectionAddresses.isEmpty()) {\n                    scheduleLeaderDiscoveryRestart(completedAttemptId);\n                    return;\n                }\n                emitDiagnostic("ENC", "CLASSIC_DISCOVERY_RETRY");\n                if (!startLeaderDiscoveryBurst(completedAttemptId)) {\n                    failLeaderBluetooth("leader_discovery", null);\n                }\n            }\n        };\n        handler.postDelayed(leaderDiscoveryRestart, DISCOVERY_RESTART_DELAY_MS);\n    }\n\n    private synchronized void cancelLeaderDiscoveryRestart() {\n        if (leaderDiscoveryRestart != null) handler.removeCallbacks(leaderDiscoveryRestart);\n        leaderDiscoveryRestart = null;\n    }\n\n    private synchronized void rememberDiscoveredDevice(BluetoothDevice device) {\n''',
    'leader discovery helpers'
)

for label, old, new in [
    ('failLeaderStart', '''        role = Role.IDLE;\n        emitError(code);\n''', '''        role = Role.IDLE;\n        activity.setPresenceKeepScreenOn(false);\n        emitError(code);\n'''),
    ('failLeaderPermissions', '''        role = Role.IDLE;\n        emitPermissionsRequired("ENC", operation, error);\n''', '''        role = Role.IDLE;\n        activity.setPresenceKeepScreenOn(false);\n        emitPermissionsRequired("ENC", operation, error);\n'''),
    ('failLeaderBluetooth', '''        role = Role.IDLE;\n        emitBluetoothUnavailable("ENC", operation, error);\n''', '''        role = Role.IDLE;\n        activity.setPresenceKeepScreenOn(false);\n        emitBluetoothUnavailable("ENC", operation, error);\n''')
]:
    manager = replace_once(manager, old, new, label)

manager = replace_once(
    manager,
    '''        role = Role.IDLE;\n    }\n\n    synchronized void stopReady() {\n''',
    '''        role = Role.IDLE;\n        activity.setPresenceKeepScreenOn(false);\n    }\n\n    synchronized void stopReady() {\n''',
    'complete scan release screen'
)

manager = replace_once(
    manager,
    '''        cancelAuxiliaryExchangeTimeout();\n        cancelLeaderTimeouts();\n''',
    '''        cancelAuxiliaryExchangeTimeout();\n        cancelAuxiliaryDiscoverabilityRefresh();\n        cancelLeaderTimeouts();\n''',
    'stopAll cancels aux refresh'
)

manager = replace_once(
    manager,
    '''        leaderTimeoutMs = MIN_SCAN_MS;\n        proofsByKey.clear();\n''',
    '''        leaderTimeoutMs = MIN_SCAN_MS;\n        leaderDiscoveryBurst = 0;\n        proofsByKey.clear();\n''',
    'stopAll resets burst'
)

manager = replace_once(
    manager,
    '''        role = Role.IDLE;\n        if (notify) emit("stopped", event -> {});\n''',
    '''        role = Role.IDLE;\n        activity.setPresenceKeepScreenOn(false);\n        if (notify) emit("stopped", event -> {});\n''',
    'stopAll release screen'
)

manager = replace_once(
    manager,
    '''    private synchronized void stopReadyRuntime() {\n        closeAuxiliarySocket();\n''',
    '''    private synchronized void stopReadyRuntime() {\n        cancelAuxiliaryDiscoverabilityRefresh();\n        closeAuxiliarySocket();\n''',
    'stopReady cancel refresh'
)

manager = replace_once(
    manager,
    '''    private synchronized void cancelLeaderTimeouts() {\n        cancelLeaderInquiryCheckpoint();\n''',
    '''    private synchronized void cancelLeaderTimeouts() {\n        cancelLeaderDiscoveryRestart();\n        cancelLeaderInquiryCheckpoint();\n''',
    'cancel leader restart'
)

manager_path.write_text(manager, encoding='utf-8')
activity_path.write_text(activity, encoding='utf-8')

# Contract checks: permissions stay intact, discoverability is 300 seconds, screen flag is scoped,
# and leader discovery has at most three native bursts.
assert 'BLUETOOTH_DISCOVERABLE_SECONDS = 300' in activity
assert 'Manifest.permission.BLUETOOTH_ADVERTISE' in activity
assert 'FLAG_KEEP_SCREEN_ON' in activity
assert 'MAX_DISCOVERY_BURSTS = 3' in manager
assert 'CLASSIC_DISCOVERY_RETRY' in manager
assert 'DISCOVERABILITY_REFRESH_MS = 240_000L' in manager
