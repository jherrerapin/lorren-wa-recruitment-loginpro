# Asistencia operativa: activación HTTP del Portal del Auxiliar

## Estado

Implementación relacionada con #509 y #587. Continúa la política de sesión de #582 y la persistencia integrada en #586.

Esta fase conecta la activación y resolución de sesión a HTTP. Todavía no muestra asignaciones, no captura ubicación o fotografía y no registra llegada o salida.

La continuidad de la sesión PWA se consolida posteriormente en #1461 sobre la misma sesión y el mismo dispositivo autorizado, sin crear una autoridad de autenticación paralela.

## Problema

Un enlace de activación de un solo uso no debe consumirse mediante una petición `GET`.

Aplicaciones de mensajería, filtros corporativos, antivirus y generadores de previsualizaciones pueden abrir una URL antes que la persona. Si `GET` consumiera la activación, el auxiliar recibiría después un enlace ya utilizado.

También sería inseguro conservar el token en:

- parámetros de consulta;
- rutas del servidor;
- HTML renderizado;
- almacenamiento local del navegador;
- logs de acceso;
- redirecciones;
- mensajes de error.

## Formato del enlace

El formato previsto para la futura emisión administrativa es:

```text
https://<host>/operaciones/portal/activar#token=<token>
```

El fragmento, todo lo que aparece después de `#`, no forma parte de la petición HTTP enviada al servidor.

La página pública ejecuta esta secuencia:

1. lee el fragmento en el navegador;
2. extrae el token;
3. ejecuta `history.replaceState()` para eliminarlo del historial visible;
4. valida localmente su formato;
5. lo envía una sola vez mediante `POST /operaciones/portal/activar`;
6. recibe una URL limpia;
7. navega a `/operaciones/portal`.

El `GET /operaciones/portal/activar` solo entrega la página y nunca llama la autoridad de activación.

## Router

`workerPortalRouter(prisma)` se monta en:

```text
/operaciones/portal
```

Expone inicialmente:

```text
GET  /operaciones/portal/activar
POST /operaciones/portal/activar
GET  /operaciones/portal
```

No existe una ruta `GET /activar/:token` ni una variante con `?token=`.

## Instalación

El navegador recibe una cookie independiente:

```text
Nombre: __Secure-lorren-installation
Valor: UUID v4
HttpOnly: true
Secure: true
SameSite: Strict
Path: /
Domain: ausente
Duración: 365 días
```

El UUID no se guarda directamente en la base de datos. La autoridad de #582 calcula un HMAC-SHA-256 usando `ATTENDANCE_INSTALLATION_PEPPER`, y el adaptador Prisma solo recibe ese HMAC.

Durante una activación, si la cookie falta o contiene un valor inválido, el servidor genera un UUID v4 nuevo y reemplaza el valor. Durante una resolución normal de una sesión ya válida no se inventa otra instalación: si la cookie válida existe, #1461 renueva **ese mismo UUID**; si falta o es inválida, se requiere el flujo de activación correspondiente.

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

La base de datos conserva únicamente SHA-256 del token. El token crudo no se incluye en respuestas JSON, logs o redirecciones.

### Continuidad del PWA

Antes de #1461, `expiresAt` funcionaba como un vencimiento absoluto de autenticación —siete días por defecto— aunque el auxiliar siguiera habilitado y su dispositivo principal continuara autorizado.

Después de #1461, la resolución válida continúa dependiendo de las autoridades existentes:

- hash exacto de la sesión;
- `DispatchWorkerPortalSession.status = ACTIVE`;
- sesión sin revocación;
- auxiliar `ACTIVE` o `CONTRATADO`;
- dispositivo `PRIMARY / ACTIVE`;
- dispositivo sin revocación y con autorización vigente.

`expiresAt` se conserva por compatibilidad de esquema y auditoría, pero un valor histórico vencido no invalida por sí solo una sesión que todavía cumple esas condiciones. La resolución actualiza `lastSeenAt` y renueva `expiresAt` a un horizonte de continuidad de 365 días.

Cuando `GET /operaciones/portal` resuelve la sesión correctamente, vuelve a emitir el **mismo token** en una cookie HttpOnly/Secure con 365 días desde esa apertura. Si la instalación válida está presente, renueva la misma cookie de instalación. Una lista vacía de turnos no desactiva al auxiliar ni invalida la sesión.

