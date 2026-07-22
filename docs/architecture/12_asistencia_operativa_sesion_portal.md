# Asistencia operativa: sesión segura del Portal del Auxiliar

## Estado

Implementación relacionada con #509 y #581. Esta fase define la política y el contrato de aplicación de la sesión del Portal del Auxiliar sin crear persistencia, rutas HTTP, cookies reales, WhatsApp o PWA.

## Problema

Los PR #534 y #538 permiten emitir una activación de un solo uso y autorizar atómicamente el dispositivo principal. Todavía no existe una sesión web propia del auxiliar.

Una implementación directa podría dejar un estado incompleto:

1. consumir el token de activación;
2. autorizar el dispositivo;
3. fallar al crear o guardar la sesión;
4. impedir que el auxiliar reutilice la activación ya consumida.

También sería incorrecto mantener el token de activación en la URL, almacenar una credencial en `localStorage` o reutilizar la sesión administrativa de reclutadores y DEV.

## Autoridad

`activateWorkerPortalSession()` prepara todos los secretos derivados y exige una sola operación de repositorio:

```text
claimActivationAuthorizeDeviceAndCreateSession(input)
```

El adaptador Prisma futuro deberá ejecutar dentro de una única transacción:

1. localizar y reclamar la activación pendiente;
2. comprobar propósito, vencimiento y consumo único;
3. revalidar que el auxiliar siga activo;
4. revocar el dispositivo principal anterior cuando corresponda;
5. autorizar la instalación actual como dispositivo principal;
6. revocar o reemplazar sesiones activas incompatibles;
7. crear la nueva sesión con el hash recibido;
8. devolver trabajador, dispositivo, sesión y vencimiento.

No se debe implementar esta secuencia como llamadas independientes.

## Token de sesión

La política usa:

- 32 bytes aleatorios mediante CSPRNG;
- codificación Base64URL sin padding;
- SHA-256 para persistencia;
- TTL predeterminado de 7 días;
- TTL mínimo de 15 minutos;
- TTL máximo de 30 días.

El token crudo se devuelve una sola vez a la futura ruta HTTP para colocarlo en una cookie. Nunca se entrega al repositorio ni debe registrarse en logs.

## Datos derivados

El contrato transaccional recibe exclusivamente:

- `activationTokenHash`: SHA-256 del token de activación;
- `installationIdHash`: HMAC-SHA-256 del identificador de instalación;
- `sessionTokenHash`: SHA-256 del token de sesión;
- vencimiento y metadatos técnicos limitados.

No recibe:

- token de activación crudo;
- token de sesión crudo;
- identificador de instalación crudo;
- documento, teléfono o nombre del auxiliar.

## Cookie futura

La política define:

```text
Nombre: __Secure-lorren-attendance
HttpOnly: true
Secure: true
SameSite: strict
Path: /operaciones/portal
Domain: ausente
```

La cookie no se crea todavía. La futura ruta deberá añadir `Cache-Control: no-store`, eliminar el token de activación de la URL mediante redirección y no reflejar secretos en HTML, errores o métricas.

Se usa el prefijo `__Secure-` y no `__Host-` porque la cookie se restringe a `/operaciones/portal`; `__Host-` exige `Path=/`.

## Resolución de sesión

`resolveWorkerPortalSession()`:

1. valida el formato del token recibido;
2. calcula su SHA-256;
3. consulta `resolveActiveSession()`;
4. devuelve solamente identificadores internos y vencimiento;
5. trata sesión ausente o vencida como usuario no autenticado.

El adaptador futuro deberá comprobar también:

- sesión no revocada;
- auxiliar activo;
- dispositivo activo y autorizado;
- correspondencia entre auxiliar, dispositivo y sesión;
- vencimiento vigente;
- actualización controlada de `lastSeenAt`.

## Fuera de alcance

- modelos Prisma y migración de sesión;
- endpoint para emitir activaciones;
- endpoint público para consumirlas;
- cookie real;
- envío del enlace por WhatsApp;
- listado móvil de asignaciones;
- GPS, fotografía, llegada, salida o R2;
- cambios en `DispatchAssignment.status`;
- cambios en Operaciones / Despacho existente.

## Próximo paso

Crear `DispatchWorkerPortalSession`, su migración expansiva y un adaptador Prisma que implemente de forma atómica `claimActivationAuthorizeDeviceAndCreateSession()` y `resolveActiveSession()`. Esa entrega seguirá sin rutas públicas; las rutas se montarán después de validar la persistencia y la concurrencia.

## Referencias

- OWASP Session Management Cheat Sheet.
- OWASP Forgot Password Cheat Sheet.
- Node.js Crypto.

## Rollback

Revertir los cuatro archivos nuevos de #581. No existen consumidores, migraciones ni datos que retirar.
