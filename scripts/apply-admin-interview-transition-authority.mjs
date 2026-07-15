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

const serviceConstantsNeedle = `const ACTIVE_INTERVIEW_BOOKING_STATUSES_SET = new Set(ACTIVE_INTERVIEW_BOOKING_STATUSES);`;
const serviceConstantsReplacement = `const ACTIVE_INTERVIEW_BOOKING_STATUSES_SET = new Set(ACTIVE_INTERVIEW_BOOKING_STATUSES);
const KNOWN_INTERVIEW_BOOKING_STATUSES_SET = new Set(Object.values(InterviewBookingStatus));
const ADMIN_INTERVIEW_ACTION_TO_TRANSITION_ACTION = Object.freeze({
  confirmed: InterviewBookingTransitionAction.CONFIRM_ATTENDANCE,
  attended: InterviewBookingTransitionAction.MARK_ATTENDED,
  no_response: InterviewBookingTransitionAction.MARK_NO_RESPONSE,
  no_show: InterviewBookingTransitionAction.MARK_NO_SHOW,
  cancelled: InterviewBookingTransitionAction.CANCEL,
  rescheduled: InterviewBookingTransitionAction.REQUEST_RESCHEDULE
});`;
if (!service.includes('ADMIN_INTERVIEW_ACTION_TO_TRANSITION_ACTION')) {
  service = replaceOnce(service, serviceConstantsNeedle, serviceConstantsReplacement, 'service_constants');
}

const normalizeReminderNeedle = `function normalizeReminderResponseIntent(value) {
  const intent = requireNonEmptyString(value, 'interview_reminder_intent').toLowerCase();
  if (!REMINDER_RESPONSE_INTENTS.has(intent)) {
    throw new Error('interview_reminder_intent_not_allowed');
  }
  return intent;
}`;
const normalizeReminderReplacement = `${normalizeReminderNeedle}

function normalizeAdministrativeInterviewAction(value) {
  const action = requireNonEmptyString(value, 'interview_admin_action').toLowerCase();
  if (!Object.hasOwn(ADMIN_INTERVIEW_ACTION_TO_TRANSITION_ACTION, action)) {
    throw new Error('interview_admin_action_not_allowed');
  }
  return action;
}`;
if (!service.includes('function normalizeAdministrativeInterviewAction')) {
  service = replaceOnce(service, normalizeReminderNeedle, normalizeReminderReplacement, 'service_admin_action_normalizer');
}

if (!service.includes('export async function applyAdministrativeInterviewBookingAction')) {
  service = `${service.trimEnd()}\n\nexport async function applyAdministrativeInterviewBookingAction(prisma, input = {}) {
  requireBookingClient(prisma, ['updateMany'], 'interview_admin_transition');
  const transitionInput = requireInputObject(input, 'interview_admin_transition_input');
  const bookingId = requireNonEmptyString(transitionInput.bookingId, 'booking_id');
  const currentStatus = requireAllowedStatus(
    transitionInput.currentStatus,
    KNOWN_INTERVIEW_BOOKING_STATUSES_SET,
    'current_status'
  );
  const action = normalizeAdministrativeInterviewAction(transitionInput.action);
  const transition = assertAllowedTransition(evaluateInterviewBookingTransition({
    action: ADMIN_INTERVIEW_ACTION_TO_TRANSITION_ACTION[action],
    currentStatus
  }));
  const requiresReplacement = transition.metadata?.requiresReplacement === true;

  if (requiresReplacement) {
    return {
      count: 0,
      action,
      previousStatus: currentStatus,
      nextStatus: currentStatus,
      statusChanged: false,
      requiresReplacement: true,
      persisted: false
    };
  }

  const result = await prisma.interviewBooking.updateMany({
    where: {
      id: bookingId,
      status: currentStatus
    },
    data: {
      status: transition.nextStatus
    }
  });
  const persisted = result.count > 0;

  return {
    count: result.count,
    action,
    previousStatus: currentStatus,
    nextStatus: persisted ? transition.nextStatus : currentStatus,
    statusChanged: persisted && transition.statusChanged,
    requiresReplacement: false,
    persisted
  };
}\n`;
}
write(servicePath, service);

