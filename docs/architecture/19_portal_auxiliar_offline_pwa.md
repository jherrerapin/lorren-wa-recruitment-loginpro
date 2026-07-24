# Portal del Auxiliar offline — fase PWA

## Objetivo

Permitir que un auxiliar registre su llegada cuando pierde la conexión después de haber abierto previamente el Portal del Auxiliar con internet. La marcación se conserva en el dispositivo y se sincroniza con Lórren cuando vuelve la conectividad.

Esta fase reduce la brecha funcional frente a plataformas de asistencia que permiten marcaciones offline. No se presenta como equivalente a una aplicación Android nativa con reloj monotónico, Android Keystore y WorkManager.

## Flujo

1. El auxiliar activa el dispositivo y abre `/operaciones/portal` con internet.
2. El Service Worker guarda únicamente la última página autenticada cuyo encabezado sea `X-Lorren-Worker-Portal-Mode: active`.
3. Los recursos estáticos de la PWA se conservan en Cache Storage.
4. Cuando no hay conexión, el portal abre la última programación guardada.
5. El auxiliar obtiene GPS y toma la selfie de evidencia.
6. La llegada se almacena en IndexedDB con:
   - asignación;
   - idempotency key;
   - fecha y hora capturada;
   - latitud, longitud y precisión;
   - consentimiento;
   - selfie como Blob;
   - estado de persistencia local.
7. La interfaz confirma `Llegada guardada offline` y bloquea una segunda marca local para la misma asignación.
8. Al recuperar conexión, el Service Worker reconstruye el `multipart/form-data` y lo envía con las cookies del portal.
9. El registro local se elimina de la cola únicamente cuando el servidor confirma el resultado. Se conserva un recibo local de sincronización.

## Sincronización

La estrategia usa dos mecanismos:

- Background Sync cuando el navegador lo soporta;
- mensaje directo al Service Worker al abrir el portal o recuperar conexión, como respaldo.

Los errores de red y respuestas 5xx mantienen la marca en la cola. Una sesión vencida cambia la marca a `SESSION_REQUIRED` sin eliminarla. El auxiliar debe reactivar el portal y la sincronización vuelve a intentarse.

## Autoridad del servidor

El navegador no decide si la asistencia es válida. El servidor conserva la autoridad sobre:

- propiedad de la asignación;
- estado activo;
- punto habilitado;
- ventana de llegada;
- geocerca;
- precisión;
- dispositivo autorizado;
- evidencia;
- idempotencia;
- clasificación final.

Para una captura `OFFLINE_WEB`, la ventana y la puntualidad se calculan con `clientCapturedAt`, mientras que `serverReceivedAt` conserva la hora real de sincronización.

## Política de riesgo

Toda captura web offline queda en `REVIEW_REQUIRED`, incluso si GPS, geocerca y fotografía son correctos. Se agregan las señales:

- `OFFLINE_WEB_CAPTURE`;
- `CLIENT_CLOCK_UNTRUSTED`;
- `DELAYED_SYNC` cuando transcurren al menos cinco minutos.

La razón es que el reloj de JavaScript puede ser modificado por el usuario y no está respaldado por hardware. La fotografía reduce parcialmente el puntaje de riesgo, pero no elimina esas señales.

## Límites

- La página debe abrirse por lo menos una vez con conexión para guardar la programación.
- La sesión y el dispositivo deben seguir vigentes al sincronizar.
- Una captura offline puede permanecer en cola hasta 72 horas.
- GPS y cámara dependen de los permisos y capacidades del equipo.
- La persistencia solicitada al navegador no garantiza que el sistema operativo nunca elimine los datos.
- Sin conexión, el panel administrativo no recibe información en tiempo real.
- El navegador no ofrece las mismas garantías antifraude que Android Keystore o un reloj monotónico nativo.

## Seguridad y privacidad

- No se guarda el token de activación.
- La cola queda aislada al origen HTTPS del Portal del Auxiliar.
- Las selfies se limitan a JPG, PNG o WEBP y 3 MB.
- Cada envío usa una idempotency key estable.
- Una marca no se elimina antes de la confirmación del servidor.
- Una página inactiva elimina la copia autenticada del caché.
- El Service Worker solo controla `/operaciones/portal`.

## Prueba manual mínima

1. Abrir el portal con una sesión activa y una asignación dentro de la ventana.
2. Esperar a que aparezca `Con conexión`.
3. Activar modo avión.
4. Recargar `/operaciones/portal` y confirmar que la asignación continúa visible.
5. Registrar GPS, selfie y consentimiento.
6. Confirmar `Llegada guardada en este celular`.
7. Cerrar y volver a abrir el navegador sin conexión.
8. Confirmar que la marca continúa pendiente y no permite duplicarla.
9. Recuperar internet.
10. Confirmar el estado `Sincronizando` y después `Llegada sincronizada · en revisión`.
11. Revisar en `Operaciones / Despacho → Asistencia` las señales de captura offline y sincronización tardía.

## Próxima fase contractual

La siguiente fase para acercarse a una garantía comparable o superior a soluciones nativas es una aplicación Android que reutilice el mismo backend y agregue:

- WorkManager para trabajo persistente con conectividad;
- base local cifrada;
- reloj monotónico;
- claves no exportables en Android Keystore;
- firma de cada marca;
- detección de reinicio y cambio de hora;
- comprobación de integridad de la aplicación;
- modo coordinador/cuadrilla offline.
