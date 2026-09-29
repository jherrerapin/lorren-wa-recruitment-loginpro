from pathlib import Path
p = Path('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
text = p.read_text()
old = '''    private boolean supportsBleAdvertising() {
        if (bluetoothAdapter == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return false;
        if (!appContext.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return false;
        try {
            ensureNearbyTransportPermissions();
            return bluetoothAdapter.isMultipleAdvertisementSupported();
        } catch (SecurityException error) {
            throw error;
        } catch (RuntimeException error) {
            return false;
        }
    }
'''
new = '''    private boolean supportsBleAdvertising() {
        if (bluetoothAdapter == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return false;
        if (!appContext.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return false;
        try {
            ensureNearbyTransportPermissions();
            return bluetoothAdapter.getBluetoothLeAdvertiser() != null;
        } catch (SecurityException error) {
            throw error;
        } catch (RuntimeException error) {
            return false;
        }
    }
'''
if old not in text:
    raise SystemExit('supportsBleAdvertising block not found')
p.write_text(text.replace(old, new, 1))
