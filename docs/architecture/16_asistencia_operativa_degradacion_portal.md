# Asistencia operativa: degradación segura del Portal del Auxiliar

## Contexto

El PR #589 publicó las primeras rutas de `/operaciones/portal`. El PR #596 corrigió posteriormente la frontera HTTP: parser real de 4 KB, manejo local de JSON inválido y protección contra intentos repetidos.

Persistía un acoplamiento distinto: el adaptador Prisma se construía al crear el router. Eso significaba que una incompatibilidad temporal del Prisma Client, una migración pendiente o un modelo no disponible podía impedir incluso mostrar la portada pública.

## Objetivo

Separar la disponibilidad de la pantalla pública de la disponibilidad inmediata de la persistencia de sesiones.

## Repositorio perezoso

El router conserva ahora una fábrica:

```text
repositoryFactory()
```

El adaptador se crea solamente cuando una operación necesita consultar o escribir una sesión.

Consecuencias:

- abrir `/operaciones/portal` sin cookie no consulta Prisma;
- abrir `/operaciones/portal/activar` no consulta Prisma hasta el POST;
- la construcción del router no falla por un modelo Prisma faltante;
- una activación sí continúa fallando de forma cerrada si la persistencia no está disponible.

## Estados de la portada

### `inactive`

Se utiliza cuando:

- no existe cookie de sesión;
- la cookie tiene formato inválido;
- la sesión fue revocada, venció o no existe.

Una cookie inválida o una sesión confirmada como no vigente se elimina.

### `active`

Se utiliza únicamente cuando la persistencia confirma que:

- la sesión sigue activa;
- el auxiliar continúa habilitado;
- el dispositivo permanece autorizado;
- la sesión no ha vencido.

### `unavailable`

Se utiliza cuando existe una cookie con formato válido, pero no es posible verificarla por una falla temporal de infraestructura o configuración.

En ese caso:

- la respuesta HTTP sigue siendo 200;
- no se muestra stack trace ni información interna;
- la cookie no se elimina, porque la falla no demuestra que la sesión sea inválida;
- se registra solamente un código técnico sanitizado;
- el usuario ve “Portal temporalmente no disponible”.

## Activación

`POST /operaciones/portal/activar` continúa fallando de forma cerrada. Si el repositorio no puede inicializarse, responde:

```json
{
  "ok": false,
  "error": "portal_temporarily_unavailable"
}
```

No se crean cookies y no se consume una activación parcialmente.

## Seguridad

La corrección no modifica las protecciones de #596:

- límite real de 4 KB;
- errores JSON locales;
- guard de intentos antes de PostgreSQL;
- cookies `Secure`, `HttpOnly` y `SameSite=Strict`;
- CSP y `Cache-Control: no-store`;
- ausencia de tokens y UUID en logs.

La guía oficial de Express recomienda manejar errores sin exponer detalles internos, validar toda entrada no confiable y usar cookies seguras sobre TLS. La degradación implementada aplica ese principio sin convertir una falla temporal en revocación silenciosa de una sesión válida.

## Pruebas

La suite específica comprueba:

- construcción del router sin inicializar Prisma;
- portada sin cookie sin acceso a Prisma;
- pantalla `unavailable` ante falla temporal;
- preservación de la cookie durante la falla temporal;
- eliminación de una cookie malformada;
- activación cerrada con respuesta 503 cuando Prisma no está disponible;
- ausencia del token en respuesta y logs;
- presencia del estado visual de indisponibilidad.

## Verificación en Railway

Después de desplegar el cambio:

```text
GET /health
GET /operaciones/portal
GET /operaciones/portal/activar
```

Resultados esperados:

- `/health`: 200;
- `/operaciones/portal`: 200, incluso sin sesión;
- `/operaciones/portal/activar`: 200 mostrando la pantalla de activación;
- no debe aparecer `internal_server_error`, stack trace o JSON técnico al abrir la portada.

También debe confirmarse que Railway desplegó el commit del PR y no una versión anterior.

## Fuera de alcance

- emisión administrativa de activaciones;
- envío por WhatsApp;
- asignaciones, GPS, cámara, llegada o salida;
- nuevas migraciones;
- cambios manuales en Railway.

## Rollback

Revertir este PR restaura la creación inmediata del repositorio y el comportamiento anterior de la portada. No hay cambios de esquema ni transformación de datos.
