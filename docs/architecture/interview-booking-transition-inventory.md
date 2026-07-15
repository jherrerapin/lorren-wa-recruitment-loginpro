# Inventario de transiciones de InterviewBooking

## Propósito

Este documento inicia la consolidación de `InterviewBooking` definida en #453. Describe las mutaciones existentes antes de introducir `InterviewBookingStateService` o cambiar el comportamiento productivo.

Esta etapa es exclusivamente documental. No modifica Prisma, agenda, recordatorios, textos, interpretación conversacional, permisos, consentimiento, CV ni lógica relacionada con género.

## Modelo persistido actual

`InterviewBooking` contiene:

- candidato, vacante y slot;
- fecha programada;
- estado;
- fecha y cierre de la ventana de recordatorio;
- respuesta al recordatorio;
- notas y fechas técnicas.

Estados Prisma:

- `SCHEDULED`;
- `CONFIRMED`;
- `ATTENDED`;
- `NO_RESPONSE`;
- `RESCHEDULED`;
- `NO_SHOW`;
- `CANCELLED`.

El modelo todavía no almacena tenant, historial de transición, actor, motivo estructurado, reserva reemplazante ni fecha específica de respuesta tardía. Estas ausencias son deuda para la fase multitenant; no se corregirán antes de centralizar las reglas vigentes.

## Semántica vigente en interviewLifecycle.js

La política compartida actual considera:

- activos: `SCHEDULED` y `CONFIRMED`;
- cerrados: `CANCELLED`, `RESCHEDULED`, `NO_RESPONSE`, `ATTENDED` y `NO_SHOW`.

La automatización se detiene cuando el booking no existe, está cerrado, la fecha pasó, ya se envió recordatorio o la ventana está cerrada.

La confirmación de asistencia exige booking activo y entrevista futura. Se admite el mismo día en Bogotá o con contexto explícito de recordatorio para interpretar una respuesta afirmativa breve.

`NO_RESPONSE` exige booking activo, recordatorio enviado, ausencia de respuesta posterior, mismo día en Bogotá y máximo cinco minutos restantes.

## Escritores directos observados

| Escritor | Responsabilidad | Auditoría |
| --- | --- | --- |
| `src/services/interviewScheduler.js` | creación, reemplazo y cancelación de reservas activas | Completa |
| `src/services/reminder.js` | reclamación y cierre de ventanas; `NO_RESPONSE` | Completa |
| `src/routes/admin.js` | estado manual, recordatorio, eliminación y asignación | Completa |
| `src/services/chatEngine.js` | confirmación, cancelación y solicitud de reprogramación | Completa |
| `src/routes/webhook.js` | confirmación, cancelación, reprogramación y creación conversacional | Completa; se migrará al final |

No se retirará un escritor del manifiesto hasta delegar todas sus mutaciones y cubrirlas con pruebas.

## Invariantes objetivo

1. Aceptar inicialmente un horario crea `SCHEDULED`, no `CONFIRMED`.
2. `CONFIRMED` representa confirmación de asistencia dentro de la política temporal.
3. Las reservas activas son `SCHEDULED` y `CONFIRMED`.
4. La reserva anterior solo pasa a `RESCHEDULED` cuando existe una nueva reserva válida creada en la misma unidad atómica.
5. Una solicitud sin horario alternativo conserva la reserva anterior o usa un estado distinto de solicitud.
6. Las reservas cerradas no reciben recordatorios.
7. `NO_RESPONSE` solo parte de `SCHEDULED`, con recordatorio enviado y sin respuesta posterior.
8. Una respuesta tardía conserva hora real y política aplicada.
9. Cuando existe ID de booking, la transición se aplica al booking exacto.
10. Los contratos aceptan Prisma principal o `tx` sin transacciones anidadas.
11. La centralización no cambia mensajes, horarios, anticipación ni experiencia.
12. Ningún consumidor suministra destinos arbitrarios mediante una actualización genérica.
13. Las correcciones administrativas conservan actor, motivo y auditoría.
14. La eliminación física no se usa como transición ordinaria de negocio.

Estas son invariantes objetivo; el runtime actual todavía contradice algunas.

## interviewScheduler.js

### Estados activos