const adminPath = 'src/routes/admin.js';
let admin = read(adminPath);

const schedulerImport = `import { listOfferableSlots, createBooking, cancelCandidateBookings, formatInterviewDate } from '../services/interviewScheduler.js';`;
const authorityImport = `import {
  ACTIVE_INTERVIEW_BOOKING_STATUSES,
  applyAdministrativeInterviewBookingAction
} from '../services/interviewBookingStateService.js';`;
if (!admin.includes('applyAdministrativeInterviewBookingAction')) {
  admin = replaceOnce(admin, schedulerImport, `${schedulerImport}\n${authorityImport}`, 'admin_authority_import');
}

const statusRouteStart = `  router.post('/interviews/:id/status', express.urlencoded({ extended: true }), async (req, res) => {`;
const manualReminderStart = `  router.post('/interviews/:id/manual-reminder', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {`;
const statusStartIndex = admin.indexOf(statusRouteStart);
const statusEndIndex = admin.indexOf(manualReminderStart, statusStartIndex);
if (statusStartIndex < 0 || statusEndIndex < 0) {
  throw new Error(`admin_status_route_markers_invalid:${statusStartIndex}:${statusEndIndex}`);
}
const statusRouteReplacement = `  router.post('/interviews/:id/status', express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const action = normalizeString(req.body.action);
    const returnTo = safeAdminReturnPath(req.body.returnTo || req.get('referer') || '/admin');

    if (!action) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Acción de entrevista inválida.'));
    }

    const booking = await prisma.interviewBooking.findUnique({
      where: { id },
      select: { id: true, candidateId: true, status: true }
    });
    if (!booking) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Entrevista no encontrada.'));
    }
    if (!await ensureCandidateIdAccess(prisma, req, booking.candidateId, res, returnTo)) return;

    let transition;
    try {
      transition = await applyAdministrativeInterviewBookingAction(prisma, {
        bookingId: booking.id,
        currentStatus: booking.status,
        action
      });
    } catch (error) {
      console.error('[admin_interview_status_transition]', {
        bookingId: booking.id,
        currentStatus: booking.status,
        action,
        error: error?.message || error
      });
      const message = error?.message === 'interview_admin_action_not_allowed'
        ? 'Acción de entrevista inválida.'
        : String(error?.message || '').startsWith('interview_booking_transition_not_allowed:')
          ? 'Ese cambio no está permitido desde el estado actual de la entrevista.'
          : 'No fue posible actualizar la entrevista en este momento.';
      return res.redirect(withFlashMessage(returnTo, 'error', message));
    }

    if (transition.requiresReplacement) {
      return res.redirect(withFlashMessage(
        returnTo,
        'error',
        'Para reprogramar la entrevista, selecciona primero un nuevo horario desde “Asignar horario”. La reserva actual se mantiene activa.'
      ));
    }

    if (!transition.persisted) {
      return res.redirect(withFlashMessage(
        returnTo,
        'error',
        'La entrevista cambió mientras se procesaba la acción. Actualiza la página e intenta nuevamente.'
      ));
    }

    await logCandidateAdminEvent(prisma, {
      candidateId: booking.candidateId,
      actorRole: req.userRole,
      eventType: 'INTERVIEW_STATUS_CHANGED',
      eventLabel: 'Actualizó estado de entrevista',
      fromValue: transition.previousStatus,
      toValue: transition.nextStatus
    });

    return res.redirect(withFlashMessage(returnTo, 'success', 'Entrevista actualizada correctamente.'));
  });

`;
admin = admin.slice(0, statusStartIndex) + statusRouteReplacement + admin.slice(statusEndIndex);

admin = replaceOnce(
  admin,
  `    if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Solo puedes enviar recordatorio para entrevistas activas.'));
    }`,
  `    if (!ACTIVE_INTERVIEW_BOOKING_STATUSES.includes(booking.status)) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Solo puedes enviar recordatorio para entrevistas activas.'));
    }`,
  'admin_manual_reminder_active_statuses'
);
write(adminPath, admin);

