import fs from 'node:fs';

function replaceBetween(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`migration_marker_not_found:${label}`);
  }
  return source.slice(0, start) + replacement.trimEnd() + '\n\n' + source.slice(end);
}

function replaceOnce(source, expected, replacement, label) {
  const first = source.indexOf(expected);
  const second = source.indexOf(expected, first + expected.length);
  if (first < 0 || second >= 0) {
    throw new Error(`migration_expected_once:${label}`);
  }
  return source.replace(expected, replacement);
}

const reminderPath = 'src/services/reminder.js';
let reminder = fs.readFileSync(reminderPath, 'utf8');

reminder = replaceOnce(
  reminder,
  "import { persistOutboundConversationMessage } from './conversationMessageRepository.js';\n",
  "import { persistOutboundConversationMessage } from './conversationMessageRepository.js';\nimport {\n  ACTIVE_INTERVIEW_BOOKING_STATUSES,\n  applyInterviewReminderResponse,\n  claimInterviewBookingReminder as claimInterviewBookingReminderState,\n  closeUnclaimedInterviewReminderWindow as closeUnclaimedInterviewReminderWindowState,\n  markInterviewBookingNoResponse\n} from './interviewBookingStateService.js';\n",
  'reminder_import'
);

reminder = replaceOnce(
  reminder,
  "const ACTIVE_INTERVIEW_STATUSES = ['SCHEDULED', 'CONFIRMED'];\nconst NO_RESPONSE_ELIGIBLE_INTERVIEW_STATUSES = ['SCHEDULED'];",
  'const ACTIVE_INTERVIEW_STATUSES = ACTIVE_INTERVIEW_BOOKING_STATUSES;',
  'status_constants'
);

reminder = replaceBetween(
  reminder,
  'async function closeUnclaimedInterviewReminderWindow',
  'async function hasInterviewReminderAlreadySentInWindow',
  `async function closeUnclaimedInterviewReminderWindow(prisma, booking) {
  if (!booking?.id || typeof prisma?.interviewBooking?.updateMany !== 'function') return false;
  const result = await closeUnclaimedInterviewReminderWindowState(prisma, {
    bookingId: booking.id
  });
  return result.count === 1;
}`,
  'close_reminder_window'
);

reminder = replaceBetween(
  reminder,
  'async function claimInterviewBookingReminder',
  'async function claimInterviewNoResponse',
  `async function claimInterviewBookingReminder(prisma, booking, now, { windowStart, windowEnd } = {}) {
  if (!booking?.id || typeof prisma?.interviewBooking?.updateMany !== 'function') return false;

  if (await hasInterviewReminderAlreadySentInWindow(prisma, booking, windowStart, windowEnd)) {
    await closeUnclaimedInterviewReminderWindow(prisma, booking);
    console.warn('[REMINDER_TRACE]', JSON.stringify({
      event: 'interview_reminder_duplicate_booking_closed',
      bookingId: booking.id,
      candidateId: booking.candidateId
    }));
    return false;
  }

  const result = await claimInterviewBookingReminderState(prisma, {
    bookingId: booking.id,
    candidateId: booking.candidateId,
    now,
    windowStart,
    windowEnd
  });

  return result.count === 1;
}`,
  'claim_reminder'
);

reminder = replaceBetween(
  reminder,
  'async function claimInterviewNoResponse',
  'async function claimInterviewKeepalive',
  `async function claimInterviewNoResponse(prisma, booking, now, windowEnd) {
  if (!booking?.id || typeof prisma?.interviewBooking?.updateMany !== 'function') return false;
  const result = await markInterviewBookingNoResponse(prisma, {
    bookingId: booking.id,
    candidateId: booking.candidateId,
    now,
    windowEnd
  });
  return result.count === 1;
}`,
  'claim_no_response'
);

reminder = replaceBetween(
  reminder,
  'export async function handleInterviewReminderResponse',
  'export async function runCandidateProcessReminderDispatcher',
  `export async function handleInterviewReminderResponse(prisma, candidateId, responseText, { now = new Date() } = {}) {
  if (!candidateId || typeof prisma?.interviewBooking?.findFirst !== 'function') return { status: 'UNCHANGED', intent: 'none' };
  const booking = await prisma.interviewBooking.findFirst({
    where: {
      candidateId,
      status: { in: ACTIVE_INTERVIEW_STATUSES }
    },
    orderBy: { scheduledAt: 'asc' }
  });
  if (!booking) return { status: 'UNCHANGED', intent: 'none' };

  const intent = detectInterviewIntent({ text: responseText, booking, now });
  if (!['confirm_attendance', 'cancel_interview', 'reschedule_interview'].includes(intent)) {
    return { status: 'UNCHANGED', intent };
  }

  const transition = await applyInterviewReminderResponse(prisma, {
    bookingId: booking.id,
    currentStatus: booking.status,
    responseText,
    intent
  });
  if (transition.count !== 1) return { status: 'UNCHANGED', intent };

  const nextStatus = transition.nextStatus;
  const updatedBooking = typeof prisma.interviewBooking.findUnique === 'function'
    ? await prisma.interviewBooking.findUnique({ where: { id: booking.id } })
    : { ...booking, status: nextStatus, reminderResponse: responseText, reminderWindowClosed: true };

  return { status: nextStatus, intent, booking: updatedBooking };
}`,
  'handle_reminder_response'
);

