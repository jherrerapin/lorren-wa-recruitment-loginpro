from pathlib import Path

path = Path('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
s = path.read_text()

# Imports exclusivos del discovery Classic/SDP.
for line in [
    'import android.content.BroadcastReceiver;\n',
    'import android.content.Intent;\n',
    'import android.content.IntentFilter;\n',
    'import android.os.Parcelable;\n',
]:
    s = s.replace(line, '')

# Constantes exclusivas del discovery Classic.
for line in [
    '    private static final long INQUIRY_CHECKPOINT_MS = 15_000L;\n',
    '    private static final long DISCOVERY_RESTART_DELAY_MS = 1_500L;\n',
    '    private static final int MAX_DISCOVERY_BURSTS = 3;\n',
    '    private static final int MAX_DISCOVERED_DEVICES = 24;\n',
]:
    s = s.replace(line, '')

s = s.replace(
    '    // Bluetooth Classic inquiry suele consumir ~12 s. La ventana nativa deja\n'
    '    // margen real para inquiry + SDP + RFCOMM y termina antes si llegan las proofs.\n',
    '    // BLE descubre auxiliares de forma inmediata por UUID; la ventana termina antes\n'
    '    // si llegan todas las proofs y RFCOMM conserva el intercambio challenge/proof.\n'
)

# Estado exclusivo de discovery Classic/SDP.
for line in [
    '    private final Map<String, BluetoothDevice> discoveredDevices = new LinkedHashMap<>();\n',
    '    private final Set<String> sdpRequestedAddresses = new LinkedHashSet<>();\n',
    '    private boolean leaderReceiverRegistered = false;\n',
    '    private Runnable leaderInquiryCheckpoint;\n',
    '    private Runnable leaderDiscoveryRestart;\n',
    '    private int leaderDiscoveryBurst = 0;\n',
]:
    s = s.replace(line, '')

for line in [
    '        leaderDiscoveryBurst = 0;\n',
    '        discoveredDevices.clear();\n',
    '        sdpRequestedAddresses.clear();\n',
]:
    s = s.replace(line, '')

# Callback BLE: valida MAC antes de conectar inmediatamente por RFCOMM.
old = '''                public void onScanResult(int callbackType, ScanResult result) {
                    BluetoothDevice device = result == null ? null : result.getDevice();
                    synchronized (NearbyPresenceManager.this) {
                        if (role != Role.LEADER || leaderBleScanCallback != this) return;
                        emitDiagnostic("ENC", "BLE_SERVICE_FOUND");
                    }
                    if (device != null) connectLeaderToAuxiliary(device);
                }
'''
new = '''                public void onScanResult(int callbackType, ScanResult result) {
                    BluetoothDevice device = result == null ? null : result.getDevice();
                    if (device == null) return;
                    String address = safeAddress(device);
                    if (address.isEmpty()) return;
                    synchronized (NearbyPresenceManager.this) {
                        if (role != Role.LEADER || leaderBleScanCallback != this) return;
                        emitDiagnostic("ENC", "BLE_SERVICE_FOUND");
                    }
                    connectLeaderToAuxiliary(device);
                }
'''
if old not in s:
    raise SystemExit('BLE callback esperado no encontrado')
s = s.replace(old, new)

# Elimina todo el pipeline Classic: BroadcastReceiver, startDiscovery, reintentos y SDP.
start = s.index('    private final BroadcastReceiver leaderDiscoveryReceiver')
end = s.index('    private void connectLeaderToAuxiliary', start)
s = s[:start] + s[end:]

s = s.replace('            emitDiagnostic("ENC", "SDP_MATCHED");\n', '            emitDiagnostic("ENC", "BLE_SERVICE_MATCHED");\n')

# Elimina checkpoint Classic/SDP restante.
start_marker = '    private synchronized void scheduleLeaderInquiryCheckpoint'
if start_marker in s:
    start = s.index(start_marker)
    end = s.index('    private synchronized void scheduleLeaderTimeout', start)
    s = s[:start] + s[end:]

# stopLeaderDiscovery queda exclusivamente en BLE.
start = s.index('    private synchronized void stopLeaderDiscovery()')
end = s.index('    private synchronized void closeLeaderSockets()', start)
replacement = '''    private synchronized void stopLeaderDiscovery() {
        BluetoothLeScanner scanner = leaderBleScanner;
        ScanCallback callback = leaderBleScanCallback;
        leaderBleScanner = null;
        leaderBleScanCallback = null;
        if (scanner != null && callback != null) {
            try {
                scanner.stopScan(callback);
            } catch (SecurityException ignored) {
            } catch (RuntimeException ignored) {
            }
        }
    }

'''
s = s[:start] + replacement + s[end:]

# Limpieza de timeouts Classic que ya no existen.
s = s.replace('        cancelLeaderDiscoveryRestart();\n', '')
s = s.replace('        cancelLeaderInquiryCheckpoint();\n', '')

# Helpers exclusivos de SDP/Classic, si siguen presentes.
for marker, next_marker in [
    ('    private static boolean deviceHasServiceUuid(', '    private static String safeAddress('),
    ('    private static boolean intentContainsServiceUuid(', '    private static BluetoothDevice parcelableDevice('),
    ('    private static BluetoothDevice parcelableDevice(', '    private static String canonicalProof('),
]:
    if marker in s and next_marker in s:
        a = s.index(marker)
        b = s.index(next_marker, a)
        s = s[:a] + s[b:]

# Invariantes del cambio solicitado.
for forbidden in ['startDiscovery()', 'fetchUuidsWithSdp()', 'ACTION_DISCOVERY_STARTED', 'ACTION_DISCOVERY_FINISHED', 'BluetoothDevice.ACTION_FOUND', 'BluetoothDevice.ACTION_UUID']:
    if forbidden in s:
        raise SystemExit(f'Referencia Classic remanente: {forbidden}')
for required in ['BluetoothLeScanner', 'setServiceUuid(SERVICE_PARCEL_UUID)', 'scanner.startScan(Collections.singletonList(filter), settings, callback)', 'connectLeaderToAuxiliary(device)', 'createInsecureRfcommSocketToServiceRecord(SERVICE_UUID)']:
    if required not in s:
        raise SystemExit(f'Invariante BLE/RFCOMM ausente: {required}')

path.write_text(s)

# Endurece la regresión para prohibir el pipeline Classic/SDP.
test_path = Path('test/workerPortalAndroidRfcommResilience.test.js')
t = test_path.read_text()
needle = '  assert.match(manager, /PROOF_VERIFIED/);\n'
extra = '''  assert.match(manager, /String address = safeAddress\\(device\\)/);
  assert.doesNotMatch(manager, /startDiscovery\\(\\)|fetchUuidsWithSdp\\(\\)/);
  assert.doesNotMatch(manager, /ACTION_DISCOVERY_STARTED|ACTION_DISCOVERY_FINISHED|BluetoothDevice\\.ACTION_FOUND|BluetoothDevice\\.ACTION_UUID/);
  assert.doesNotMatch(manager, /SDP_REQUESTED|CLASSIC_DISCOVERY_START|CLASSIC_DISCOVERY_RETRY/);
'''
if extra not in t:
    if needle not in t:
        raise SystemExit('Punto de inserción del test no encontrado')
    t = t.replace(needle, needle + extra)
test_path.write_text(t)