const adminTestPath = 'test/interviewBookingAdminStateService.test.js';
let adminTest = read(adminTestPath);
adminTest = adminTest.replace(
  `  assert.equal(result.persisted, true);
  assert.deepEqual(calls[0].where, { id: bookingId, status: 'CONFIRMED' });`,
  `  assert.equal(result.persisted, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where, { id: bookingId, status: 'CONFIRMED' });`
);
adminTest = adminTest.replace(
  `    assert.equal(result.nextStatus, expectedStatus);
    assert.equal(result.statusChanged, true);
    assert.equal(calls[0].data.status, expectedStatus);`,
  `    assert.equal(result.nextStatus, expectedStatus);
    assert.equal(result.statusChanged, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.status, expectedStatus);`
);
adminTest = adminTest.replace(
  `test('una carrera con count cero no informa una transición persistida', async () => {
  const { prisma } = createPrismaMock({ count: 0 });`,
  `test('una carrera con count cero no informa una transición persistida', async () => {
  const { prisma, calls } = createPrismaMock({ count: 0 });`
);
adminTest = adminTest.replace(
  `    persisted: false
  });
});

test('rechaza contratos`,
  `    persisted: false
  });
  assert.equal(calls.length, 1);
});

test('rechaza contratos`
);
write(adminTestPath, adminTest);

const structuralTestPath = 'test/adminInterviewBookingAuthority.test.js';
const structuralTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/admin.js', 'utf8');

