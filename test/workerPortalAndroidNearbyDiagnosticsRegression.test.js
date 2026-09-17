import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const managerPath = new URL(
  '../mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java',
  import.meta.url
);
const nativePresencePath = new URL(
  '../mobile/android/app/src/main/assets/native-presence.js',
  import.meta.url
);

async function read(url) {
  return readFile(url, 'utf8');
}

test('Nearby conserva el status nativo en diagnóstico local sin cambiar el error público', async () => {
  const [manager, nativePresence] = await Promise.all([
    read(managerPath),
    read(nativePresencePath)
  ]);

  assert.match(manager, /import com\.google\.android\.gms\.common\.api\.ApiException;/);
  assert.match(
    manager,
    /private static Integer statusCode\(Exception error\)[\s\S]{0,220}error instanceof ApiException[\s\S]{0,120}getStatusCode\(\)/
  );

  assert.match(
    manager,
    /startAdvertising\([\s\S]{0,700}addOnFailureListener\(error -> \{[\s\S]{0,180}emitDiagnostic\("AUX", "ADVERTISING_FAILED", error\);[\s\S]{0,120}failReady\("advertising_failed"\)/
  );
  assert.match(
    manager,
    /startDiscovery\([\s\S]{0,900}addOnFailureListener\(error -> \{[\s\S]{0,180}emitDiagnostic\("ENC", "DISCOVERY_FAILED", error\);[\s\S]{0,120}failLeaderStart\("discovery_failed"\)/
  );
  assert.match(
    manager,
    /CONNECTION_FAILED[\s\S]{0,180}result\.getStatus\(\)\.getStatusCode\(\)/
  );
  assert.match(
    manager,
    /CONNECTION_REQUEST_FAILED", error/
  );

  assert.match(
    manager,
    /private void emitDiagnostic\(String actor, String stage, Integer statusCode\)[\s\S]{0,260}if \(statusCode != null\) event\.put\("statusCode", statusCode\)/
  );
  assert.doesNotMatch(manager, /event\.put\("(?:message|exception|stackTrace)"/);
  assert.doesNotMatch(manager, /error\.getMessage\(\)|printStackTrace\(/);

  assert.match(
    nativePresence,
    /if \(Number\.isFinite\(item\.statusCode\)\) metadata\.push\(`status=\$\{item\.statusCode\}`\)/
  );
  assert.match(
    nativePresence,
    /discovery_failed:\s*'No fue posible iniciar la escucha Bluetooth para la marcación\. Intenta nuevamente\.'/
  );
});
