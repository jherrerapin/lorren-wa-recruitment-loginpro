from pathlib import Path
import re

path = Path('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
s = path.read_text()

for line in [
    'import android.content.BroadcastReceiver;\n',
    'import android.content.Intent;\n',
    'import android.content.IntentFilter;\n',
    'import android.os.Parcelable;\n',
    '    private static final long INQUIRY_CHECKPOINT_MS = 15_000L;\n',
    '    private static final long DISCOVERY_RESTART_DELAY_MS = 1_500L;\n',
    '    private static final int MAX_DISCOVERY_BURSTS = 3;\n',
    '    private static final int MAX_DISCOVERED_DEVICES = 24;\n',
    '    private final Map<String, BluetoothDevice> discoveredDevices = new LinkedHashMap<>();\n',
    '    private final Set<String> sdpRequestedAddresses = new LinkedHashSet<>();\n',
    '    private boolean leaderReceiverRegistered = false;\n',
    '    private Runnable leaderInquiryCheckpoint;\n',
    '    private Runnable leaderDiscoveryRestart;\n',
    '    private int leaderDiscoveryBurst = 0;\n',
    '        leaderDiscoveryBurst = 0;\n',
    '        discoveredDevices.clear();\n',
    '        sdpRequestedAddresses.clear();\n',
    '        cancelLeaderDiscoveryRestart();\n',
    '        cancelLeaderInquiryCheckpoint();\n',
]:
    s = s.replace(line, '')

s = s.replace(
    '    // Bluetooth Classic inquiry suele consumir ~12 s. La ventana nativa deja\n'
    '    // margen real para inquiry + SDP + RFCOMM y termina antes si llegan las proofs.\n',
    '    // BLE descubre auxiliares de forma inmediata por UUID; RFCOMM conserva\n'
    '    // el intercambio challenge/proof y la ventana termina al completar proofs.\n'
)

# MAC válida -> conexión RFCOMM inmediata.
s = re.sub(
    r'''                public void onScanResult\(int callbackType, ScanResult result\) \{\n                    BluetoothDevice device = result == null \? null : result\.getDevice\(\);\n(?:                    if \(device == null\) return;\n                    String address = safeAddress\(device\);\n                    if \(address\.isEmpty\(\)\) return;\n)?                    synchronized \(NearbyPresenceManager\.this\) \{\n                        if \(role != Role\.LEADER \|\| leaderBleScanCallback != this\) return;\n                        emitDiagnostic\("ENC", "BLE_SERVICE_FOUND"\);\n                    \}\n(?:                    if \(device != null\) )?connectLeaderToAuxiliary\(device\);\n                \}\n''',
    '''                public void onScanResult(int callbackType, ScanResult result) {\n                    BluetoothDevice device = result == null ? null : result.getDevice();\n                    if (device == null) return;\n                    String address = safeAddress(device);\n                    if (address.isEmpty()) return;\n                    synchronized (NearbyPresenceManager.this) {\n                        if (role != Role.LEADER || leaderBleScanCallback != this) return;\n                        emitDiagnostic("ENC", "BLE_SERVICE_FOUND");\n                    }\n                    connectLeaderToAuxiliary(device);\n                }\n''',
    s,
    count=1,
)

# Retira el bloque completo Classic/SDP entre el callback BLE y la conexión RFCOMM.
classic_start = s.find('    private final BroadcastReceiver leaderDiscoveryReceiver')
connect_start = s.find('    private void connectLeaderToAuxiliary')
if classic_start >= 0 and connect_start > classic_start:
    s = s[:classic_start] + s[connect_start:]

s = s.replace('            emitDiagnostic("ENC", "SDP_MATCHED");\n', '            emitDiagnostic("ENC", "BLE_SERVICE_MATCHED");\n')

# Retira checkpoint de inquiry Classic si permanece.
checkpoint = s.find('    private synchronized void scheduleLeaderInquiryCheckpoint')
timeout = s.find('    private synchronized void scheduleLeaderTimeout', checkpoint if checkpoint >= 0 else 0)
if checkpoint >= 0 and timeout > checkpoint:
    s = s[:checkpoint] + s[timeout:]

# stopLeaderDiscovery solo detiene BLE.
a = s.find('    private synchronized void registerLeaderReceiver()')
b = s.find('    private synchronized void closeLeaderSockets()', a if a >= 0 else 0)
if a >= 0 and b > a:
    s = s[:a] + '''    private synchronized void stopLeaderDiscovery() {\n        BluetoothLeScanner scanner = leaderBleScanner;\n        ScanCallback callback = leaderBleScanCallback;\n        leaderBleScanner = null;\n        leaderBleScanCallback = null;\n        if (scanner != null && callback != null) {\n            try {\n                scanner.stopScan(callback);\n            } catch (SecurityException ignored) {\n            } catch (RuntimeException ignored) {\n            }\n        }\n    }\n\n''' + s[b:]
else:
    a = s.find('    private synchronized void stopLeaderDiscovery()')
    b = s.find('    private synchronized void closeLeaderSockets()', a if a >= 0 else 0)
    if a >= 0 and b > a:
        s = s[:a] + '''    private synchronized void stopLeaderDiscovery() {\n        BluetoothLeScanner scanner = leaderBleScanner;\n        ScanCallback callback = leaderBleScanCallback;\n        leaderBleScanner = null;\n        leaderBleScanCallback = null;\n        if (scanner != null && callback != null) {\n            try {\n                scanner.stopScan(callback);\n            } catch (SecurityException ignored) {\n            } catch (RuntimeException ignored) {\n            }\n        }\n    }\n\n''' + s[b:]

# Retira helpers SDP/Intent Classic preservando safeAddress.
a = s.find('    private static boolean deviceHasServiceUuid(')
b = s.find('    private static String safeAddress(', a if a >= 0 else 0)
if a >= 0 and b > a:
    s = s[:a] + s[b:]

for forbidden in [
    'startDiscovery()', 'fetchUuidsWithSdp()', 'ACTION_DISCOVERY_STARTED',
    'ACTION_DISCOVERY_FINISHED', 'BluetoothDevice.ACTION_FOUND', 'BluetoothDevice.ACTION_UUID',
    'SDP_REQUESTED', 'CLASSIC_DISCOVERY_START', 'CLASSIC_DISCOVERY_RETRY'
]:
    if forbidden in s:
        raise SystemExit(f'Referencia Classic remanente: {forbidden}')

for required in [
    'BluetoothLeScanner', 'setServiceUuid(SERVICE_PARCEL_UUID)',
    'scanner.startScan(Collections.singletonList(filter), settings, callback)',
    'String address = safeAddress(device)', 'connectLeaderToAuxiliary(device)',
    'createInsecureRfcommSocketToServiceRecord(SERVICE_UUID)'
]:
    if required not in s:
        raise SystemExit(f'Invariante BLE/RFCOMM ausente: {required}')

path.write_text(s)

test_path = Path('test/workerPortalAndroidRfcommResilience.test.js')
t = test_path.read_text()
needle = '  assert.match(manager, /PROOF_VERIFIED/);\n'
extra = '''  assert.match(manager, /String address = safeAddress\\(device\\)/);\n  assert.doesNotMatch(manager, /startDiscovery\\(\\)|fetchUuidsWithSdp\\(\\)/);\n  assert.doesNotMatch(manager, /ACTION_DISCOVERY_STARTED|ACTION_DISCOVERY_FINISHED|BluetoothDevice\\.ACTION_FOUND|BluetoothDevice\\.ACTION_UUID/);\n  assert.doesNotMatch(manager, /SDP_REQUESTED|CLASSIC_DISCOVERY_START|CLASSIC_DISCOVERY_RETRY/);\n'''
if extra not in t:
    if needle not in t:
        raise SystemExit('Punto de inserción del test no encontrado')
    t = t.replace(needle, needle + extra)
test_path.write_text(t)
