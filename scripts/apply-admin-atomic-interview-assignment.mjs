import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

function write(path, content) {
  fs.writeFileSync(path, content, 'utf8');
}

function replaceOnce(source, expected, replacement, label) {
  const first = source.indexOf(expected);
  const second = source.indexOf(expected, first + expected.length);
  if (first < 0 || second >= 0) {
    throw new Error(`${label}_match_invalid:${first}:${second}`);
  }
  return source.replace(expected, replacement);
}

const adminPath = 'src/routes/admin.js';
let admin = read(adminPath);
admin = replaceOnce(
  admin,
  `import { listOfferableSlots, createBooking, cancelCandidateBookings, formatInterviewDate } from '../services/interviewScheduler.js';`,
  `import { listOfferableSlots, createBooking, formatInterviewDate } from '../services/interviewScheduler.js';`,
  'admin_scheduler_import'
);

const assignmentNeedle = `      await prisma.$transaction(async (tx) => {
        const activeBooking = await tx.interviewBooking.findFirst({
          where: {
            candidateId: candidate.id,
            status: { in: ACTIVE_BOOKING_STATUSES }
          },
          select: { id: true }
        });

        if (activeBooking) {
          await cancelCandidateBookings(tx, candidate.id, 'RESCHEDULED');
        }

        await createBooking(
          tx,
          candidate.id,
          candidate.vacancyId,
          chosenOffer.slot.id,
          chosenOffer.date,
          !chosenOffer.windowOk
        );
      });`;
const assignmentReplacement = `      await createBooking(
        prisma,
        candidate.id,
        candidate.vacancyId,
        chosenOffer.slot.id,
        chosenOffer.date,
        !chosenOffer.windowOk
      );`;
admin = replaceOnce(admin, assignmentNeedle, assignmentReplacement, 'admin_atomic_assignment');
write(adminPath, admin);

const mapPath = 'docs/architecture/state-authority-map.md';
let map = read(mapPath);
map = replaceOnce(
  map,
  `\`InterviewBookingStateService\` concentra ya la creación, el reemplazo, la cancelación, las mutaciones operativas de recordatorios, las transiciones manuales y las eliminaciones físicas. \`interviewScheduler.js\` conserva disponibilidad, cupos, anticipación mínima y selección de slots; \`reminder.js\` conserva ventanas, dispatchers, mensajes, WhatsApp y jobs; \`admin.js\` conserva permisos, acceso, auditoría y las transacciones de ciclo de vida. Estas fronteras delegan la persistencia de reservas en la autoridad canónica.`,
  `\`InterviewBookingStateService\` concentra ya la creación, el reemplazo, la cancelación, las mutaciones operativas de recordatorios, las transiciones manuales y las eliminaciones físicas. \`interviewScheduler.js\` conserva disponibilidad, cupos, anticipación mínima y selección de slots; \`reminder.js\` conserva ventanas, dispatchers, mensajes, WhatsApp y jobs; \`admin.js\` conserva permisos, acceso, auditoría y transacciones de ciclo de vida ajenas al reemplazo. La asignación manual entrega el cliente Prisma raíz para que la autoridad controle directamente la transacción serializable y sus reintentos.`,
  'map_consolidation_intro'
);
map = replaceOnce(
  map,
  `- la limpieza por ciclo de vida elimina reservas únicamente por candidato y reutiliza la transacción recibida.`,
  `- la limpieza por ciclo de vida elimina reservas únicamente por candidato y reutiliza la transacción recibida;\n- la asignación manual valida primero la oferta y después delega una sola creación o sustitución atómica con el cliente Prisma raíz.`,
  'map_assignment_invariant'
);
map = replaceOnce(
  map,
  `\`reminder.js\` delega cierre de ventana, reclamación idempotente, \`NO_RESPONSE\` y respuestas interpretadas. El panel delega transiciones manuales, eliminación individual y limpieza por ciclo de vida; conserva permisos, acceso, auditoría, transacciones y el orden mensajes → reservas → candidato. \`admin.js\` deja de ser escritor directo de \`InterviewBooking\`. El número total de escritores baja a tres: webhook, \`chatEngine\` y la autoridad canónica.`,
  `\`reminder.js\` delega cierre de ventana, reclamación idempotente, \`NO_RESPONSE\` y respuestas interpretadas. El panel delega transiciones manuales, eliminación individual, limpieza por ciclo de vida y asignación manual; conserva permisos, acceso, auditoría y el orden mensajes → reservas → candidato. \`admin.js\` no escribe \`InterviewBooking\` ni coordina un cierre previo redundante. El número total de escritores permanece en tres: webhook, \`chatEngine\` y la autoridad canónica.`,
  'map_admin_completion'
);
map = replaceOnce(
  map,
  `Después de extraer scheduler, recordatorios, transiciones manuales y eliminaciones físicas administrativas, \`InterviewBooking\` todavía se modifica directamente desde webhook y un motor conversacional alternativo. La asignación manual del panel ya delega sus escrituras, aunque su orquestación conserva una cancelación previa redundante que debe migrarse al reemplazo atómico. Deben centralizarse gradualmente invariantes como:`,
  `Después de extraer scheduler, recordatorios, transiciones manuales, eliminaciones físicas y asignación manual, \`InterviewBooking\` todavía se modifica directamente desde webhook y un motor conversacional alternativo. Las responsabilidades administrativas quedaron migradas; las dos fronteras restantes continúan bajo #453 y #421. Deben centralizarse gradualmente invariantes como:`,
  'map_remaining_boundaries'
);
write(mapPath, map);