El navegador puede borrar cookies o imponer límites de persistencia. Si la cookie cruda ya desapareció, el servidor no intenta reconstruirla desde el hash de base de datos o desde el identificador de instalación; esa restricción se mantiene deliberadamente para no debilitar la autenticación.

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

El valor mantiene el horizonte inicial de activación y sus límites de 15 minutos a 30 días. Desde #1461 ya no funciona como una regla autónoma de baja para una sesión que posteriormente sigue activa, no revocada y vinculada a un auxiliar/dispositivo autorizados; una resolución válida aplica el horizonte de continuidad renovable.

No se agregan variables automáticamente en Railway durante este PR.

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

La página usa una política CSP con nonce:

```text
default-src 'none'
script-src 'nonce-...'
style-src 'unsafe-inline'
connect-src 'self'
img-src 'self' data:
base-uri 'none'
form-action 'self'
frame-ancestors 'none'
```

No carga JavaScript, CSS, fuentes, analítica o imágenes de terceros.

## Errores

Token inválido, vencido, consumido o revocado produce la misma respuesta pública:

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

## Portada mínima

`GET /operaciones/portal` busca la cookie de sesión y ejecuta `resolveWorkerPortalSession()`.

Una sesión solo se muestra como activa cuando el adaptador de #586 confirma que:

- la sesión sigue activa y no revocada;
- el auxiliar sigue habilitado;
- el dispositivo sigue autorizado como principal;
- las relaciones continúan siendo coherentes.

`expiresAt` histórico ya no constituye por sí solo una segunda autoridad de rechazo. La portada renueva la persistencia de una sesión válida y una lista vacía de asignaciones sigue representando una sesión activa sin turnos disponibles.

La vista no recibe ni presenta `workerId`, `deviceId` o `sessionId`.

Si la sesión falta o fue revocada —incluyendo baja del auxiliar o revocación/reemplazo del dispositivo principal— se limpia la cookie del navegador y se muestra un estado genérico de activación requerida.

## Seguridad de cookies

OWASP recomienda intercambiar identificadores de sesión mediante cookies con `Secure`, `HttpOnly` y `SameSite`, evitando parámetros URL. MDN documenta que el prefijo `__Secure-` exige `Secure` y un origen HTTPS.

La continuidad de #1461 no introduce refresh token, almacenamiento JavaScript ni un segundo secreto. Se reemite el mismo token cuya validez continúa controlada server-side por sesión, auxiliar y dispositivo.

## Fuera de alcance

- botón administrativo para emitir activaciones;
- envío de enlaces por WhatsApp;
- listado de asignaciones;
- GPS y geocerca;
- cámara y fotografía;
- marcación de llegada o salida;
- revisión del coordinador;
- cierre de sesión con revocación en base de datos;
- PWA instalable;
- migraciones nuevas;
- despliegue manual en Railway.

## Próximo paso

Después de integrar esta ruta, la siguiente entrega debe permitir que `dev` emita una activación para un auxiliar desde el panel operativo y copie o envíe el enlace con fragmento.

El envío automático por WhatsApp debe permanecer en una fase posterior, después de validar manualmente:

- Railway con HTTPS;
- cookies aceptadas en Android y iPhone;
- apertura desde WhatsApp;
- ausencia del token en logs e historial;
- activación única;
- revocación de la sesión anterior.

## Rollback

Revertir el router, su montaje, la vista, las pruebas y este documento.

La tabla `DispatchWorkerPortalSession` de #586 puede permanecer sin consumidores. #1461 no crea migraciones ni transforma datos; su rollback es un revert de código/documentación.

## Frontera HTTP reforzada

La ruta del portal se monta antes de los parsers JSON globales. `POST /activar` aplica su propio límite de 4 KB, captura localmente JSON inválido o demasiado grande y no propaga el cuerpo al logger global.

Antes del parser y de PostgreSQL se ejecuta un guard de intentos por dirección de red. La implementación predeterminada mantiene una ventana acotada, un número máximo de intentos y un máximo de claves; expulsa entradas vencidas o menos recientes. El guard es inyectable para sustituirlo por un adaptador compartido cuando el servicio opere con múltiples réplicas.

Los rechazos esperados de tokens inválidos, vencidos, consumidos o revocados no generan un warning por solicitud. Los errores inesperados o de configuración se registran únicamente mediante códigos sanitizados.
