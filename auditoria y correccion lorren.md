# Auditoría y corrección Lórren

## 2026-09-29 — APK asistencia: desbloqueos operativos en terreno

### Fallo Detectado
La aplicación se bloqueaba si el Bluetooth completaba el escaneo pero no encontraba dispositivos (0 pruebas recolectadas) o si la ubicación del dispositivo reportaba una precisión superior a 50 metros (arrojando `LOCATION_ACCURACY_INSUFFICIENT`).

### Corrección Aplicada
Se ajustó la lógica en `native-presence.js` para activar el fallback de marcación manual cuando `expectedProofCount > 0 && proofCount === 0`. Además, se modificaron los filtros de precisión de GPS en `PresenceBridge.java` (`locationUsable`) y en `native-presence.js` (`nativeLocationFromBundle`) para aceptar y registrar ubicaciones independientemente de su nivel de precisión, priorizando la fluidez operativa sobre la exactitud estricta del GPS.

### Detalle técnico
- `native-presence.js` activa `bluetoothFallbackActive` cuando `SCAN_COMPLETE` termina esperando auxiliares pero no recibe ninguna prueba.
- Durante ese fallback, cada auxiliar pendiente muestra únicamente `Marcación Manual`, que invoca `markMemberManually(member)`; `Reportar sin teléfono` permanece oculto.
- `PresenceBridge.java` ya no usa un umbral máximo de 50 m para considerar usable una ubicación; solo exige ubicación no nula, `accuracy` presente, finita y mayor o igual a cero.
- `native-presence.js` conserva el `accuracyMeters` real y, si supera 50 m, registra `LOCATION_LOW_ACCURACY_ACCEPTED` sin abortar la sincronización.
- No se modifica el protocolo Nearby/Bluetooth ni la estructura del payload enviado al servidor.
