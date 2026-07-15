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

## Semántica vigente en interviewLifecycle.js

La política compartida actual considera:

- activos: `SCHEDULED` y `CONFIRMED`;
- cerrados: `CANCELLED`, `RESCHEDULED`, `NO_RESPONSE`, `ATTENDED` y `NO_SHOW`.

La automatización se detiene cuando:

- el booking no existe;
- tiene estado cerrado;
- la fecha programada ya pasó;
- ya se envió recordatorio;
- la ventana de recordatorio está cerrada.

La confirmación de asistencia se acepta cuando:

- el booking está activo;
- la entrevista aún no ocurrió;
- es el mismo día en Bogotá; o
- existe contexto explícito de recordatorio para interpretar una respuesta afirmativa breve.

`NO_RESPONSE` solo es elegible cuando el booking sigue activo, tiene recordatorio enviado, no existe respuesta posterior, es el mismo día en Bogotá y faltan como máximo cinco minutos.

## Autoridades observadas

El manifiesto actual declara cinco escritores directos:

| Escritor | Responsabilidad observada | Estado de auditoría |
| --- | --- | --- |
| `src/services/interviewScheduler.js` | creación, reemplazo y cancelación de reservas activas | Auditado |
| `src/services/reminder.js` | reclamación y cierre de ventanas; marcado de `NO_RESPONSE` | Auditado |
| `src/routes/admin.js` | estado manual, recordatorio, eliminación y asignación | Auditado |
| `src/services/chatEngine.js` | confirmación, cancelación y solicitud de reprogramación del motor alternativo | Auditado |
| `src/routes/webhook.js` | confirmación, cancelación, solicitud de reprogramación y creación desde conversación | Auditado; se migrará al final |

No se retirará un escritor del manifiesto hasta que todas sus mutaciones hayan sido delegadas y cubiertas por pruebas.

## Invariantes objetivo

1. Aceptar inicialmente un horario produce una reserva `SCHEDULED`, no `CONFIRMED`.
2. `CONFIRMED` representa confirmación de asistencia conforme a la ventana temporal vigente.
3. Las reservas activas para disponibilidad, lifecycle y recordatorios son `SCHEDULED` y `CONFIRMED`.
4. Una reserva anterior solo pasa a `RESCHEDULED` cuando existe una reserva activa de reemplazo creada dentro de la misma unidad atómica.
5. Una solicitud de reprogramación sin horario disponible debe conservar la reserva anterior o registrar un estado distinto de solicitud; no debe fingir una reprogramación terminada.
6. Las reservas cerradas no deben recibir nuevos recordatorios.
7. `NO_RESPONSE` solo se reclama desde `SCHEDULED`, con recordatorio enviado, dentro de la ventana previa configurada y sin respuesta detectada.
8. Una respuesta tardía debe conservar hora real y política aplicada, aunque el booking ya esté en `NO_RESPONSE`.
9. Cuando se conoce el ID de la reserva, la transición operativa debe aplicarse a esa reserva exacta.
10. Los contratos compartidos deberán aceptar Prisma principal o un cliente transaccional `tx` sin abrir transacciones anidadas.
11. La centralización no debe cambiar mensajes, horarios, anticipación mínima, orden de efectos ni experiencia del candidato.
12. Ningún consumidor podrá suministrar un estado destino arbitrario mediante una actualización genérica.

Estas invariantes expresan el comportamiento objetivo acordado. El inventario también registra dónde el runtime actual todavía las contradice.

## Frontera auditada: interviewScheduler.js

### Estados activos

El scheduler considera activas únicamente:

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
5. Si la creación falla, consulta cualquier reserva activa del candidato:
   - si apareció una, la devuelve;
   - si no existe, propaga el error original.

Riesgos e invariantes:

- el reemplazo y la creación solo son atómicos cuando el consumidor entrega un cliente `tx`;
- el fallback por cualquier reserva activa puede devolver una reserva distinta del slot solicitado;
- la búsqueda alternativa está limitada por candidato, no por tenant ni vacante;
- `replacementStatus` es parametrizable y debe sustituirse por contratos explícitos;
- la función mezcla creación inicial y reemplazo, aunque son transiciones de negocio diferentes.

### cancelCandidateBookings()

Comportamiento observado:

- actualiza todas las reservas `SCHEDULED` o `CONFIRMED` del candidato;
- usa `CANCELLED` como estado predeterminado;
- cierra la ventana de recordatorio;
- acepta actualmente un `replacementStatus` alternativo.

La futura autoridad deberá distinguir cancelación de reprogramación y evitar que cualquier consumidor suministre estados arbitrarios.

## Frontera auditada: reminder.js

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

Antes de reclamarla, el dispatcher verifica si existe una respuesta entrante posterior a `reminderSentAt`. La transición no elimina mensajes ni impide físicamente una respuesta posterior; sin embargo, el modelo todavía no registra de forma estructurada la fecha ni el resultado de una respuesta tardía.

## Frontera auditada: chatEngine.js

`handleAppointmentIntentDirectly()` carga una reserva activa y muta por ID exacto.

### confirm_attendance

- cambia el estado a `CONFIRMED`;
- conserva el mensaje entrante en `reminderResponse`;
- cierra la ventana de recordatorio;
- responde con la fecha de la reserva.

La clasificación previa restringe la confirmación mediante la política de `interviewLifecycle.js`.

### cancel_interview

- cambia el estado a `CANCELLED`;
- guarda `reminderResponse`;
- cierra la ventana;
- limpia el recordatorio del candidato y lo deja en `SKIPPED`.

### reschedule_interview

Comportamiento actual:

1. cambia inmediatamente la reserva anterior a `RESCHEDULED`;
2. guarda la respuesta y cierra la ventana;
3. después busca un horario alternativo;
4. cambia al candidato a `SCHEDULING`;
5. si hay alternativa, la ofrece; si no existe, informa que un humano ayudará;
6. no crea una reserva nueva en esta operación.

Hallazgo crítico: el estado `RESCHEDULED` se asigna antes de comprobar disponibilidad y sin crear una reserva de reemplazo. Por tanto, una solicitud puede cerrar la única reserva válida incluso cuando no existe otro horario.

## Frontera auditada: webhook.js

El webhook contiene una ruta determinística de agenda para candidatos en `SCHEDULING` o `SCHEDULED`.

### cancel_interview

- si existe booking activo, lo cambia por ID a `CANCELLED`;
- guarda `reminderResponse`;
- cierra la ventana;
- limpia el recordatorio del candidato.

### reschedule_interview

Comportamiento actual:

1. cambia inmediatamente el booking activo a `RESCHEDULED`;
2. guarda la respuesta y cierra la ventana;
3. después comprueba `nextSlot`;
4. si no hay slot, pausa el flujo y deja la reserva anterior cerrada;
5. si hay slot, cambia al candidato a `SCHEDULING` y ofrece el horario;
6. la nueva reserva solo se crea cuando el candidato confirma posteriormente.

Este flujo reproduce la misma inconsistencia de `chatEngine.js`: `RESCHEDULED` significa “solicitud registrada”, aunque lifecycle y Prisma lo tratan como reserva cerrada y el objetivo funcional exige reservarlo para una reprogramación completada.

### confirm_attendance

- cambia el booking activo por ID a `CONFIRMED`;
- guarda la respuesta;
- cierra la ventana;
- responde con el horario contextual.

### confirmación inicial del horario

Cuando el candidato está en `SCHEDULING` y acepta el slot ofrecido:

1. ejecuta `cancelCandidateBookings()`;
2. llama a `createBooking()`;
3. cambia el candidato a `SCHEDULED`;
4. envía la confirmación.

Riesgos:

- el webhook no envuelve cancelación, creación y cambio del candidato en una transacción;
- `createBooking()` vuelve a ejecutar su propio reemplazo de reservas activas;
- si la creación falla después de cancelar, el candidato puede quedar sin reserva activa;
- la expresión usada para decidir `RESCHEDULED` o `CANCELLED` dentro de una rama que exige `currentStep === SCHEDULING` hace que normalmente se use `CANCELLED`.

## Frontera auditada: admin.js

### Clasificación administrativa de estados

El panel define como “activos”:

- `SCHEDULED`;
- `CONFIRMED`;
- `RESCHEDULED`.

Esto contradice `interviewLifecycle.js`, scheduler y reminder, que consideran `RESCHEDULED` cerrado.

### Cambio manual de estado

La ruta `/interviews/:id/status` traduce acciones a:

- `CONFIRMED`;
- `ATTENDED`;
- `NO_RESPONSE`;
- `NO_SHOW`;
- `CANCELLED`;
- `RESCHEDULED`.

