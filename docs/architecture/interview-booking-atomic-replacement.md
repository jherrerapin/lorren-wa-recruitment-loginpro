# Reemplazo atómico de reservas de entrevista

## Contexto

Este documento complementa el inventario de transiciones de `InterviewBooking` y corrige la descripción inicial de `InterviewBookingStateService` introducida en #454.

La base de datos protege dos invariantes mediante índices únicos parciales:

- un candidato solo puede tener una reserva activa;
- una misma cita activa exacta no puede duplicarse.

Por esa razón, no es posible insertar una segunda reserva `SCHEDULED` mientras la anterior siga activa.

La garantía canónica es:

> La reserva anterior y su reemplazo cambian como una sola unidad: otros procesos nunca observan el cierre anterior sin la nueva reserva, y cualquier fallo revierte ambos cambios.

## Contrato de creación y reemplazo

`createScheduledInterviewBooking()` conserva una reserva activa exacta cuando ya coincide en:

- candidato;
- vacante;
- slot;
- fecha programada.

Cuando no existe una coincidencia exacta y sí hay una reserva activa:

1. consulta y valida las reservas activas del candidato;
2. valida `REQUEST_RESCHEDULE` mediante la política canónica;
3. dentro de la misma transacción cambia las reservas anteriores a `RESCHEDULED`;
4. crea la nueva reserva como `SCHEDULED`;
5. valida `COMPLETE_RESCHEDULE` con el ID real del reemplazo;
6. confirma conjuntamente cierre y creación.

El orden interno respeta `InterviewBooking_one_active_per_candidate_idx`. El cierre previo no es visible fuera de la transacción. Si la creación o la validación posterior falla, PostgreSQL revierte el cierre y la reserva anterior permanece activa.

Cuando no existe una reserva activa, la autoridad valida `CREATE_INITIAL`, crea la reserva y no ejecuta un `updateMany` redundante.

Con el cliente Prisma principal, los pasos se ejecutan en una transacción interactiva con aislamiento `Serializable`. Si el consumidor ya entrega un cliente `tx`, se reutiliza esa transacción y no se abre otra.

## Concurrencia

Los conflictos serializables `P2034` se reintentan de forma acotada. Ante un conflicto único `P2002`, la recuperación solo acepta una reserva activa que coincida exactamente con candidato, vacante, slot y fecha. Una reserva de otro horario no se considera éxito.

## Estados permitidos

- creación o reemplazo: la reserva anterior solo puede terminar en `RESCHEDULED`;
- cancelación ordinaria: la reserva solo puede terminar en `CANCELLED`;
- solicitud de reprogramación: conserva el estado activo y no escribe `RESCHEDULED` todavía.

Los destinos arbitrarios quedan rechazados. La matriz de transiciones proviene de `interviewBookingTransitionPolicy.js`.

## Compatibilidad temporal

`interviewScheduler.js` conserva sus funciones públicas mientras migran los consumidores heredados:

- `createBooking()` delega la creación o reemplazo;
- `cancelCandidateBookings(..., 'CANCELLED')` ejecuta cancelación real;
- `cancelCandidateBookings(..., 'RESCHEDULED')` representa una solicitud y no cierra la reserva.

La asignación manual del panel llama `createBooking()` una sola vez con el cliente Prisma principal. No abre una transacción externa, no preconsulta reservas activas y no solicita una reprogramación redundante. Por ello, el reemplazo usa directamente aislamiento `Serializable`, rollback conjunto, reintentos `P2034` y recuperación exacta `P2002` de la autoridad.

Las responsabilidades administrativas de `InterviewBooking` están migradas. Webhook y `chatEngine` continúan como las dos fronteras directas pendientes bajo #453 y #421; por esa razón el agregado todavía permanece en consolidación.
