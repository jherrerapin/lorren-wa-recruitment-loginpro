# Reemplazo atómico de reservas de entrevista

## Contexto

Este documento complementa el inventario de transiciones de `InterviewBooking` y corrige la descripción inicial de `InterviewBookingStateService` introducida en #454.

La invariante canónica es:

> Una reserva anterior solo puede pasar a `RESCHEDULED` cuando ya existe una reserva reemplazante válida dentro de la misma unidad atómica.

## Contrato de creación y reemplazo

`createScheduledInterviewBooking()` conserva una reserva activa exacta cuando ya coincide en:

- candidato;
- vacante;
- slot;
- fecha programada.

Cuando no existe una coincidencia exacta:

1. consulta las reservas activas del candidato;
2. valida `CREATE_INITIAL` o `REQUEST_RESCHEDULE` mediante la política canónica;
3. crea la nueva reserva como `SCHEDULED`;
4. valida `COMPLETE_RESCHEDULE` con el ID real del reemplazo;
5. cambia a `RESCHEDULED` únicamente las reservas activas anteriores, excluyendo la nueva por ID.

Con el cliente Prisma principal, los pasos se ejecutan en una transacción interactiva con aislamiento `Serializable`. Si el consumidor ya entrega un cliente `tx`, se reutiliza esa transacción y no se abre otra.

Un fallo al crear el reemplazo o cerrar la reserva anterior revierte toda la unidad. La reserva anterior permanece activa.

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
- `cancelCandidateBookings(..., 'RESCHEDULED')` registra conceptualmente una solicitud y no cierra la reserva.

Webhook, recordatorios, panel administrativo y motor conversacional todavía tienen transiciones directas pendientes de migración. Este documento no declara `InterviewBooking` como agregado completamente canónico.
