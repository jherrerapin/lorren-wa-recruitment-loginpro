# Auditoría y corrección Lórren

## 2026-09-29 — APK asistencia: desbloqueos operativos en terreno

### Fallo Detectado
Bloqueo operativo en terreno por dos motivos: el escaneo Bluetooth concluía sin encontrar auxiliares (0 pruebas) dejando la interfaz sin opciones de contingencia, y la validación estricta del GPS bloqueaba la sincronización al superar los 50 metros de precisión (`LOCATION_ACCURACY_INSUFFICIENT`).

### Corrección Aplicada
Se implementó la bandera `bluetoothFallbackActive` en `native-presence.js` para forzar la UI a mostrar la "Marcación Manual" ante un escaneo vacío. Se relajaron las validaciones de geolocalización en `PresenceBridge.java` (`locationUsable`) y en el JS (`nativeLocationFromBundle`) para aceptar y propagar cualquier coordenada válida sin importar su margen de error, sustituyendo el bloqueo por un registro de advertencia en el diagnóstico.

### Detalle técnico
- `native-presence.js` activa `bluetoothFallbackActive` cuando `SCAN_COMPLETE` termina esperando auxiliares pero no recibe ninguna prueba (`expectedProofCount > 0 && proofCount === 0`).
- Durante ese fallback, cada auxiliar pendiente muestra únicamente `Marcación Manual`, que invoca `markMemberManually(member)`; `Reportar sin teléfono` permanece oculto.
- `PresenceBridge.java` ya no usa un umbral máximo de 50 m para considerar usable una ubicación; solo exige ubicación no nula, `accuracy` presente, finita y mayor o igual a cero.
- `native-presence.js` conserva el `accuracyMeters` real y, si supera 50 m, registra `LOCATION_LOW_ACCURACY_ACCEPTED` sin abortar la sincronización.
- No se modifica el protocolo Nearby/Bluetooth ni la estructura del payload enviado al servidor.
