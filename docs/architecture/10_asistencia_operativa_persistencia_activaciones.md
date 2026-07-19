# Asistencia operativa: persistencia de activaciones y adaptador Prisma

## Estado

Implementación relacionada con #509, #535 y #536. Completa la persistencia que quedó pendiente después de #534.

La revisión previa confirmó que #534 integró únicamente la autoridad de aplicación para emitir y consumir activaciones. No existía un PR, rama o modelo `DispatchWorkerActivation` que implementara sus contratos.

## Objetivo

Persistir activaciones de un solo uso y ejecutar atómicamente la autorización del dispositivo principal, sin crear todavía rutas públicas, sesiones del auxiliar, mensajes de WhatsApp ni marcaciones.

## Modelo `DispatchWorkerActivation`

La tabla conserva exclusivamente:

- auxiliar asociado;
- propósito del token;
- hash SHA-256 único;
- estado;
- vencimiento;
- consumo y dispositivo que lo consumió;
- revocación, motivo y actor;
- actor de creación;
- fechas de auditoría.

No existe columna para token crudo, token plano o secreto recuperable.

## Emisión

`replacePendingActivation()` abre una transacción `Serializable` y:

1. revalida que el auxiliar siga en estado `ACTIVE` o `CONTRATADO`;
2. revoca activaciones pendientes anteriores del mismo propósito;
3. crea la nueva activación con el hash recibido desde la autoridad de aplicación.

La revalidación dentro de la transacción evita emitir un enlace para un auxiliar desactivado entre la lectura inicial y la escritura.

## Consumo y dispositivo principal

`claimActivationAndAuthorizePrimaryDevice()` ejecuta dentro de una única transacción:

1. localización por `tokenHash` único;
2. validación de propósito, estado pendiente, ausencia de consumo o revocación y vencimiento futuro;
3. revalidación del auxiliar activo;
4. reclamo condicional mediante `updateMany`;
5. revocación de dispositivos principales activos anteriores;
6. creación o reactivación de la instalación autorizada;
7. enlace de la activación consumida con el dispositivo resultante.

Si el reclamo condicional devuelve `count = 0`, otra solicitud ganó la carrera y no se modifica ningún dispositivo.

## Concurrencia

Las transacciones usan:

```text
isolationLevel: Serializable
```

El adaptador reintenta únicamente errores Prisma `P2034`, con un máximo configurable entre cero y cinco reintentos. Otros errores se propagan sin repetición automática.

No se realizan llamadas HTTP, envíos de WhatsApp ni almacenamiento externo dentro de la transacción.

## Migración

La migración es exclusivamente expansiva:

- crea `DispatchWorkerActivation`;
- crea índices y claves foráneas;
- no elimina ni renombra tablas o columnas;
- no contiene `DROP`, `TRUNCATE`, `DELETE FROM` ni `ALTER COLUMN`.

La migración no se aplica manualmente en producción desde esta entrega. El proyecto continuará usando `prisma migrate deploy` dentro de su proceso de arranque/despliegue existente.

## Seguridad

- el token crudo nunca llega al adaptador;
- `tokenHash` es único;
- una activación consumida no puede reclamarse otra vez;
- un token vencido o revocado no cambia dispositivos;
- el identificador de instalación continúa llegando como HMAC-SHA-256 desde la autoridad integrada en #534;
- el dispositivo anterior queda revocado de forma auditable.

## Fuera de alcance

- endpoint para emitir activaciones;
- endpoint público para consumirlas;
- envío del enlace por WhatsApp;
- sesión o cookie del Portal del Auxiliar;
- PWA;
- GPS, fotografía o marcación de llegada;
- despliegue o migración manual en Railway.

## Pruebas

La suite específica cubre:

- aislamiento `Serializable`;
- reintentos `P2034` y no reintento de otros códigos;
- estados válidos del auxiliar;
- revocación y reemplazo de activaciones pendientes;
- ausencia del token crudo;
- vencimiento;
- reclamo condicional perdido;
- revocación del principal anterior;
- autorización y enlace del nuevo dispositivo;
- SQL exclusivamente aditivo;
- ausencia de rutas o efectos externos en el adaptador.

## Rollback

Antes de desplegar, revertir el PR completo.

Después de desplegar, dejar la tabla sin consumidores y revertir únicamente el código. No ejecutar una eliminación automática de la tabla ni de sus datos de auditoría.
