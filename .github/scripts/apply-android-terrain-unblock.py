from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: se esperaba 1 coincidencia y se encontraron {count}')
    return text.replace(old, new, 1)


native_path = Path('mobile/android/app/src/main/assets/native-presence.js')
native = native_path.read_text(encoding='utf-8')

old_zero_scan = """    const proofCount = proofBundle.proofs.length;
    const noAuxiliaryDetected = completion.expectedProofCount > 0 && proofCount === 0;
    if (noAuxiliaryDetected) {
      const pendingCount = completion.expectedProofCount;
      activeAttempt = null;
      pendingCompletedScan = null;
      retryNotDetectedCount = pendingCount;
      retryMarkType = completionMarkType;
      hasCompletedLeaderScan = true;
      renderPanel();
      setStatus(
        `No se detectó ningún auxiliar. La ${markInfo(completionMarkType).noun} no se guardó; vuelve a intentarlo cuando sus teléfonos estén disponibles.`,
        'error'
      );
      markRetryAvailable(completionMarkType);
      return;
    }
"""
new_zero_scan = """    const proofCount = proofBundle.proofs.length;
    const noAuxiliaryDetected = completion.expectedProofCount > 0 && proofCount === 0;
    if (noAuxiliaryDetected) {
      const pendingCount = completion.expectedProofCount;
      activeAttempt = null;
      pendingCompletedScan = null;
      retryNotDetectedCount = pendingCount;
      retryMarkType = completionMarkType;
      hasCompletedLeaderScan = true;
      bluetoothFallbackActive = true;
      recordDiagnostic('APP', 'BLUETOOTH_MANUAL_FALLBACK', {
        reason: 'scan_complete_without_auxiliaries',
        markType: completionMarkType,
        expectedProofCount: completion.expectedProofCount,
        proofCount
      });
      renderPanel();
      setStatus(
        `No se detectó ningún auxiliar por Bluetooth. Usa “Marcación Manual” para registrar la ${markInfo(completionMarkType).noun}.`,
        'warning'
      );
      markRetryAvailable(completionMarkType);
      return;
    }
"""
native = replace_once(native, old_zero_scan, new_zero_scan, 'fallback scan_complete sin auxiliares')

old_secondary_condition = """      if (
        memberMarkType === 'ARRIVAL'
        && (hasCompletedLeaderScan || normalizedMark !== 'ARRIVAL')
        && !member.isLeader
        && status === 'PENDING'
      ) {
        const button = element('button', 'native-presence-member-action', 'Reportar sin teléfono');
"""
new_secondary_condition = """      if (
        memberMarkType === 'ARRIVAL'
        && !bluetoothFallbackActive
        && (hasCompletedLeaderScan || normalizedMark !== 'ARRIVAL')
        && !member.isLeader
        && status === 'PENDING'
      ) {
        const button = element('button', 'native-presence-member-action', 'Reportar sin teléfono');
"""
native = replace_once(native, old_secondary_condition, new_secondary_condition, 'ocultar botón secundario durante fallback manual')

old_location_validation = """    if (
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || !Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > 100_000
      || !Number.isFinite(capturedAtMs) || capturedAtMs <= 0
    ) throw new Error('native_location_unavailable');
    return {
      latitude,
      longitude,
      accuracyMeters,
      clientCapturedAt: new Date(capturedAtMs).toISOString()
    };
"""
new_location_validation = """    if (
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || !Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > 100_000
      || !Number.isFinite(capturedAtMs) || capturedAtMs <= 0
    ) throw new Error('native_location_unavailable');
    if (accuracyMeters > 50) {
      recordDiagnostic('APP', 'LOCATION_LOW_ACCURACY_ACCEPTED', {
        accuracyMeters,
        latitude,
        longitude
      });
    }
    return {
      latitude,
      longitude,
      accuracyMeters,
      clientCapturedAt: new Date(capturedAtMs).toISOString()
    };
"""
native = replace_once(native, old_location_validation, new_location_validation, 'diagnóstico de precisión GPS baja')
native_path.write_text(native, encoding='utf-8')

bridge_path = Path('mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java')
bridge = bridge_path.read_text(encoding='utf-8')

bridge = replace_once(
    bridge,
    '    private static final float TARGET_LOCATION_ACCURACY_METERS = 50f;\n',
    '',
    'eliminar umbral GPS de 50 m'
)
bridge = bridge.replace('locationAccuracyAcceptable(', 'locationUsable(')

old_usable = """    private static boolean locationUsable(Location location) {
        return location != null
            && location.hasAccuracy()
            && location.getAccuracy() <= TARGET_LOCATION_ACCURACY_METERS;
    }
"""
new_usable = """    private static boolean locationUsable(Location location) {
        if (location == null || !location.hasAccuracy()) return false;
        float accuracyMeters = location.getAccuracy();
        return !Float.isNaN(accuracyMeters)
            && !Float.isInfinite(accuracyMeters)
            && accuracyMeters >= 0f;
    }
"""
bridge = replace_once(bridge, old_usable, new_usable, 'aceptar ubicación Android independientemente de precisión')
bridge_path.write_text(bridge, encoding='utf-8')

audit_path = Path('auditoria y correccion lorren.md')
audit_path.write_text(
    """# Auditoría y corrección Lórren\n\n"
    "## 2026-09-29 — APK asistencia: desbloqueos operativos en terreno\n\n"
    "### 1. Fallback manual tras SCAN_COMPLETE sin auxiliares\n"
    "- `native-presence.js` activa `bluetoothFallbackActive` cuando el escaneo termina esperando auxiliares pero no recibe ninguna prueba (`expectedProofCount > 0 && proofCount === 0`).\n"
    "- En ese estado se muestra únicamente la acción universal `Marcación Manual`; el botón secundario `Reportar sin teléfono` queda oculto durante el fallback.\n"
    "- No se modifica el protocolo Nearby/Bluetooth ni el payload de presencia.\n\n"
    "### 2. GPS impreciso no bloquea la marcación\n"
    "- `PresenceBridge.java` elimina el umbral obligatorio de 50 m y acepta cualquier ubicación Android válida, conservando el `accuracyMeters` real.\n"
    "- `native-presence.js` mantiene las validaciones de coordenadas/datos inválidos y mock location, pero una precisión superior a 50 m solo genera `LOCATION_LOW_ACCURACY_ACCEPTED`; no impide escribir la cola ni solicitar sincronización.\n"
    "- No se altera la estructura del payload enviado al servidor.\n"
    """,
    encoding='utf-8'
)
