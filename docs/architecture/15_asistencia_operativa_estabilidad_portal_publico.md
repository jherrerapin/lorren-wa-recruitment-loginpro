# Asistencia operativa: estabilidad del Portal del Auxiliar

## Contexto

El PR #589 añadió las rutas públicas iniciales del Portal del Auxiliar, pero fue fusionado con observaciones de seguridad pendientes. Después del despliegue se reportó que la URL completa `/operaciones/portal` mostraba un error.

Esta entrega corrige la integración sin añadir nuevas funciones de negocio.

## Causas técnicas corregidas

### Parser global antes del parser del portal

`src/server.js` ejecutaba:

```text
express.json({ limit: '2mb' })
```

antes de montar el router del portal. En Express, cuando un parser ya procesó el cuerpo, el parser posterior de 4 KB no puede volver a imponer su límite. El portal aceptaba por tanto cuerpos mucho mayores de lo diseñado.

El montaje queda ahora antes del parser global:

```text
morgan
workerPortalRouter
express.json global
```

El parser de activación de 4 KB es la primera autoridad que lee ese cuerpo.

### JSON malformado y datos sensibles

Un cuerpo JSON malformado podía fallar en el parser global y llegar al manejador general, que registra el objeto de error completo. Algunos errores de `body-parser` pueden conservar el cuerpo recibido, donde viaja el token de activación.

La ruta pública ahora tiene un manejador local de errores de parseo que:

- responde 400 para JSON inválido;
- responde 413 para cuerpos mayores de 4 KB;
- utiliza un código público genérico;
- no registra el error ni el cuerpo;
- no pasa el error al manejador global.

### Intentos ilimitados

La activación es un endpoint público. Aunque el token tenga suficiente entropía para impedir adivinación práctica, solicitudes repetidas pueden consumir CPU, memoria, conexiones y transacciones de PostgreSQL.

Se añadió un límite por IP:

```text
Ventana: 10 minutos
Intentos: 12
Entradas máximas en memoria: 5.000
```

Al superar el límite se responde 429 con `Retry-After`, antes de consultar Prisma.

El almacenamiento en memoria es deliberadamente acotado. Las entradas vencidas se eliminan y, si se alcanza el máximo, se expulsa la entrada más antigua. Para múltiples réplicas futuras deberá sustituirse por un límite compartido, por ejemplo Redis.

## Degradación segura de la portada

La versión anterior construía el adaptador Prisma al crear el router. Eso aumentaba el acoplamiento entre una página pública informativa y la disponibilidad inmediata del modelo Prisma.

El repositorio ahora se crea de forma perezosa:

- `GET /operaciones/portal` sin cookie no consulta Prisma;
- la portada puede mostrar `Acceso no activo` aunque la persistencia no esté disponible;
- si existe una cookie pero Prisma, la tabla o la relación no están disponibles, se limpia la cookie y se muestra `Portal temporalmente no disponible`;
- la respuesta permanece en 200 y no expone detalles internos.

Esto no oculta fallos operativos: se conserva un log sanitizado con un código técnico, nunca con token, UUID o cuerpo de solicitud.

## Defensa en profundidad

El POST de activación valida dos veces la cabecera:

```text
X-Requested-With: worker-portal
```

La primera validación ocurre antes del parser; la segunda permanece dentro del controlador final. La duplicación es intencional para proteger consumidores directos o refactors futuros que invoquen el controlador sin toda la cadena de middleware.

## Pruebas añadidas

La suite cubre:

- portada sin sesión y sin inicializar Prisma;
- degradación segura cuando Prisma falla;
- JSON malformado sin acceso al repositorio;
- cuerpo superior a 4 KB;
- rate limit antes de nuevas activaciones;
- memoria acotada del limitador;
- cookies únicamente después de una activación exitosa;
- montaje único antes del parser global;
- estado visual de indisponibilidad temporal.

Las pruebas anteriores del PR #589 permanecen activas para evitar regresiones en cookies, fragmentos, CSP, sanitización de logs y resolución de sesión.

## Seguridad y fuentes

La guía oficial de Express recomienda usar TLS, validar toda entrada no confiable, manejar errores sin exponer detalles y proteger endpoints de autorización contra fuerza bruta. También recomienda cookies seguras para identificadores de sesión.

MDN documenta que las cookies con prefijo `__Secure-` solo deben establecerse desde HTTPS y con el atributo `Secure`. Se mantienen además `HttpOnly`, `SameSite=Strict` y el `Path` restringido al portal.

## Fuera de alcance

- emitir activaciones desde la interfaz administrativa;
- WhatsApp;
- asignaciones del auxiliar;
- GPS, cámara o fotografías;
- llegada y salida;
- migraciones;
- cambios manuales de Railway.

## Verificación de Railway

Después de fusionar y desplegar este cambio deben comprobarse:

```text
GET /health
GET /operaciones/portal
GET /operaciones/portal/activar
```

Resultados esperados:

- `/health`: 200;
- `/operaciones/portal`: 200 y pantalla de acceso no activo o sesión activa;
- `/operaciones/portal/activar`: 200 y pantalla que solicita un fragmento válido;
- ningún endpoint debe devolver stack trace, token o UUID.

También debe confirmarse que Railway desplegó el commit de esta corrección y no un commit anterior.

## Rollback

Revertir este PR restaura el comportamiento de #589. No existen migraciones ni cambios de datos asociados. La tabla de sesiones y activaciones permanece intacta.
