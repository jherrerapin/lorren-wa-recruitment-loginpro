# Inventario de transiciones de InterviewBooking

## Propósito

Este documento inicia la consolidación de `InterviewBooking` definida en #453. Su objetivo es describir las mutaciones existentes antes de introducir `InterviewBookingStateService` o cambiar el comportamiento productivo.

Esta etapa es exclusivamente documental. No modifica Prisma, agenda, recordatorios, textos, interpretación conversacional, permisos, consentimiento, CV ni lógica relacionada con género.

## Modelo persistido actual

`InterviewBooking` contiene:

- identidad de candidato, vacante y slot;
- fecha programada;
- estado;
- fecha de envío del recordatorio;
- cierre de la ventana de recordatorio;
- respuesta al recordatorio;
- notas y fechas de auditoría técnica.

Estados definidos en Prisma:

- `SCHEDULED`;
- `CONFIRMED`;
- `ATTENDED`;
- `NO_RESPONSE`;
- `RESCHEDULED`;
- `NO_SHOW`;
- `CANCELLED`.

El modelo todavía no almacena tenant, historial de transición, actor, motivo estructurado, reserva reemplazante ni fecha específica de respuesta tardía. Estas ausencias se registran como deuda para la fase multitenant, pero no se corregirán antes de centralizar las reglas vigentes.

## Autoridades observadas

El manifiesto actual declara cinco escritores directos:

| Escritor | Responsabilidad observada | Estado de auditoría |
| --- | --- | --- |
| `src/services/interviewScheduler.js` | creación, reemplazo y cancelación de reservas activas | Auditado en esta etapa |
| `src/services/reminder.js` | reclamación y cierre de ventanas; marcado de `NO_RESPONSE` | Auditado parcialmente en esta etapa |
| `src/routes/admin.js` | acciones manuales y eliminación asociada al candidato | Pendiente de inventario exacto |
| `src/services/chatEngine.js` | decisiones de agenda del motor alternativo | Pendiente de inventario exacto |
| `src/routes/webhook.js` | confirmación, cancelación y reprogramación conversacional | Pendiente de inventario exacto; se migrará al final |

No se retirará un escritor del manifiesto hasta que todas sus mutaciones hayan sido delegadas y cubiertas por pruebas.

## Invariantes vigentes que deben preservarse

1. Aceptar inicialmente un horario produce una reserva `SCHEDULED`, no `CONFIRMED`.
2. `CONFIRMED` representa confirmación de asistencia conforme a la ventana temporal vigente.
3. Las reservas activas para disponibilidad y reemplazo son `SCHEDULED` y `CONFIRMED`.
4. Una reserva anterior solo pasa a `RESCHEDULED` cuando el flujo crea o resuelve una reserva activa de reemplazo.
5. Las reservas cerradas no deben recibir nuevos recordatorios.
6. `NO_RESPONSE` solo se reclama desde `SCHEDULED`, con recordatorio enviado, dentro de la ventana previa configurada y sin respuesta detectada.
7. Cuando se conoce el ID de la reserva, la transición operativa debe aplicarse a esa reserva exacta.
8. Los contratos compartidos deberán aceptar Prisma principal o un cliente transaccional `tx` sin abrir transacciones anidadas.
9. La centralización no debe cambiar mensajes, horarios, anticipación mínima, orden de efectos ni experiencia del candidato.

## Frontera auditada: interviewScheduler.js

### Estados activos

El scheduler considera activas las reservas con estado:

- `SCHEDULED`;
- `CONFIRMED`.

### createBooking()

Comportamiento observado:

1. Busca una reserva activa exacta por candidato, vacante, slot y fecha.
2. Si existe, la devuelve y no crea una nueva.
3. Si no existe, actualiza todas las reservas activas del candidato:
   - asigna `replacementStatus`, cuyo valor predeterminado es `RESCHEDULED`;
   - establece `reminderWindowClosed = true`.
4. Crea la nueva reserva. Prisma aplica `SCHEDULED` como estado predeterminado.
5. Si la creación falla, consulta una reserva activa del candidato:
   - si apareció una, la devuelve;
   - si no existe, propaga el error original.

Riesgos e invariantes a fijar antes de migrar:

- el reemplazo y la creación no están envueltos aquí en una transacción única;
- el fallback por cualquier reserva activa protege concurrencia práctica, pero puede devolver una reserva distinta del slot solicitado;
- la búsqueda de reserva activa alternativa está limitada por candidato, no por tenant ni vacante;
- `replacementStatus` es parametrizable y debe restringirse mediante un contrato explícito, no mediante una actualización genérica.

### cancelCandidateBookings()

Comportamiento observado:

- actualiza todas las reservas activas del candidato;
- usa `CANCELLED` como estado predeterminado;
- cierra la ventana de recordatorio;
- acepta actualmente un `replacementStatus` alternativo.

La futura autoridad deberá distinguir cancelación de reprogramación y evitar que cualquier consumidor suministre estados arbitrarios.

## Frontera auditada parcialmente: reminder.js

### Cierre de una ventana no reclamada

`closeUnclaimedInterviewReminderWindow()` aplica una actualización condicional sobre el ID exacto:

