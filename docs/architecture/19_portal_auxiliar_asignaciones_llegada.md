# Portal del Auxiliar: asignaciones y registro de llegada

## Estado

Implementación del issue #621 que continúa la arquitectura de asistencia operativa definida en #509.

La activación y la sesión segura ya existen. Esta fase convierte la portada activa en un portal móvil funcional para consultar asignaciones y registrar la llegada.

## Flujo

1. El auxiliar activa su dispositivo mediante un enlace de un solo uso.
2. La cookie segura del portal resuelve internamente `workerId` y `workerDeviceId`.
3. La portada consulta únicamente asignaciones activas de ese auxiliar.
4. Cada tarjeta muestra fecha, horario, cliente, operación, ciudad y dirección.
5. El botón de llegada solo se habilita dentro de la ventana anticipada configurada y si no existe una llegada previa.
6. El navegador solicita ubicación de alta precisión mediante una acción explícita.
7. Cuando la política del punto requiere evidencia, solicita cámara frontal y autorización expresa para usar la fotografía.
8. El servidor vuelve a comprobar sesión, propiedad de la asignación, dispositivo, ventana, geocerca e idempotencia.
9. La evidencia se guarda en R2 sin permitir sobrescribir una clave existente.
10. `registerDispatchArrival()` registra la marcación de manera transaccional y devuelve validación automática o revisión requerida.

## Seguridad

- Una asignación se carga mediante la combinación de `assignmentId` y `workerId` de la sesión.
- La autoridad transaccional recibe además `expectedWorkerId` como defensa en profundidad.
- La ventana anticipada también se comprueba dentro de la autoridad, no solo en la interfaz.
- El identificador de instalación nunca se persiste crudo; se transforma con HMAC y `ATTENDANCE_INSTALLATION_PEPPER`.
- La marcación usa una clave de idempotencia y no puede generar una segunda llegada.
- El token de activación se redacta de `req.originalUrl` antes de que Morgan escriba el log.
- No se exponen `sessionId`, `workerDeviceId`, documento o teléfono.
- La fotografía es evidencia visual; no se realiza reconocimiento facial ni se crean plantillas biométricas.

## Evidencia

Formatos admitidos:

- JPEG;
- PNG;
- WEBP.

Tamaño máximo: 3 MB.

La clave tiene la forma:

```text
attendance/<workerId>/<assignmentId>/arrival/<idempotencyKey>.<ext>
```

La subida usa `If-None-Match: *` para impedir que un reintento cambie una fotografía ya asociada a la misma clave.

## Estados visibles

- `AUTO_VALIDATED` y `ON_TIME`: llegada validada a tiempo.
- `AUTO_VALIDATED` y `LATE`: llegada validada como tarde.
- `REVIEW_REQUIRED`: llegada registrada y enviada a revisión.
- Ventana no abierta, asistencia deshabilitada o duplicado: no se crea una nueva marcación.

## Alcance preservado

Esta entrega no implementa:

- marcación de salida;
- seguimiento continuo de ubicación;
- reconocimiento facial;
- liquidación de jornada o nómina;
- panel administrativo de revisión;
- funcionamiento offline confirmado;
- instalación PWA.

`DispatchAssignment.status` continúa representando únicamente el ciclo de asignación y no se modifica con la asistencia.

## Variables

Se reutilizan:

- `ATTENDANCE_INSTALLATION_PEPPER`;
- `R2_ENDPOINT`;
- `R2_ACCESS_KEY_ID`;
- `R2_SECRET_ACCESS_KEY`;
- `R2_BUCKET`.

## Rollback

Retirar la ruta pública de llegada, el cargador de asignaciones, la vista móvil y el almacenamiento de evidencia. Los modelos y las autoridades de asistencia permanecen aditivos y pueden conservarse sin consumidores públicos.
