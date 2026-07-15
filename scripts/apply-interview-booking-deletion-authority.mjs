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

const servicePath = 'src/services/interviewBookingStateService.js';
let service = read(servicePath);
if (!service.includes('export async function deleteAdministrativeInterviewBooking')) {
  service = `${service.trimEnd()}\n\nexport async function deleteAdministrativeInterviewBooking(prisma, input = {}) {
  requireBookingClient(prisma, ['deleteMany'], 'interview_admin_delete');
  const deleteInput = requireInputObject(input, 'interview_admin_delete_input');
  const bookingId = requireNonEmptyString(deleteInput.bookingId, 'booking_id');
  const candidateId = requireNonEmptyString(deleteInput.candidateId, 'candidate_id');

  return prisma.interviewBooking.deleteMany({
    where: {
      id: bookingId,
      candidateId
    }
  });
}

export async function deleteCandidateInterviewBookings(prisma, input = {}) {
  requireBookingClient(prisma, ['deleteMany'], 'interview_candidate_cleanup');
  const cleanupInput = requireInputObject(input, 'interview_candidate_cleanup_input');
  const candidateId = requireNonEmptyString(cleanupInput.candidateId, 'candidate_id');

  return prisma.interviewBooking.deleteMany({
    where: { candidateId }
  });
}\n`;
}
write(servicePath, service);

const adminPath = 'src/routes/admin.js';
let admin = read(adminPath);
admin = replaceOnce(
  admin,
  `import {
  ACTIVE_INTERVIEW_BOOKING_STATUSES,
  applyAdministrativeInterviewBookingAction
} from '../services/interviewBookingStateService.js';`,
  `import {
  ACTIVE_INTERVIEW_BOOKING_STATUSES,
  applyAdministrativeInterviewBookingAction,
  deleteAdministrativeInterviewBooking,
  deleteCandidateInterviewBookings
} from '../services/interviewBookingStateService.js';`,
  'admin_interview_authority_import'
);

const individualDeleteNeedle = `    await prisma.$transaction(async (tx) => {
      await tx.interviewBooking.delete({
        where: { id: booking.id }
      });

      const remainingActiveBooking = await tx.interviewBooking.findFirst({
        where: {
          candidateId: booking.candidateId,
          status: { in: ACTIVE_BOOKING_STATUSES }
        },
        select: { id: true }
      });

      if (!remainingActiveBooking) {
        await tx.candidate.update({
          where: { id: booking.candidateId },
          data: {
            currentStep: ConversationStep.SCHEDULING
          }
        });
      }
    });

    return res.redirect(withFlashMessage(returnTo, 'success', 'Agendamiento eliminado correctamente.'));`;
const individualDeleteReplacement = `    const deletionResult = await prisma.$transaction(async (tx) => {
      const deletion = await deleteAdministrativeInterviewBooking(tx, {
        bookingId: booking.id,
        candidateId: booking.candidateId
      });

      if (deletion.count === 0) {
        return { deleted: false };
      }

      const remainingActiveBooking = await tx.interviewBooking.findFirst({
        where: {
          candidateId: booking.candidateId,
          status: { in: ACTIVE_BOOKING_STATUSES }
        },
        select: { id: true }
      });

      if (!remainingActiveBooking) {
        await tx.candidate.update({
          where: { id: booking.candidateId },
          data: {
            currentStep: ConversationStep.SCHEDULING
          }
        });
      }

      return { deleted: true };
    });

    if (!deletionResult.deleted) {
      return res.redirect(withFlashMessage(
        returnTo,
        'error',
        'El agendamiento cambió mientras se procesaba la eliminación. Actualiza la página e intenta nuevamente.'
      ));
    }

    return res.redirect(withFlashMessage(returnTo, 'success', 'Agendamiento eliminado correctamente.'));`;
admin = replaceOnce(admin, individualDeleteNeedle, individualDeleteReplacement, 'admin_individual_delete_route');

admin = replaceOnce(
  admin,
  `      await tx.interviewBooking.deleteMany({
        where: { candidateId: candidate.id }
      });`,
  `      await deleteCandidateInterviewBookings(tx, {
        candidateId: candidate.id
      });`,
  'admin_candidate_cleanup'
);
write(adminPath, admin);

const testPath = 'test/adminInterviewBookingAuthority.test.js';
let testSource = read(testPath);
testSource = replaceOnce(
  testSource,
  `  assert.ok(
    route.indexOf('deletion.count === 0') < route.indexOf('remainingActiveBooking'),
    'La carrera debe resolverse antes de buscar reservas activas restantes.'
  );
  assert.ok(
    route.indexOf('remainingActiveBooking') < route.indexOf('tx.candidate.update'),
    'El paso solo se reajusta después de comprobar reservas activas restantes.'
  );`,
  `  const deletionIndex = route.indexOf('deletion.count === 0');
  const remainingIndex = route.indexOf('remainingActiveBooking');
  const updateIndex = route.indexOf('tx.candidate.update');

  assert.ok(deletionIndex >= 0, 'No se encontró "deletion.count === 0"');
  assert.ok(remainingIndex >= 0, 'No se encontró "remainingActiveBooking"');
  assert.ok(updateIndex >= 0, 'No se encontró "tx.candidate.update"');
  assert.ok(
    deletionIndex < remainingIndex,
    'La carrera debe resolverse antes de buscar reservas activas restantes.'
  );
  assert.ok(
    remainingIndex < updateIndex,
    'El paso solo se reajusta después de comprobar reservas activas restantes.'
  );`,
  'admin_structural_index_assertions'
);
write(testPath, testSource);