Después actualiza directamente el booking por ID y registra un `CandidateAdminEvent` con origen y destino.

No valida el estado de origen. Por tanto, el panel puede realizar saltos como `CANCELLED → CONFIRMED`, `ATTENDED → NO_RESPONSE` o `NO_SHOW → RESCHEDULED` si la interfaz envía la acción correspondiente.

### Recordatorio manual

El panel permite recordatorio manual cuando el booking pertenece a su lista de estados activos. Debido a que esa lista incluye `RESCHEDULED`, una reserva que el lifecycle considera cerrada puede recibir un recordatorio manual.

### Eliminación manual

La ruta de eliminación:

- elimina el booking exacto dentro de una transacción;
- busca otra reserva considerada activa por el panel;
- si no encuentra otra, cambia al candidato a `SCHEDULING`.

La operación es atómica, pero utiliza la definición administrativa inconsistente que incluye `RESCHEDULED`.

### Asignación manual

La asignación:

1. verifica que el slot siga siendo ofrecible;
2. abre una transacción;
3. busca una reserva activa según la lista administrativa;
4. si existe, invoca `cancelCandidateBookings(tx, candidate.id, 'RESCHEDULED')`;
5. crea la nueva reserva mediante `createBooking(tx, ...)`;
6. fuera de esa transacción, intenta cambiar el candidato a `SCHEDULED` y usa `SCHEDULING` como fallback.

La reserva sí se reemplaza transaccionalmente. Sin embargo:

- si el único booking encontrado es `RESCHEDULED`, `cancelCandidateBookings()` no lo modifica porque solo actúa sobre `SCHEDULED`/`CONFIRMED`;
- el paso conversacional del candidato se actualiza fuera de la transacción de la reserva;
- la auditoría administrativa se registra después y no forma parte de la misma unidad atómica.

## Inconsistencias confirmadas

### 1. RESCHEDULED tiene dos significados incompatibles

- lifecycle, scheduler y reminder: estado cerrado;
- panel: estado activo y elegible para recordatorio manual;
- webhook y chat engine: solicitud de cambio todavía sin reserva nueva;
- scheduler: reserva anterior efectivamente reemplazada.

Antes de centralizar debe decidirse un significado único. La opción alineada con el objetivo acordado es:

- `RESCHEDULE_REQUESTED`: solicitud registrada, si se decide ampliar el esquema;
- `RESCHEDULED`: reserva anterior reemplazada por una nueva reserva válida.

La ampliación de Prisma no se realizará en este PR documental.

### 2. Dos rutas cierran antes de reemplazar

Webhook y `chatEngine.js` cambian a `RESCHEDULED` antes de confirmar disponibilidad y sin nueva reserva. Esto viola la invariante acordada y puede dejar al candidato sin reserva activa.

### 3. La creación inicial del webhook no es atómica

Cancela primero y crea después sin transacción, aunque `createBooking()` ya implementa reemplazo interno. La primera migración técnica deberá fijar este comportamiento con una unidad atómica y pruebas de fallo de creación.

### 4. El panel permite transiciones arbitrarias

La ruta administrativa valida el estado destino, pero no el origen ni la transición. La autoridad compartida necesitará operaciones explícitas para asistencia, inasistencia, cancelación y correcciones excepcionales auditadas.

### 5. No existe historial de booking

`CandidateAdminEvent` registra cambios manuales, pero las transiciones automáticas no tienen un historial unificado con actor, motivo, fuente y reserva reemplazante. Esto debe diseñarse antes de multitenancy, no improvisarse dentro del primer refactor.

## Matriz observada de transiciones