Solo `SCHEDULED` y `CONFIRMED`.

### createBooking()

1. Busca una reserva activa exacta por candidato, vacante, slot y fecha.
2. Si existe, la devuelve.
3. Si no existe, cambia todas las reservas activas del candidato al `replacementStatus` recibido, por defecto `RESCHEDULED`, y cierra sus ventanas.
4. Crea la nueva reserva; Prisma aplica `SCHEDULED`.
5. Si la creación falla, devuelve cualquier reserva activa que haya aparecido o propaga el error.

Riesgos:

- reemplazo y creación solo son atómicos cuando el consumidor entrega `tx`;
- el fallback puede devolver un slot distinto del solicitado;
- la búsqueda alternativa no está limitada por tenant ni vacante;
- `replacementStatus` admite destinos arbitrarios;
- mezcla creación inicial y reemplazo.

### cancelCandidateBookings()

Actualiza todas las reservas `SCHEDULED` o `CONFIRMED`, usa `CANCELLED` por defecto, cierra la ventana y admite un `replacementStatus` alternativo.

La autoridad futura separará cancelación y reprogramación.

## reminder.js

### Cierre de ventana

`closeUnclaimedInterviewReminderWindow()` actualiza el booking exacto cuando no tiene recordatorio y la ventana sigue abierta. Solo asigna `reminderWindowClosed = true`.

### Reclamación del recordatorio

`claimInterviewBookingReminder()` exige ID, candidato, estado activo, recordatorio ausente, ventana abierta y fecha dentro del intervalo. Asigna `reminderSentAt = now` y cierra la ventana.

### NO_RESPONSE

`claimInterviewNoResponse()` exige booking exacto en `SCHEDULED`, recordatorio enviado y entrevista dentro de cinco minutos. Asigna `NO_RESPONSE` y cierra la ventana.

Antes, el dispatcher comprueba si existe un inbound posterior a `reminderSentAt`. El modelo aún no registra estructuradamente una respuesta tardía.

## chatEngine.js

`handleAppointmentIntentDirectly()` carga una reserva activa y muta por ID.

### confirm_attendance

Asigna `CONFIRMED`, guarda `reminderResponse`, cierra la ventana y responde con la fecha. La clasificación previa usa `interviewLifecycle.js`.

### cancel_interview

Asigna `CANCELLED`, guarda la respuesta, cierra la ventana y limpia el recordatorio del candidato.

### reschedule_interview

1. Asigna inmediatamente `RESCHEDULED` a la reserva anterior.
2. Guarda la respuesta y cierra la ventana.
3. Después busca una alternativa.
4. Cambia al candidato a `SCHEDULING`.
5. Ofrece el horario si existe; si no, informa que un humano ayudará.
6. No crea una nueva reserva.

Hallazgo crítico: cierra la única reserva antes de comprobar disponibilidad y sin reemplazo válido.

## webhook.js

### cancel_interview

Cambia el booking activo a `CANCELLED`, guarda respuesta, cierra ventana y limpia recordatorio del candidato.

### reschedule_interview

1. Cambia inmediatamente el booking a `RESCHEDULED`.
2. Después comprueba `nextSlot`.
3. Sin slot, pausa el flujo y deja la reserva cerrada.
4. Con slot, cambia al candidato a `SCHEDULING` y lo ofrece.
5. La nueva reserva solo se crea tras una confirmación posterior.

Reproduce la misma inconsistencia del motor alternativo: usa `RESCHEDULED` como solicitud, aunque lifecycle lo trata como cierre y el objetivo lo reserva para reprogramación completada.

### confirm_attendance

Cambia por ID a `CONFIRMED`, guarda la respuesta, cierra la ventana y responde con el horario.

### Confirmación inicial del horario

1. Ejecuta `cancelCandidateBookings()`.
2. Llama a `createBooking()`.
3. Cambia al candidato a `SCHEDULED`.
4. Envía confirmación.

Riesgos:

- no hay transacción común;
- `createBooking()` repite el reemplazo;
- un fallo de creación puede dejar al candidato sin reserva activa;
- dentro de una rama que exige `SCHEDULING`, la condición que escogería `RESCHEDULED` normalmente termina usando `CANCELLED`.

## admin.js