- exige `reminderSentAt = null`;
- exige `reminderWindowClosed = false`;
- establece `reminderWindowClosed = true`.

Se usa para cerrar duplicados detectados entre reservas o dentro de un mismo lote.

### Reclamación del recordatorio de una hora

`claimInterviewBookingReminder()` actualiza el booking exacto únicamente cuando:

- coincide ID y candidato;
- está en `SCHEDULED` o `CONFIRMED`;
- todavía no tiene recordatorio;
- la ventana sigue abierta;
- la fecha está dentro del intervalo calculado.

La reclamación asigna:

- `reminderSentAt = now`;
- `reminderWindowClosed = true`.

### Marcado de NO_RESPONSE

`claimInterviewNoResponse()` actualiza el booking exacto únicamente cuando:

- coincide ID y candidato;
- el estado es `SCHEDULED`;
- ya se envió recordatorio;
- la entrevista está entre el momento actual y cinco minutos después.

La transición asigna:

- `status = NO_RESPONSE`;
- `reminderWindowClosed = true`.

Antes de reclamarla, el dispatcher verifica si existe una respuesta entrante posterior a `reminderSentAt`. La transición no elimina mensajes ni impide que una respuesta tardía sea procesada después; sin embargo, el modelo todavía no registra de forma estructurada la fecha ni el resultado de esa respuesta tardía.

## Matriz inicial de transiciones

| Origen | Acción | Destino o mutación | Autoridad actual | Condición principal |
| --- | --- | --- | --- | --- |
| sin reserva exacta | aceptar horario | crear `SCHEDULED` | `interviewScheduler.js` | slot válido resuelto por el consumidor |
| `SCHEDULED`/`CONFIRMED` | crear reemplazo | reserva anterior → `RESCHEDULED`; nueva → `SCHEDULED` | `interviewScheduler.js` | no existe reserva exacta activa |
| `SCHEDULED`/`CONFIRMED` | cancelar proceso de agenda | `CANCELLED` + cerrar ventana | `interviewScheduler.js` | cancelación por candidato |
| ventana abierta | cerrar duplicado | solo `reminderWindowClosed = true` | `reminder.js` | booking exacto sin reminder |
| `SCHEDULED`/`CONFIRMED` | reclamar reminder | `reminderSentAt = now`, ventana cerrada | `reminder.js` | booking exacto dentro de ventana |
| `SCHEDULED` | sin respuesta a cinco minutos | `NO_RESPONSE` + ventana cerrada | `reminder.js` | reminder enviado y sin inbound posterior |
| por auditar | confirmar asistencia | `CONFIRMED` | webhook/chat engine | política temporal vigente |
| por auditar | cancelar entrevista | `CANCELLED` | webhook/chat engine/admin | intención o acción explícita |
| por auditar | reprogramar | reserva anterior `RESCHEDULED` y nueva `SCHEDULED` | webhook/chat engine/scheduler | nueva disponibilidad válida |
| por auditar | registrar asistencia | `ATTENDED` | administración | acción humana |
| por auditar | registrar inasistencia | `NO_SHOW` | administración | acción humana |

Las filas “por auditar” describen el objetivo funcional conocido, pero no se consideran contrato confirmado hasta localizar cada mutación, sus filtros y sus efectos secundarios en código y pruebas.

## Contratos objetivo propuestos

`InterviewBookingStateService` no expondrá una operación genérica `updateBooking()`. La primera versión deberá evolucionar hacia contratos estrechos:

- `createOrReplaceActiveBooking()`;
- `confirmBookingAttendance()`;
- `cancelBooking()`;
- `requestBookingReschedule()`;
- `completeBookingReschedule()`;
- `claimBookingReminder()`;
- `closeBookingReminderWindow()`;
- `markBookingNoResponse()`;
- operaciones administrativas explícitas para `ATTENDED` y `NO_SHOW`.

Los nombres son provisionales hasta completar el inventario. Cada contrato deberá declarar:

- booking exacto o criterio permitido;
- estados de origen válidos;
- estado de destino;
- campos adicionales que puede modificar;
- actor y motivo cuando correspondan;
- idempotencia;
- comportamiento ante concurrencia;
- compatibilidad con Prisma principal y `tx`.

## Orden de trabajo

1. Completar el inventario exacto de `reminder.js`.
2. Auditar las mutaciones administrativas y sus pruebas.
3. Auditar `chatEngine.js` como ruta heredada.
4. Auditar `webhook.js` y relacionar cada transición con los replays existentes.
5. Fijar pruebas negativas de transición antes de crear el servicio compartido.
6. Migrar primero `interviewScheduler.js` en un PR de comportamiento preservado.
7. Migrar recordatorios, administración, motor heredado y webhook, en ese orden.
8. Marcar `InterviewBooking` como canónico solo cuando el manifiesto tenga un único escritor.

## Fuera de alcance de este inventario

- introducir `tenantId` o migraciones Prisma;
- cambiar anticipación mínima u horizonte de agenda;
- cambiar políticas de reprogramación;
- cambiar estados visibles o textos enviados;
- implementar outbox;
- modificar candidatos, vacantes, consentimiento, CV o permisos;
- tocar cualquier lógica relacionada con género.