const atomicPath = 'docs/architecture/interview-booking-atomic-replacement.md';
let atomic = read(atomicPath);
atomic = replaceOnce(
  atomic,
  `## Compatibilidad temporal

\`interviewScheduler.js\` conserva sus funciones públicas mientras migran los consumidores heredados:

- \`createBooking()\` delega la creación o reemplazo;
- \`cancelCandidateBookings(..., 'CANCELLED')\` ejecuta cancelación real;
- \`cancelCandidateBookings(..., 'RESCHEDULED')\` representa una solicitud y no cierra la reserva.

Webhook, recordatorios, panel administrativo y motor conversacional todavía tienen transiciones directas pendientes de migración. Este documento no declara \`InterviewBooking\` como agregado completamente canónico.`,
  `## Compatibilidad temporal

\`interviewScheduler.js\` conserva sus funciones públicas mientras migran los consumidores heredados:

- \`createBooking()\` delega la creación o reemplazo;
- \`cancelCandidateBookings(..., 'CANCELLED')\` ejecuta cancelación real;
- \`cancelCandidateBookings(..., 'RESCHEDULED')\` representa una solicitud y no cierra la reserva.

La asignación manual del panel llama \`createBooking()\` una sola vez con el cliente Prisma principal. No abre una transacción externa, no preconsulta reservas activas y no solicita una reprogramación redundante. Por ello, el reemplazo usa directamente aislamiento \`Serializable\`, rollback conjunto, reintentos \`P2034\` y recuperación exacta \`P2002\` de la autoridad.

Las responsabilidades administrativas de \`InterviewBooking\` están migradas. Webhook y \`chatEngine\` continúan como las dos fronteras directas pendientes bajo #453 y #421; por esa razón el agregado todavía permanece en consolidación.`,
  'atomic_compatibility'
);
write(atomicPath, atomic);

const inventoryPath = 'docs/architecture/interview-booking-transition-inventory.md';
let inventory = read(inventoryPath);
inventory = replaceOnce(
  inventory,
  `### Asignación manual

1. Verifica slot ofrecible.
2. Abre una transacción.
3. Busca una reserva activa según la lista administrativa.
4. Invoca \`cancelCandidateBookings(tx, ..., 'RESCHEDULED')\`.
5. Crea la nueva reserva con \`createBooking(tx, ...)\`.
6. Fuera de la transacción, cambia al candidato a \`SCHEDULED\`, con fallback a \`SCHEDULING\`.

La reserva se reemplaza transaccionalmente, pero:

- si solo encuentra \`RESCHEDULED\`, el scheduler no lo modifica porque solo actúa sobre \`SCHEDULED\`/\`CONFIRMED\`;
- el paso del candidato queda fuera de la transacción;
- la auditoría también queda fuera.`,
  `### Asignación manual

1. Verifica que el slot siga siendo ofrecible.
2. Llama una sola vez a \`createBooking(prisma, ...)\` con el cliente Prisma principal.
3. La autoridad reutiliza la reserva exacta o reemplaza las activas y crea la nueva dentro de su propia transacción \`Serializable\`.
4. Fuera de la transacción de reservas, cambia al candidato a \`SCHEDULED\`, con fallback a \`SCHEDULING\`.
5. Registra la auditoría administrativa.

La ruta ya no abre una transacción externa, no preconsulta \`InterviewBooking\` y no llama \`cancelCandidateBookings(..., 'RESCHEDULED')\`. Esto conserva en la autoridad el rollback conjunto, los reintentos \`P2034\` y la recuperación exacta ante \`P2002\`. El paso del candidato y la auditoría permanecen fuera de la transacción de reservas para conservar el comportamiento existente.`,
  'inventory_admin_assignment'
);
write(inventoryPath, inventory);