const manifestPath = 'docs/architecture/state-authority-manifest.json';
let manifest = read(manifestPath);
manifest = replaceOnce(
  manifest,
  `        { "path": "src/routes/admin.js", "role": "admin", "reason": "Eliminación física administrativa y limpieza de reservas durante el ciclo de vida del candidato; las transiciones manuales delegan en la autoridad canónica" },\n`,
  '',
  'manifest_remove_admin_writer'
);
manifest = replaceOnce(
  manifest,
  `{ "path": "src/services/interviewBookingStateService.js", "role": "canonical", "reason": "Creación, reemplazo, cancelación, recordatorios, respuestas y transiciones manuales de reservas" }`,
  `{ "path": "src/services/interviewBookingStateService.js", "role": "canonical", "reason": "Creación, reemplazo, cancelación, recordatorios, respuestas, transiciones manuales y eliminaciones físicas de reservas" }`,
  'manifest_authority_reason'
);
write(manifestPath, manifest);

const mapPath = 'docs/architecture/state-authority-map.md';
let map = read(mapPath);
map = replaceOnce(
  map,
  `| \`InterviewBooking\` | 4 | Crítico | En consolidación | \`InterviewBookingStateService\` |`,
  `| \`InterviewBooking\` | 3 | Crítico | En consolidación | \`InterviewBookingStateService\` |`,
  'map_writer_count'
);
map = replaceOnce(
  map,
  `\`InterviewBookingStateService\` concentra ya la creación, el reemplazo, la cancelación, las mutaciones operativas de recordatorios y las transiciones manuales del panel. \`interviewScheduler.js\` conserva disponibilidad, cupos, anticipación mínima y selección de slots; \`reminder.js\` conserva ventanas, dispatchers, mensajes, WhatsApp y jobs; \`admin.js\` conserva permisos, acceso y auditoría. Estas fronteras delegan las transiciones ordinarias en la autoridad canónica.`,
  `\`InterviewBookingStateService\` concentra ya la creación, el reemplazo, la cancelación, las mutaciones operativas de recordatorios, las transiciones manuales y las eliminaciones físicas. \`interviewScheduler.js\` conserva disponibilidad, cupos, anticipación mínima y selección de slots; \`reminder.js\` conserva ventanas, dispatchers, mensajes, WhatsApp y jobs; \`admin.js\` conserva permisos, acceso, auditoría y las transacciones de ciclo de vida. Estas fronteras delegan la persistencia de reservas en la autoridad canónica.`,
  'map_consolidation_intro'
);
map = replaceOnce(
  map,
  `- el recordatorio manual solo admite \`SCHEDULED\` y \`CONFIRMED\`.`,
  `- el recordatorio manual solo admite \`SCHEDULED\` y \`CONFIRMED\`;\n- la eliminación individual exige coincidencia exacta por reserva y candidato;\n- la limpieza por ciclo de vida elimina reservas únicamente por candidato y reutiliza la transacción recibida.`,
  'map_invariants'
);
map = replaceOnce(
  map,
  `\`reminder.js\` delega cierre de ventana, reclamación idempotente, \`NO_RESPONSE\` y respuestas interpretadas. El panel delega sus transiciones manuales y mantiene una reserva activa ante una solicitud de reprogramación. \`admin.js\` continúa declarado como escritor únicamente por la eliminación física exacta y la limpieza al eliminar candidatos. El número total de escritores permanece en cuatro: administración, webhook, \`chatEngine\` y la autoridad canónica.`,
  `\`reminder.js\` delega cierre de ventana, reclamación idempotente, \`NO_RESPONSE\` y respuestas interpretadas. El panel delega transiciones manuales, eliminación individual y limpieza por ciclo de vida; conserva permisos, acceso, auditoría, transacciones y el orden mensajes → reservas → candidato. \`admin.js\` deja de ser escritor directo de \`InterviewBooking\`. El número total de escritores baja a tres: webhook, \`chatEngine\` y la autoridad canónica.`,
  'map_admin_writer_status'
);
map = replaceOnce(
  map,
  `### 2. Las reservas conservan tres fronteras directas por migrar\n\nDespués de extraer scheduler, recordatorios y transiciones manuales, \`InterviewBooking\` todavía se modifica desde webhook, un motor conversacional alternativo y las dos eliminaciones físicas administrativas pendientes. Deben centralizarse gradualmente invariantes como:`,
  `### 2. Las reservas conservan dos fronteras directas por migrar\n\nDespués de extraer scheduler, recordatorios, transiciones manuales y eliminaciones físicas administrativas, \`InterviewBooking\` todavía se modifica directamente desde webhook y un motor conversacional alternativo. La asignación manual del panel ya delega sus escrituras, aunque su orquestación conserva una cancelación previa redundante que debe migrarse al reemplazo atómico. Deben centralizarse gradualmente invariantes como:`,
  'map_remaining_boundaries'
);
write(mapPath, map);
