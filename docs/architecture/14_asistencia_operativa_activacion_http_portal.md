# Asistencia operativa: activación HTTP del Portal del Auxiliar

## Estado

Implementación relacionada con #509 y #587. Continúa la política de sesión de #582 y la persistencia integrada en #586.

Esta fase conecta la activación y resolución de sesión a HTTP. Las entregas posteriores añadieron asignaciones, asistencia y PWA sobre la misma sesión; la continuidad de esa sesión se consolida en #1461 sin crear una autoridad de autenticación paralela.

## Problema

Un enlace de activación de un solo uso no debe consumirse mediante una petición `GET`.

Aplicaciones de mensajería, filtros corporativos, antivirus y generadores de previsualizaciones pueden abrir una URL antes que la persona. Si `GET` consumiera la activación, el auxiliar recibiría después un enlace ya utilizado.

También sería inseguro conservar el token en:

- parámetros de consulta después de consumirlo;
- rutas del servidor;
- HTML renderizado;
- almacenamiento local del navegador;
- logs de acceso;
- redirecciones;
- mensajes de error.

## Formato del enlace

El flujo vigente acepta la activación en la URL pública y la elimina del historial antes de continuar. La página pública ejecuta esta secuencia:

1. obtiene el token de activación entregado al navegador;
2. ejecuta `history.replaceState()` para limpiar la URL visible;
3. valida localmente su formato;
4. lo envía una sola vez mediante `POST /operaciones/portal/activar`;
5. recibe una URL limpia;
6. navega a `/operaciones/portal`.

El `GET /operaciones/portal/activar` solo entrega la página y nunca llama la autoridad de activación.

## Router

`workerPortalRouter(prisma)` se monta en:

```text
/operaciones/portal
```

La frontera de activación conserva:

```text
GET  /operaciones/portal/activar
POST /operaciones/portal/activar
GET  /operaciones/portal
```

No se crea una segunda sesión, un refresh token independiente ni un endpoint paralelo de autenticación.

## Instalación

El navegador conserva una cookie independiente:

```text
Nombre: __Secure-lorren-installation
Valor: UUID v4
HttpOnly: true
Secure: true
SameSite: Strict
Path: /
Domain: ausente
Horizonte persistente: 365 días
```

El UUID no se guarda directamente en la base de datos. La autoridad de activación calcula un HMAC-SHA-256 usando `ATTENDANCE_INSTALLATION_PEPPER`, y el adaptador Prisma solo recibe ese HMAC.

Durante una activación, si la cookie falta o contiene un valor inválido, el servidor genera un UUID v4 nuevo. Durante una resolución normal del PWA esto **no** ocurre: si la instalación existente es válida se renueva la misma cookie; si falta o es inválida, la portada no inventa silenciosamente otra identidad de dispositivo.

## Sesión

Después de validar la activación, la autoridad devuelve un token de sesión generado con CSPRNG. La ruta lo coloca en:

```text
Nombre: __Secure-lorren-attendance
HttpOnly: true
Secure: true
SameSite: Lax
Path: /
Domain: ausente
```

La base de datos conserva únicamente SHA-256 del token. El token crudo no se incluye en respuestas JSON, logs o redirecciones y no se copia a `localStorage`, `sessionStorage` o IndexedDB.

### Continuidad del PWA

Históricamente `expiresAt` funcionaba como un vencimiento absoluto de la sesión —siete días por defecto— aunque el auxiliar siguiera contratado y su dispositivo continuara autorizado. Esto podía sacar al usuario del PWA sin que hubiera existido una baja operativa.

Desde #1461, la resolución de una sesión activa se apoya en las autoridades que realmente representan acceso vigente:

- hash exacto de la sesión;
- `DispatchWorkerPortalSession.status = ACTIVE`;
- sesión sin revocación;
- auxiliar con estado operativo permitido (`ACTIVE` o `CONTRATADO`);
- dispositivo `PRIMARY / ACTIVE`;
- dispositivo sin revocación;
- autorización del dispositivo aún válida.

`expiresAt` se conserva por compatibilidad de esquema, auditoría y consumidores existentes, pero un valor histórico ya vencido no invalida por sí solo una sesión que todavía cumple todas las condiciones anteriores. Una resolución válida actualiza `lastSeenAt` y renueva `expiresAt` a un horizonte de continuidad de 365 días.

Al abrir correctamente `GET /operaciones/portal`, el servidor vuelve a emitir **el mismo token de sesión** como cookie HttpOnly/Secure con 365 días desde esa apertura. Si la cookie de instalación válida está presente, también renueva la misma instalación. Esto permite migrar sesiones ya emitidas antes del cambio siempre que el navegador todavía entregue su cookie antigua.

