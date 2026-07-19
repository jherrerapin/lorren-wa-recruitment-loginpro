# Asistencia operativa: autoridad de registro de llegada

## Estado

Implementación relacionada con los issues #509 y #516. Esta entrega depende del esquema del PR #515 y se presenta como PR apilado sobre `feat/514-attendance-persistence`.

No existen rutas HTTP ni consumidores runtime. El servicio no puede ser invocado desde la aplicación productiva hasta una fase posterior.

## Objetivo

Registrar una llegada como una operación atómica e idempotente sin mezclar la presencia física con `DispatchAssignment.status`.

La autoridad es `registerDispatchArrival(prisma, input)`, ubicada en:

```text
src/modules/dispatch-attendance/application/registerArrival.js
```

## Secuencia

1. Normaliza y valida la entrada.
2. Abre una transacción interactiva corta con aislamiento `Serializable`.
3. Busca una marcación previa por `idempotencyKey`.
4. Si existe, devuelve el resultado persistido sin nuevas escrituras.
5. Carga asignación, solicitud, punto y sesión existente.
6. Rechaza sin escribir cuando:
   - la asignación no está activa;
   - la asistencia está deshabilitada;
   - ya existe una llegada con otra clave.
7. Calcula el horario esperado desde `serviceDate`, `startTime` y `endTime`.
8. Resuelve dispositivo autorizado y señal de dispositivo compartido.
9. Calcula distancia al punto en servidor mediante Haversine.
10. Aplica `evaluateArrivalValidation`.
11. Crea, cuando sea necesario, una sesión única por asignación.
12. Crea una marcación única por `idempotencyKey`.
13. Actualiza la sesión como auto-validada o pendiente de revisión.
14. Confirma toda la operación o revierte todas las escrituras.

## Estados de asignación aceptados

El tablero actual considera activos:

- `ASSIGNED`
- `CONFIRMATION_PENDING`
- `CONFIRMED`

Esta lista está explícita y probada para evitar aceptar estados cerrados o inventados.

## Idempotencia

La primera autoridad es la restricción única de `DispatchAttendanceMark.idempotencyKey`.

Comportamiento:

- La misma clave devuelve la marcación ganadora con `replayed = true`.
- Una clave diferente después de una llegada ya registrada se rechaza como `DUPLICATE_ARRIVAL`.
- Un conflicto concurrente `P2002` se reintenta y, al agotarse el límite, se consulta la marcación ganadora.

No se confía únicamente en una consulta previa porque dos solicitudes concurrentes podrían leer ausencia antes de que una de ellas confirme su escritura.

## Concurrencia

La transacción usa aislamiento `Serializable` y un máximo de tres intentos para conflictos `P2034` o `P2002`.

Las operaciones dentro de la transacción son exclusivamente consultas y escrituras de PostgreSQL. No se realizan llamadas de red, almacenamiento R2, WhatsApp, mapas ni procesos de cámara durante la transacción.

Las restricciones únicas de sesión por asignación e idempotencia por marcación son la protección definitiva de integridad.

Referencias oficiales:

- Prisma — Transactions and batch queries: https://www.prisma.io/docs/orm/prisma-client/queries/transactions
- Prisma — Client API y conflictos de `upsert`: https://www.prisma.io/docs/orm/reference/prisma-client-reference
- PostgreSQL — Transaction Isolation: https://www.postgresql.org/docs/17/transaction-iso.html
- PostgreSQL — Unique Constraints: https://www.postgresql.org/docs/17/ddl-constraints.html

## Hora operativa

La hora oficial es `now`, inyectada por la futura capa HTTP desde el servidor.

`clientCapturedAt` se conserva como evidencia auxiliar y nunca reemplaza la hora del servidor.

La fase actual interpreta los horarios operativos en `America/Bogota`, coherente con el alcance colombiano actual. Admite formatos de 24 horas y formatos con `AM`/`PM`. Un turno cuya salida sea anterior o igual a la entrada se interpreta como nocturno y termina al día siguiente.

## Geocerca

La distancia se calcula en servidor usando las coordenadas persistidas del punto y las coordenadas recibidas.

El resultado considera por separado:

- geocerca configurada;
- distancia calculada;
- ubicación dentro o fuera del radio;
- precisión informada por el dispositivo.

Una ubicación dentro del radio no se auto-valida cuando la precisión supera el máximo configurado.

## Dispositivos

Una instalación queda autorizada únicamente cuando existe un `DispatchWorkerDevice` activo, vigente y no revocado para el auxiliar.

La misma instalación vinculada a otro auxiliar genera una señal de dispositivo compartido. No se bloquea mediante unicidad global porque el evento debe quedar detectable.

## Comportamiento preservado

- No cambia `DispatchAssignment.status`.
- No modifica rutas, vistas ni `server.js`.
- No activa asistencia en ningún punto.
- No aplica migraciones ni despliega en Railway.
- No sube fotografías.
- No crea revisiones manuales.
- No marca salidas ni calcula nómina.

## Pruebas

La suite específica cubre:

- distancia y geocerca;
- auto-validación confiable;
- dispositivo nuevo;
- repetición de la misma clave;
- segunda clave después de una llegada;
- punto deshabilitado;
- asignación inactiva;
- reintento `P2034`;
- recuperación del ganador `P2002`;
- inventario de estados activos.

## Rollback

Revertir los cuatro archivos de esta entrega. Al no existir rutas ni consumidores, el servicio permanece inalcanzable en producción.