if (/prisma\.interviewBooking\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/.test(reminder)) {
  throw new Error('reminder_direct_interview_booking_write_remaining');
}
fs.writeFileSync(reminderPath, reminder, 'utf8');

const testPath = 'test/reminder.test.js';
let testSource = fs.readFileSync(testPath, 'utf8');
testSource = replaceOnce(
  testSource,
  'async function assertReminderTransition({ candidateText, expectedStatus }) {',
  'async function assertReminderTransition({ candidateText, expectedStatus, expectedIntent = null }) {',
  'test_helper_signature'
);
testSource = replaceOnce(
  testSource,
  '    assert.equal(result.status, expectedStatus);\n    assert.equal(prisma.state.interviewBookings[0].status, expectedStatus);',
  "    assert.equal(result.status, expectedStatus);\n    if (expectedIntent) assert.equal(result.intent, expectedIntent);\n    assert.equal(prisma.state.interviewBookings[0].status, expectedStatus);",
  'test_helper_intent'
);
testSource = replaceOnce(
  testSource,
  "test('respuesta de reprogramación al recordatorio cambia entrevista a RESCHEDULED sin enviar WhatsApp', async () => {\n  await assertReminderTransition({\n    candidateText: 'Necesito reprogramar la entrevista',\n    expectedStatus: 'RESCHEDULED'\n  });\n});",
  "test('respuesta de reprogramación conserva la reserva activa sin enviar WhatsApp', async () => {\n  await assertReminderTransition({\n    candidateText: 'Necesito reprogramar la entrevista',\n    expectedStatus: 'SCHEDULED',\n    expectedIntent: 'reschedule_interview'\n  });\n});",
  'reschedule_test'
);
fs.writeFileSync(testPath, testSource, 'utf8');

const manifestPath = 'docs/architecture/state-authority-manifest.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.models.interviewBooking.writers = manifest.models.interviewBooking.writers.filter(
  (writer) => writer.path !== 'src/services/reminder.js'
);
const authorityWriter = manifest.models.interviewBooking.writers.find(
  (writer) => writer.path === 'src/services/interviewBookingStateService.js'
);
if (!authorityWriter) throw new Error('interview_booking_authority_writer_missing');
authorityWriter.reason = 'Creación, reemplazo, cancelación, recordatorios y respuestas de reservas delegadas por scheduler y reminder';
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const mapPath = 'docs/architecture/state-authority-map.md';
let map = fs.readFileSync(mapPath, 'utf8');
map = replaceOnce(
  map,
  '| `InterviewBooking` | 5 | Crítico | En consolidación | `InterviewBookingStateService` |',
  '| `InterviewBooking` | 4 | Crítico | En consolidación | `InterviewBookingStateService` |',
  'map_writer_count'
);
map = replaceOnce(
  map,
  'El número de escritores permanece en cinco porque administración, webhook, `chatEngine` y recordatorios aún realizan otras transiciones directamente. El scheduler sale del inventario y es sustituido por la autoridad canónica objetivo.',
  '`reminder.js` delega ahora cierre de ventana, reclamación idempotente, `NO_RESPONSE` y respuestas interpretadas. La solicitud de reprogramación conserva la reserva activa hasta crear un reemplazo válido. El número de escritores baja a cuatro: administración, webhook, `chatEngine` y la autoridad canónica.',
  'map_reminder_progress'
);
map = replaceOnce(
  map,
  '### 2. Las reservas conservan cuatro fronteras directas por migrar\n\nDespués de extraer las mutaciones del scheduler, `InterviewBooking` todavía se modifica desde webhook, recordatorios, administración y un motor conversacional alternativo.',
  '### 2. Las reservas conservan tres fronteras directas por migrar\n\nDespués de extraer scheduler y recordatorios, `InterviewBooking` todavía se modifica desde webhook, administración y un motor conversacional alternativo.',
  'map_remaining_frontiers'
);
fs.writeFileSync(mapPath, map, 'utf8');

console.log('Reminder authority migration applied successfully.');
