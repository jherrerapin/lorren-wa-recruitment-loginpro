# Auditoría y corrección Lórren

## 2026-09-29 — APK asistencia: desbloqueos operativos en terreno

### 1. Fallback manual tras SCAN_COMPLETE sin auxiliares
- `native-presence.js` activa `bluetoothFallbackActive` cuando el escaneo termina esperando auxiliares pero no recibe ninguna prueba (`expectedProofCount > 0 && proofCount === 0`).
- En ese estado se muestra únicamente la acción universal `Marcación Manual`; el botón secundario `Reportar sin teléfono` queda oculto durante el fallback.
- No se modifica el protocolo Nearby/Bluetooth ni el payload de presencia.

### 2. GPS impreciso no bloquea la marcación
- `PresenceBridge.java` elimina el umbral obligatorio de 50 m y acepta cualquier ubicación Android válida, conservando el `accuracyMeters` real.
- `native-presence.js` mantiene las validaciones de coordenadas/datos inválidos y mock location, pero una precisión superior a 50 m solo genera `LOCATION_LOW_ACCURACY_ACCEPTED`; no impide escribir la cola ni solicitar sincronización.
- No se altera la estructura del payload enviado al servidor.