| Origen | Acción | Destino o mutación | Autoridad actual | Atomicidad actual |
| --- | --- | --- | --- | --- |
| sin reserva exacta | aceptar horario | crear `SCHEDULED` | scheduler/webhook/admin | depende del consumidor |
| `SCHEDULED`/`CONFIRMED` | crear reemplazo | anterior → `RESCHEDULED`; nueva → `SCHEDULED` | scheduler | solo con `tx` externo |
| `SCHEDULED`/`CONFIRMED` | cancelar por candidato | `CANCELLED` + cerrar ventana | scheduler | operación única `updateMany` |
| ventana abierta | cerrar duplicado | `reminderWindowClosed = true` | reminder | condicional por booking |
| `SCHEDULED`/`CONFIRMED` | reclamar reminder | fecha de reminder + ventana cerrada | reminder | condicional por booking |
| `SCHEDULED` | sin respuesta a cinco minutos | `NO_RESPONSE` + ventana cerrada | reminder | condicional por booking |
| `SCHEDULED`/`CONFIRMED` | confirmar asistencia | `CONFIRMED` + respuesta | webhook/chat engine | actualización única |
| `SCHEDULED`/`CONFIRMED` | cancelar entrevista | `CANCELLED` + respuesta | webhook/chat engine | booking y candidato separados |
| `SCHEDULED`/`CONFIRMED` | pedir reprogramación | `RESCHEDULED` sin nueva reserva | webhook/chat engine | no atómica; inconsistente |
| cualquier estado visible | acción manual | uno de seis estados | admin | actualización única sin guard de origen |
| booking existente | asignar manualmente | anterior reemplazada + nueva `SCHEDULED` | admin/scheduler | reserva en `tx`; candidato fuera |
| cualquier booking | eliminar manualmente | eliminación física | admin | transaccional con paso del candidato |

## Contratos objetivo propuestos

`InterviewBookingStateService` no expondrá una operación genérica `updateBooking()`. La primera versión deberá evolucionar hacia contratos estrechos:

- `createInitialBooking()`;
- `replaceActiveBooking()`;
- `confirmBookingAttendance()`;
- `cancelBooking()`;
- `requestBookingReschedule()`;
- `completeBookingReschedule()`;
- `claimBookingReminder()`;
- `closeBookingReminderWindow()`;
- `markBookingNoResponse()`;
- `markBookingAttended()`;
- `markBookingNoShow()`;
- `deleteBookingForAdministrativeCorrection()`.

Los nombres son provisionales hasta fijar la matriz de estados permitidos. Cada contrato deberá declarar:

- booking exacto o criterio permitido;
- estados de origen válidos;
- estado de destino;
- campos adicionales que puede modificar;
- actor y motivo cuando correspondan;
- idempotencia;
- comportamiento ante concurrencia;
- compatibilidad con Prisma principal y `tx`;
- efectos coordinados sobre candidato, recordatorios y reserva reemplazante.

## Pruebas que deben existir antes de migrar runtime

1. Crear una reserva inicial produce `SCHEDULED`.
2. Repetir la misma solicitud devuelve la reserva exacta sin duplicar.
3. Un fallo al crear el reemplazo no cierra la reserva anterior.
4. Solicitar reprogramación sin slot no produce `RESCHEDULED` definitivo.
5. Completar reprogramación crea nueva reserva y cierra la anterior atómicamente.
6. No puede haber dos reservas activas según la definición canónica.
7. `CONFIRMED` solo parte de un estado permitido y una política temporal válida.
8. `NO_RESPONSE` no parte de `CONFIRMED`, `CANCELLED` ni `RESCHEDULED`.
9. Una reserva cerrada no recibe reminder automático ni manual.
10. Una acción administrativa inválida se rechaza y no altera el booking.
11. El servicio funciona con Prisma principal y con `tx` existente.
12. La respuesta tardía posterior a `NO_RESPONSE` queda trazada sin perder su hora real.

## Orden de trabajo actualizado

1. Convertir este inventario en la matriz canónica de transiciones permitidas.
2. Añadir pruebas negativas de transición sin cambiar consumidores.
3. Crear el esqueleto de `InterviewBookingStateService` con contratos estrechos.
4. Migrar `interviewScheduler.js` y hacer atómico el reemplazo.
5. Migrar `reminder.js` conservando sus filtros condicionales.
6. Migrar `admin.js` con acciones explícitas y auditadas.
7. Migrar `chatEngine.js` heredado.
8. Migrar `webhook.js` al final, preservando replays y experiencia conversacional.
9. Introducir historial y `tenantId` en una fase posterior, con migración separada.
10. Marcar `InterviewBooking` como canónico solo cuando el manifiesto tenga un único escritor.

## Fuera de alcance de este inventario

- introducir `tenantId` o migraciones Prisma;
- cambiar anticipación mínima u horizonte de agenda;
- cambiar textos enviados al candidato;
- implementar outbox;
- modificar candidatos, vacantes, consentimiento, CV o permisos;
- tocar cualquier lógica relacionada con género.
