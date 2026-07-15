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

## Autoridad y consumidores migrados

| Componente | Responsabilidad conservada | Persistencia de reservas |
| --- | --- | --- |
| `src/services/interviewBookingStateService.js` | transiciones, creación, reemplazo, recordatorios y eliminaciones | Único escritor canónico |
| `src/services/interviewScheduler.js` | disponibilidad, cupos, anticipación y selección de slots | Delega en la autoridad |
| `src/services/reminder.js` | ventanas, dispatchers, WhatsApp y jobs | Delega en la autoridad |
| `src/routes/admin.js` | permisos, auditoría y acciones humanas | Delega en la autoridad |
| `src/services/chatEngine.js` | clasificación y respuestas del motor alternativo | Delega en la autoridad |
| `src/routes/webhook.js` | interpretación, silencios, textos, candidato y payloads | Delega en la autoridad |

No quedan escrituras directas de `InterviewBooking` fuera de `InterviewBookingStateService`. El manifiesto y su scanner bloquean regresiones.

## Invariantes objetivo## Invariantes objetivo

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

### Estado migrado

`handleAppointmentIntentDirectly()` conserva la carga de la reserva activa, la clasificación de intención y los textos existentes, pero delega confirmación, cancelación y solicitud de reprogramación en `applyInterviewReminderResponse()`.

- confirmación: la autoridad cambia a `CONFIRMED`, guarda la respuesta y cierra la ventana;
- cancelación: la autoridad cambia a `CANCELLED`; después el motor limpia el recordatorio del candidato;
- reprogramación: la autoridad guarda la solicitud y cierra la ventana sin cambiar `SCHEDULED` o `CONFIRMED`; después el motor busca una alternativa y mueve al candidato a `SCHEDULING`;
- concurrencia: si la comparación por ID y estado devuelve `count=0`, el motor no informa una transición como exitosa ni ejecuta efectos secundarios.

`chatEngine.js` deja de escribir `InterviewBooking` directamente. El webhook queda como única frontera directa pendiente.

## webhook.js

### Estado migrado

El bloque de agenda conserva clasificación, resolución de slots, textos, payloads, pausas y efectos del candidato, pero delega toda persistencia de reservas:

- `cancel_interview`: aplica la transición condicional por ID y estado; después limpia el recordatorio del candidato;
- `reschedule_interview`: registra respuesta y cierre de ventana sin cambiar el estado activo; después pausa u ofrece una alternativa;
- `confirm_attendance`: aplica `CONFIRMED` mediante comparación condicional antes de responder;
- aceptación inicial: mantiene el scheduling guard y llama una sola vez a `createBooking(prisma, ...)`; la autoridad reutiliza la reserva exacta o sustituye y crea dentro de su transacción serializable;
- reserva ausente o carrera: registra silencio intencional y termina sin respuesta de éxito ni efectos posteriores.

El webhook deja de llamar `cancelCandidateBookings()` antes de crear y ya no ejecuta escrituras Prisma directas sobre `InterviewBooking`.

## admin.js## admin.js

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

1. Verifica que el slot siga siendo ofrecible.
2. Llama una sola vez a `createBooking(prisma, ...)` con el cliente Prisma principal.
3. La autoridad reutiliza la reserva exacta o reemplaza las activas y crea la nueva dentro de su propia transacción `Serializable`.
4. Fuera de la transacción de reservas, cambia al candidato a `SCHEDULED`, con fallback a `SCHEDULING`.
5. Registra la auditoría administrativa.

La ruta ya no abre una transacción externa, no preconsulta `InterviewBooking` y no llama `cancelCandidateBookings(..., 'RESCHEDULED')`. Esto conserva en la autoridad el rollback conjunto, los reintentos `P2034` y la recuperación exacta ante `P2002`. El paso del candidato y la auditoría permanecen fuera de la transacción de reservas para conservar el comportamiento existente.

## Estado consolidado y deuda restante

### Autoridad canónica completada

Todas las transiciones vigentes pasan por `InterviewBookingStateService`. `RESCHEDULED` solo se asigna durante una sustitución que crea una reserva válida; una solicitud conserva la reserva activa. La creación inicial y el reemplazo son atómicos, y las respuestas comparan el booking exacto y su estado leído.

### Deuda separada

El modelo aún no incorpora historial inmutable, actor y motivo estructurados para todas las transiciones, reserva reemplazante explícita, retención ni `tenantId`. Esa evolución no altera la autoridad canónica alcanzada.

## Matriz canónica vigente

| Origen | Acción | Destino o efecto | Autoridad | Atomicidad o guard |
| --- | --- | --- | --- | --- |
| sin reserva exacta | aceptar horario | nueva `SCHEDULED` | autoridad | transacción serializable |
| `SCHEDULED`/`CONFIRMED` | crear reemplazo | anterior `RESCHEDULED`, nueva `SCHEDULED` | autoridad | cierre y creación atómicos |
| activo | confirmar asistencia | `CONFIRMED` | autoridad | condicional por ID y estado |
| activo | cancelar entrevista | `CANCELLED` | autoridad | condicional por ID y estado |
| activo | pedir reprogramación | conserva estado y registra respuesta | autoridad | condicional por ID y estado |
| ventana abierta | reclamar o cerrar recordatorio | fechas y cierre | autoridad | filtros idempotentes |
| `SCHEDULED` | sin respuesta | `NO_RESPONSE` | autoridad | booking exacto y ventana |
| estado permitido | acción administrativa | destino validado | autoridad | origen validado y auditoría externa |
| booking exacto | corregir/eliminar | borrado físico | autoridad | coincidencia booking/candidato |
| candidato eliminado | limpiar bookings | borrado por candidato | autoridad | reutiliza `tx` |

## Contratos objetivo## Contratos objetivo

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

## Orden de trabajo completado

1. Matriz canónica de transiciones: completada.
2. Pruebas negativas: completadas.
3. Autoridad compartida: completada.
4. Scheduler y reemplazo atómico: completados.
5. Recordatorios: migrados.
6. Administración: migrada.
7. Chat engine: migrado.
8. Webhook: migrado preservando replays.
9. Historial, retención y `tenantId`: evolución separada.
10. `InterviewBooking`: marcado canónico con un único escritor.

## Fuera de alcance## Fuera de alcance

- migraciones Prisma o `tenantId`;
- cambiar anticipación u horizonte;
- cambiar textos enviados;
- implementar outbox;
- modificar candidatos, vacantes, consentimiento, CV o permisos;
- tocar lógica relacionada con género.
