# Asistencia operativa: activación HTTP del Portal del Auxiliar

## Estado

Implementación relacionada con #509 y #587. Continúa la política de sesión de #582 y la persistencia integrada en #586.

Esta fase conecta la activación y resolución de sesión a HTTP. Todavía no muestra asignaciones, no captura ubicación o fotografía y no registra llegada o salida.

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
Path: /operaciones/portal
Domain: ausente
Duración: 365 días
```

El UUID no se guarda directamente en la base de datos. La autoridad de #582 calcula un HMAC-SHA-256 usando `ATTENDANCE_INSTALLATION_PEPPER`, y el adaptador Prisma solo recibe ese HMAC.

Si la cookie falta o contiene un valor inválido, el servidor genera un UUID v4 nuevo y reemplaza el valor.

## Sesión

Después de validar la activación, la autoridad devuelve un token de sesión generado con CSPRNG. La ruta lo coloca en:

```text
Nombre: __Secure-lorren-attendance
HttpOnly: true
Secure: true
SameSite: Strict
Path: /operaciones/portal
Domain: ausente
```

La base de datos conserva únicamente SHA-256 del token. El token crudo no se incluye en respuestas JSON, logs o redirecciones.

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

Si no se define, se mantiene el TTL de siete días fijado por la política de #582. Los límites admitidos siguen siendo entre 15 minutos y 30 días.

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

- la sesión sigue activa y vigente;
- el auxiliar sigue habilitado;
- el dispositivo sigue autorizado como principal;
- las relaciones continúan siendo coherentes.

La vista no recibe ni presenta `workerId`, `deviceId` o `sessionId`.

Si la sesión falta, venció o fue revocada, se limpia la cookie del navegador y se muestra un estado genérico de activación requerida.

## Seguridad de cookies

OWASP recomienda intercambiar identificadores de sesión mediante cookies con `Secure`, `HttpOnly` y `SameSite`, evitando parámetros URL. MDN documenta que el prefijo `__Secure-` exige `Secure` y un origen HTTPS.

Se mantiene `__Secure-` en lugar de `__Host-` porque las cookies se restringen deliberadamente a `Path=/operaciones/portal`; `__Host-` exige `Path=/`.

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

La tabla `DispatchWorkerPortalSession` de #586 puede permanecer sin consumidores. Este PR no crea migraciones ni transforma datos.

## Frontera HTTP reforzada

La ruta del portal se monta antes de los parsers JSON globales. `POST /activar` aplica su propio límite de 4 KB, captura localmente JSON inválido o demasiado grande y no propaga el cuerpo al logger global.

Antes del parser y de PostgreSQL se ejecuta un guard de intentos por dirección de red. La implementación predeterminada mantiene una ventana acotada, un número máximo de intentos y un máximo de claves; expulsa entradas vencidas o menos recientes. El guard es inyectable para sustituirlo por un adaptador compartido cuando el servicio opere con múltiples réplicas.

Los rechazos esperados de tokens inválidos, vencidos, consumidos o revocados no generan un warning por solicitud. Los errores inesperados o de configuración se registran únicamente mediante códigos sanitizados.