### Definición administrativa de activo

El panel considera activos `SCHEDULED`, `CONFIRMED` y `RESCHEDULED`. Esto contradice lifecycle, scheduler y reminder, donde `RESCHEDULED` está cerrado.

### Cambio manual de estado

`/interviews/:id/status` permite destinos:

- `CONFIRMED`;
- `ATTENDED`;
- `NO_RESPONSE`;
- `NO_SHOW`;
- `CANCELLED`;
- `RESCHEDULED`.

Actualiza por ID y crea `CandidateAdminEvent` con origen y destino, pero no valida el estado de origen. Puede producir saltos como `CANCELLED → CONFIRMED` o `ATTENDED → NO_RESPONSE`.

La autoridad compartida no expondrá `updateBooking(status)`. Usará contratos explícitos:

- `confirmBookingAttendance()`;
- `markBookingAttended()`;
- `markBookingNoResponse()`;
- `markBookingNoShow()`;
- `cancelBooking()`;
- `completeBookingReschedule()`;
- un contrato excepcional de corrección administrativa con actor, motivo, estados permitidos y auditoría obligatoria.

### Recordatorio manual

El panel admite reminder para su lista “activa”; por incluir `RESCHEDULED`, puede contactar una reserva que lifecycle considera cerrada.

### Eliminación exacta

`/interviews/:id/delete`:

- elimina físicamente el booking dentro de una transacción;
- busca otra reserva “activa” según la lista administrativa;
- si no existe, cambia al candidato a `SCHEDULING`.

### Eliminación por ciclo de vida del candidato

La eliminación administrativa completa del candidato ejecuta `interviewBooking.deleteMany({ candidateId })` dentro de la misma transacción que elimina sus demás datos.

### Política de eliminación para la primera migración

La primera autoridad preservará el comportamiento actual mediante dos contratos explícitos, no mediante una transición genérica:

- `deleteBookingForAdministrativeCorrection()` para la ruta exacta;
- `deleteBookingsForCandidateLifecycle()` para la eliminación completa del candidato.

Ambos aceptarán `tx` existente y exigirán contexto administrativo. La eliminación exacta deberá producir auditoría antes o dentro de la misma unidad coordinada.

No se reemplazará silenciosamente por `CANCELLED`, porque eso cambiaría el runtime y la semántica de datos. Antes de la fase SaaS se decidirá por separado si:

- se mantiene borrado físico bajo política de retención;
- se incorpora borrado lógico;
- se crea historial inmutable de bookings;
- se anonimiza información al eliminar candidatos.

Hasta tomar esa decisión, la eliminación física queda reservada a corrección administrativa o ciclo de vida completo, nunca a cancelación ordinaria.

### Asignación manual

1. Verifica slot ofrecible.
2. Abre una transacción.
3. Busca una reserva activa según la lista administrativa.
4. Invoca `cancelCandidateBookings(tx, ..., 'RESCHEDULED')`.
5. Crea la nueva reserva con `createBooking(tx, ...)`.
6. Fuera de la transacción, cambia al candidato a `SCHEDULED`, con fallback a `SCHEDULING`.

La reserva se reemplaza transaccionalmente, pero:

- si solo encuentra `RESCHEDULED`, el scheduler no lo modifica porque solo actúa sobre `SCHEDULED`/`CONFIRMED`;
- el paso del candidato queda fuera de la transacción;
- la auditoría también queda fuera.

## Inconsistencias confirmadas

### RESCHEDULED tiene significados incompatibles

- lifecycle, scheduler y reminder: cerrado;
- panel: activo y elegible para reminder;
- webhook y chat engine: solicitud sin reserva nueva;
- scheduler: reserva anterior realmente reemplazada.

La solución alineada con el objetivo es diferenciar:

- `RESCHEDULE_REQUESTED`: solicitud registrada, si se amplía Prisma;
- `RESCHEDULED`: reserva anterior reemplazada por una nueva válida.

No se cambiará Prisma en este PR.

### Dos rutas cierran antes de reemplazar

Webhook y chat engine asignan `RESCHEDULED` antes de disponibilidad o nueva reserva.

### La creación conversacional no es atómica

El webhook cancela y crea sin transacción, aunque `createBooking()` ya hace reemplazo interno.