No tener turnos asignados o no abrir el PWA durante un periodo corto no cambia `operationalStatus` ni revoca sesión o dispositivo. No existe un job de desactivación basado en `lastSeenAt` o ausencia de asignaciones.

### Límite del navegador

La aplicación no puede prometer persistencia literalmente infinita de una cookie: el navegador puede borrar datos del sitio, el usuario puede eliminarlos y los navegadores pueden imponer límites a cookies persistentes. Por eso se usa un horizonte largo renovable, no un token permanente expuesto al cliente.

Si el navegador ya eliminó una cookie antigua antes de desplegar esta corrección, el servidor no puede reconstruir el token crudo a partir del hash guardado —deliberadamente— y esa instalación necesita una nueva activación. No se debilita este límite recuperando sesión solo con el identificador de instalación.

## Variables

La ruta necesita:

```text
ATTENDANCE_INSTALLATION_PEPPER
```

Debe ser un secreto de al menos 32 caracteres y diferente de `SESSION_SECRET`.

Opcionalmente puede configurarse:

```text
ATTENDANCE_PORTAL_SESSION_TTL_MINUTES
```

Ese valor conserva su función de horizonte inicial al crear la sesión y valida los límites históricos entre 15 minutos y 30 días. Ya no funciona como una regla autónoma de desactivación para una sesión que posteriormente sigue activa, no revocada y vinculada a un auxiliar/dispositivo autorizados; la resolución válida aplica el horizonte de continuidad renovable.

No se agregan variables automáticamente en Railway durante este cambio.

## Cabeceras

Todas las respuestas del portal aplican:

```text
Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate
Pragma: no-cache
Expires: 0
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

La página usa una política CSP con nonce y no convierte las credenciales de sesión en datos accesibles para JavaScript.

## Errores

Token de activación inválido, vencido, consumido o revocado produce la misma respuesta pública:

```json
{
  "ok": false,
  "error": "activation_invalid_or_expired"
}
```

La aplicación no confirma si un token concreto existió.

Errores de configuración, como ausencia del pepper, devuelven:

```json
{
  "ok": false,
  "error": "portal_temporarily_unavailable"
}
```

Los logs conservan únicamente un código técnico. Nunca registran token de activación, token de sesión o UUID de instalación.

## Portada del PWA

`GET /operaciones/portal` busca la cookie de sesión y ejecuta `resolveWorkerPortalSession()`.

Una sesión se muestra como activa únicamente cuando el adaptador confirma que:

- la sesión está activa y no revocada;
- el auxiliar sigue habilitado;
- el dispositivo principal sigue autorizado;
- las relaciones continúan siendo coherentes.

Una lista vacía de asignaciones no vuelve inactiva la sesión: el auxiliar puede abrir el PWA y ver que no tiene turnos activos.

La vista no recibe ni presenta `workerId`, `deviceId` o `sessionId`.

Si la sesión falta o fue revocada —incluyendo baja del auxiliar o revocación/reemplazo del dispositivo principal— se limpia la cookie del navegador y se muestra un estado genérico de activación requerida.

## Seguridad de cookies

Se mantiene el intercambio de identificadores de sesión mediante cookies `Secure` y `HttpOnly`, evitando parámetros URL persistentes y almacenamiento JavaScript. La continuidad no introduce un segundo secreto: reemite el mismo token cuya validez continúa controlada server-side por sesión, auxiliar y dispositivo.

Una nueva activación conserva la revocación transaccional de sesiones anteriores y del dispositivo principal anterior. Por tanto, ampliar la persistencia del navegador no impide invalidar inmediatamente una sesión desde el servidor.

## Fuera de alcance de #1461

- APK/Android nativo, Nearby, Bluetooth o RFCOMM;
- cambios de geocerca, biometría o writers de asistencia;
- nuevos refresh tokens o tokens visibles a JavaScript;
- Prisma o migraciones;
- jobs;
- `src/routes/webhook.js`;
- cambios automáticos en Railway o despliegue manual.

## Pruebas

La regresión de continuidad debe cubrir al menos:

- una sesión con `expiresAt` histórico ya pasado que sigue activa y vinculada a auxiliar/dispositivo válidos;
- renovación de `lastSeenAt` y del horizonte persistido;
- conservación de filtros `ACTIVE`, no revocado, worker habilitado y dispositivo `PRIMARY / ACTIVE`;
- renovación de la misma cookie de sesión en la portada;
- renovación de la misma instalación cuando existe;
- ausencia de creación silenciosa de una instalación durante resolución normal;
- sesión inválida/revocada continúa devolviendo acceso inactivo.

## Rollback

Revertir el PR de #1461. No hay migraciones ni transformación de datos. Las columnas, hashes de sesión, relaciones con dispositivo y mecanismos de revocación permanecen intactos.