function between(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, \`No se encontró el marcador inicial: \${start}\`);
  assert.notEqual(endIndex, -1, \`No se encontró el marcador final: \${end}\`);
  return source.slice(startIndex, endIndex);
}

test('la ruta de estado administrativo delega en la autoridad sin escritura directa', () => {
  const route = between(
    "router.post('/interviews/:id/status'",
    "router.post('/interviews/:id/manual-reminder'"
  );

  assert.match(route, /applyAdministrativeInterviewBookingAction\(prisma/);
  assert.match(route, /transition\.requiresReplacement/);
  assert.match(route, /!transition\.persisted/);
  assert.match(route, /logCandidateAdminEvent\(prisma/);
  assert.doesNotMatch(route, /prisma\.interviewBooking\.update\s*\(/);
  assert.doesNotMatch(route, /status:\s*['\"]RESCHEDULED['\"]/);
});

test('el recordatorio manual usa solo los estados activos canónicos', () => {
  const route = between(
    "router.post('/interviews/:id/manual-reminder'",
    "router.post('/interviews/:id/delete'"
  );

  assert.match(route, /ACTIVE_INTERVIEW_BOOKING_STATUSES\.includes\(booking\.status\)/);
  assert.doesNotMatch(route, /ACTIVE_BOOKING_STATUSES\.includes\(booking\.status\)/);
});

test('el alcance no altera eliminación física ni asignación manual pendientes', () => {
  assert.match(source, /await tx\.interviewBooking\.delete\s*\(/);
  assert.match(source, /await cancelCandidateBookings\(tx, candidate\.id, ['\"]RESCHEDULED['\"]\)/);
  assert.match(source, /await createBooking\(/);
});
`;
write(structuralTestPath, structuralTest);

const ciPath = '.github/workflows/ci.yml';
let ci = read(ciPath);
ci = replaceOnce(
  ci,
  `        run: node --test test/interviewBookingStateService.test.js test/interviewSchedulerAuthority.test.js test/interviewLifecycle.test.js`,
  `        run: node --test test/interviewBookingStateService.test.js test/interviewSchedulerAuthority.test.js test/interviewLifecycle.test.js test/interviewBookingAdminStateService.test.js test/adminInterviewBookingAuthority.test.js`,
  'ci_interview_authority_gate'
);
write(ciPath, ci);

const manifestPath = 'docs/architecture/state-authority-manifest.json';
let manifest = read(manifestPath);
manifest = replaceOnce(
  manifest,
  `{ "path": "src/routes/admin.js", "role": "admin", "reason": "Cambios manuales de reserva" }`,
  `{ "path": "src/routes/admin.js", "role": "admin", "reason": "Eliminación física administrativa y limpieza de reservas durante el ciclo de vida del candidato; las transiciones manuales delegan en la autoridad canónica" }`,
  'manifest_admin_reason'
);
manifest = replaceOnce(
  manifest,
  `{ "path": "src/services/interviewBookingStateService.js", "role": "canonical", "reason": "Creación, reemplazo, cancelación, recordatorios y respuestas de reservas delegadas por scheduler y reminder" }`,
  `{ "path": "src/services/interviewBookingStateService.js", "role": "canonical", "reason": "Creación, reemplazo, cancelación, recordatorios, respuestas y transiciones manuales de reservas" }`,
  'manifest_authority_reason'
);
write(manifestPath, manifest);

const mapPath = 'docs/architecture/state-authority-map.md';
let map = read(mapPath);
map = replaceOnce(
  map,
  `InterviewBookingStateService concentra ya la creación, el reemplazo, la cancelación y las mutaciones operativas de recordatorios. \`interviewScheduler.js\` conserva disponibilidad, cupos, anticipación mínima y selección de slots; \`reminder.js\` conserva ventanas, dispatchers, mensajes, WhatsApp y jobs. Ninguno de los dos escribe \`InterviewBooking\` directamente.`,
  `InterviewBookingStateService concentra ya la creación, el reemplazo, la cancelación, las mutaciones operativas de recordatorios y las transiciones manuales del panel. \`interviewScheduler.js\` conserva disponibilidad, cupos, anticipación mínima y selección de slots; \`reminder.js\` conserva ventanas, dispatchers, mensajes, WhatsApp y jobs; \`admin.js\` conserva permisos, acceso y auditoría. Estas fronteras delegan las transiciones ordinarias en la autoridad canónica.`,
  'map_authority_summary'
);
map = replaceOnce(
  map,
  `- el claim del recordatorio y el cierre de ventana conservan filtros condicionales e idempotencia.`,
  `- el claim del recordatorio y el cierre de ventana conservan filtros condicionales e idempotencia;
- las acciones manuales validan el estado de origen y usan comparación condicional por ID y estado;
- una solicitud manual de reprogramación conserva la reserva activa hasta asignar un horario reemplazante;
- el recordatorio manual solo admite \`SCHEDULED\` y \`CONFIRMED\`.`,
  'map_admin_invariants'
);
map = replaceOnce(
  map,
  `\`reminder.js\` delega cierre de ventana, reclamación idempotente, \`NO_RESPONSE\` y respuestas interpretadas. El número de escritores directos baja a cuatro: administración, webhook, \`chatEngine\` y la autoridad canónica.`,
  `\`reminder.js\` delega cierre de ventana, reclamación idempotente, \`NO_RESPONSE\` y respuestas interpretadas. El panel delega sus transiciones manuales y mantiene una reserva activa ante una solicitud de reprogramación. \`admin.js\` continúa declarado como escritor únicamente por la eliminación física exacta y la limpieza al eliminar candidatos. El número total de escritores permanece en cuatro: administración, webhook, \`chatEngine\` y la autoridad canónica.`,
  'map_writer_summary'
);
map = replaceOnce(
  map,
  `Después de extraer scheduler y recordatorios, \`InterviewBooking\` todavía se modifica desde webhook, administración y un motor conversacional alternativo. Deben centralizarse gradualmente invariantes como:`,
  `Después de extraer scheduler, recordatorios y transiciones manuales, \`InterviewBooking\` todavía se modifica desde webhook, un motor conversacional alternativo y las dos eliminaciones físicas administrativas pendientes. Deben centralizarse gradualmente invariantes como:`,
  'map_remaining_frontiers'
);
write(mapPath, map);

console.log('Admin interview transition authority migration applied.');