### El panel permite transiciones arbitrarias

Valida destino, no origen ni transición.

### No existe historial unificado

`CandidateAdminEvent` registra cambios manuales, pero las transiciones automáticas no comparten historial con actor, motivo, fuente y reserva reemplazante.

## Matriz observada

| Origen | Acción | Destino o efecto | Escritor | Atomicidad |
| --- | --- | --- | --- | --- |
| sin reserva exacta | aceptar horario | nueva `SCHEDULED` | scheduler/webhook/admin | depende del consumidor |
| `SCHEDULED`/`CONFIRMED` | crear reemplazo | anterior `RESCHEDULED`, nueva `SCHEDULED` | scheduler | solo con `tx` externo |
| activo | cancelar por candidato | `CANCELLED` | scheduler | `updateMany` único |
| ventana abierta | cerrar duplicado | cierre de ventana | reminder | condicional por booking |
| activo | reclamar reminder | fecha + cierre | reminder | condicional por booking |
| `SCHEDULED` | sin respuesta | `NO_RESPONSE` | reminder | condicional por booking |
| activo | confirmar asistencia | `CONFIRMED` | webhook/chat engine | actualización única |
| activo | cancelar entrevista | `CANCELLED` | webhook/chat engine | booking y candidato separados |
| activo | pedir reprogramación | `RESCHEDULED` sin reemplazo | webhook/chat engine | inconsistente |
| cualquier estado visible | acción manual | uno de seis destinos | admin | sin guard de origen |
| booking existente | asignar manualmente | reemplazo + nueva `SCHEDULED` | admin/scheduler | booking en `tx`; candidato fuera |
| booking exacto | corregir/eliminar | borrado físico | admin | transaccional |
| candidato eliminado | limpiar bookings | borrado físico por candidato | admin | transaccional |

## Contratos objetivo

`InterviewBookingStateService` no expondrá una actualización genérica. Contratos previstos:

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
- `correctBookingStatusAdministratively()` con transiciones limitadas y auditoría;
- `deleteBookingForAdministrativeCorrection()`;
- `deleteBookingsForCandidateLifecycle()`.

Cada contrato declarará booking exacto o criterio permitido, origen, destino, campos adicionales, actor, motivo, idempotencia, concurrencia, compatibilidad con Prisma/`tx` y efectos coordinados sobre candidato y reminders.

## Pruebas requeridas antes de migrar runtime

1. Reserva inicial → `SCHEDULED`.
2. Repetición exacta no duplica.
3. Fallo del reemplazo no cierra la anterior.
4. Solicitud sin slot no produce `RESCHEDULED` definitivo.
5. Reprogramación completada crea nueva y cierra anterior atómicamente.
6. No quedan dos reservas activas canónicas.
7. Confirmación respeta origen y ventana temporal.
8. `NO_RESPONSE` no parte de estados cerrados ni `CONFIRMED`.
9. Reserva cerrada no recibe reminder automático ni manual.
10. Acción administrativa inválida se rechaza.
11. Corrección administrativa registra actor y motivo.
12. Eliminación exacta solo funciona bajo contrato administrativo.
13. Eliminación por candidato reutiliza el `tx` existente.
14. Servicio funciona con Prisma principal y `tx`.
15. Respuesta tardía queda trazada con hora real.

## Orden de trabajo

1. Convertir el inventario en matriz canónica de transiciones permitidas.
2. Añadir pruebas negativas sin cambiar consumidores.
3. Crear el esqueleto de `InterviewBookingStateService`.
4. Migrar scheduler y hacer atómico el reemplazo.
5. Migrar reminder conservando filtros condicionales.
6. Migrar admin con acciones y eliminaciones explícitas auditadas.
7. Migrar chat engine heredado.
8. Migrar webhook al final, preservando replays.
9. Diseñar historial, retención y `tenantId` en fases separadas.
10. Marcar canónico solo con un escritor en el manifiesto.

## Fuera de alcance

- migraciones Prisma o `tenantId`;
- cambiar anticipación u horizonte;
- cambiar textos enviados;
- implementar outbox;
- modificar candidatos, vacantes, consentimiento, CV o permisos;
- tocar lógica relacionada con género.
