import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

function write(path, content) {
  fs.writeFileSync(path, content, 'utf8');
}

function replaceOnce(content, search, replacement, label) {
  const first = content.indexOf(search);
  if (first < 0) throw new Error(`${label}_not_found`);
  if (content.indexOf(search, first + search.length) >= 0) throw new Error(`${label}_not_unique`);
  return content.slice(0, first) + replacement + content.slice(first + search.length);
}

const chatPath = 'src/services/chatEngine.js';
let chat = read(chatPath);

const authorityImport = "import { applyInterviewReminderResponse } from './interviewBookingStateService.js';";
if (!chat.includes(authorityImport)) {
  chat = replaceOnce(
    chat,
    "import { getNextAvailableSlotAfter, formatInterviewDate } from './interviewScheduler.js';",
    "import { getNextAvailableSlotAfter, formatInterviewDate } from './interviewScheduler.js';\n" + authorityImport,
    'chat_engine_authority_import'
  );
}

const handlerStart = chat.indexOf('async function handleAppointmentIntentDirectly');
const handlerEnd = chat.indexOf('async function analyzePausedVacancyConsent', handlerStart);
if (handlerStart < 0 || handlerEnd < 0 || handlerEnd <= handlerStart) {
  throw new Error('chat_engine_handler_bounds_invalid');
}

const newHandler = `async function handleAppointmentIntentDirectly({ prisma, candidate, vacancy, inboundText, booking, intent, classification, currentStep, now = new Date(), nextSlot = null }) {
  if (!booking?.id || !APPOINTMENT_ACTION_INTENTS.has(intent)) return null;

  const transition = await applyInterviewReminderResponse(prisma, {
    bookingId: booking.id,
    currentStatus: booking.status,
    responseText: inboundText,
    intent
  });
  if (transition.count !== 1) return null;

  if (intent === 'confirm_attendance') {
    return buildEngineHandledResult({
      currentStep,
      intent,
      classification,
      reply: \`Perfecto, gracias por confirmar asistencia. Te esperamos \${formatInterviewDate(new Date(booking.scheduledAt))}.\`
    });
  }

  if (intent === 'cancel_interview') {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      }
    });
    return buildEngineHandledResult({
      currentStep,
      intent,
      classification,
      reply: 'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.'
    });
  }

  if (intent === 'reschedule_interview') {
    const lastInboundAt = candidate.lastInboundAt ? new Date(candidate.lastInboundAt) : null;
    const alternative = nextSlot?.slot && !nextSlot?.isConfirmedBooking
      ? nextSlot
      : (vacancy?.id
        ? await getNextAvailableSlotAfter(prisma, vacancy.id, lastInboundAt, booking, now).catch(() => null)
        : null);

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        currentStep: ConversationStep.SCHEDULING,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      }
    });

    const reply = alternative?.slot
      ? \`Listo, dejé marcada la solicitud de reprogramación. Te puedo ofrecer \${alternative.formattedDate}; si te sirve, respóndeme confirmando ese horario.\`
      : 'Listo, dejé marcada la solicitud de reprogramación. En este momento no tengo otro horario válido para ofrecerte, así que el equipo te contactará para ayudarte con la reprogramación.';

    return buildEngineHandledResult({ currentStep: ConversationStep.SCHEDULING, intent, classification, reply });
  }

  return null;
}

`;

chat = chat.slice(0, handlerStart) + newHandler + chat.slice(handlerEnd);
write(chatPath, chat);

const manifestPath = 'docs/architecture/state-authority-manifest.json';
const manifest = JSON.parse(read(manifestPath));
manifest.models.interviewBooking.writers = manifest.models.interviewBooking.writers.filter(
  (writer) => writer.path !== 'src/services/chatEngine.js'
);
if (manifest.models.interviewBooking.writers.length !== 2) {
  throw new Error('interview_booking_writer_count_invalid');
}
write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const mapPath = 'docs/architecture/state-authority-map.md';
let map = read(mapPath);
map = replaceOnce(
  map,
  '| `InterviewBooking` | 3 | Crítico | En consolidación | `InterviewBookingStateService` |',
  '| `InterviewBooking` | 2 | Crítico | En consolidación | `InterviewBookingStateService` |',
  'state_map_booking_count'
);
map = replaceOnce(
  map,
  '`reminder.js` delega cierre de ventana, reclamación idempotente, `NO_RESPONSE` y respuestas interpretadas. El panel delega transiciones manuales, eliminación individual, limpieza por ciclo de vida y asignación manual; conserva permisos, acceso, auditoría y el orden mensajes → reservas → candidato. `admin.js` no escribe `InterviewBooking` ni coordina un cierre previo redundante. El número total de escritores permanece en tres: webhook, `chatEngine` y la autoridad canónica.',
  '`reminder.js` delega cierre de ventana, reclamación idempotente, `NO_RESPONSE` y respuestas interpretadas. El panel delega transiciones manuales, eliminación individual, limpieza por ciclo de vida y asignación manual; conserva permisos, acceso, auditoría y el orden mensajes → reservas → candidato. `chatEngine.js` delega confirmación, cancelación y solicitud de reprogramación; una carrera no produce una respuesta de éxito y la solicitud conserva la reserva activa. `admin.js` y `chatEngine.js` no escriben `InterviewBooking` directamente. El número total de escritores baja a dos: webhook y la autoridad canónica.',
  'state_map_booking_summary'
);
map = replaceOnce(
  map,
  '### 2. Las reservas conservan dos fronteras directas por migrar',
  '### 2. Las reservas conservan una frontera directa por migrar',
  'state_map_booking_heading'
);
map = replaceOnce(
  map,
  'Después de extraer scheduler, recordatorios, transiciones manuales, eliminaciones físicas y asignación manual, `InterviewBooking` todavía se modifica directamente desde webhook y un motor conversacional alternativo. Las responsabilidades administrativas quedaron migradas; las dos fronteras restantes continúan bajo #453 y #421. Deben centralizarse gradualmente invariantes como:',
  'Después de extraer scheduler, recordatorios, administración y `chatEngine.js`, `InterviewBooking` todavía se modifica directamente solo desde el webhook. La frontera conversacional principal continúa bajo #453 y #421 y debe migrarse preservando replays, textos y orden de efectos. Deben centralizarse gradualmente invariantes como:',
  'state_map_booking_remaining_boundary'
);
write(mapPath, map);

const inventoryPath = 'docs/architecture/interview-booking-transition-inventory.md';
let inventory = read(inventoryPath);
inventory = inventory.replace(/^\| `src\/services\/chatEngine\.js` \|.*\n/m, '');
const inventoryChatStart = inventory.indexOf('## chatEngine.js');
const inventoryWebhookStart = inventory.indexOf('## webhook.js', inventoryChatStart);
if (inventoryChatStart < 0 || inventoryWebhookStart < 0) throw new Error('inventory_chat_engine_bounds_invalid');
const migratedChatSection = `## chatEngine.js

### Estado migrado

\`handleAppointmentIntentDirectly()\` conserva la carga de la reserva activa, la clasificación de intención y los textos existentes, pero delega confirmación, cancelación y solicitud de reprogramación en \`applyInterviewReminderResponse()\`.

- confirmación: la autoridad cambia a \`CONFIRMED\`, guarda la respuesta y cierra la ventana;
- cancelación: la autoridad cambia a \`CANCELLED\`; después el motor limpia el recordatorio del candidato;
- reprogramación: la autoridad guarda la solicitud y cierra la ventana sin cambiar \`SCHEDULED\` o \`CONFIRMED\`; después el motor busca una alternativa y mueve al candidato a \`SCHEDULING\`;
- concurrencia: si la comparación por ID y estado devuelve \`count=0\`, el motor no informa una transición como exitosa ni ejecuta efectos secundarios.

\`chatEngine.js\` deja de escribir \`InterviewBooking\` directamente. El webhook queda como única frontera directa pendiente.

`;
inventory = inventory.slice(0, inventoryChatStart) + migratedChatSection + inventory.slice(inventoryWebhookStart);
inventory = inventory.replace(
  '- webhook y chat engine: solicitud sin reserva nueva;',
  '- webhook: solicitud sin reserva nueva;\n- chat engine: solicitud registrada por la autoridad sin cerrar la reserva activa;'
);
inventory = inventory.replace(
  '### Dos rutas cierran antes de reemplazar\n\nWebhook y chat engine asignan `RESCHEDULED` antes de disponibilidad o nueva reserva.',
  '### Una ruta cierra antes de reemplazar\n\nEl webhook todavía asigna `RESCHEDULED` antes de disponibilidad o nueva reserva. `chatEngine.js` ya conserva la reserva activa.'
);
inventory = inventory.replace(
  '| activo | confirmar asistencia | `CONFIRMED` | webhook/chat engine | actualización única |',
  '| activo | confirmar asistencia | `CONFIRMED` | webhook / autoridad para chat engine | directa en webhook; condicional por ID y estado en autoridad |'
);
inventory = inventory.replace(
  '| activo | cancelar entrevista | `CANCELLED` | webhook/chat engine | booking y candidato separados |',
  '| activo | cancelar entrevista | `CANCELLED` | webhook / autoridad para chat engine | booking y candidato separados; transición condicional en autoridad |'
);
inventory = inventory.replace(
  '| activo | pedir reprogramación | `RESCHEDULED` sin reemplazo | webhook/chat engine | inconsistente |',
  '| activo | pedir reprogramación | webhook: `RESCHEDULED` sin reemplazo; chat engine: conserva activo | webhook / autoridad para chat engine | webhook inconsistente; chat engine condicional |'
);
inventory = inventory.replace(
  '7. Migrar chat engine heredado.\n8. Migrar webhook al final, preservando replays.',
  '7. Migrar chat engine heredado mediante la autoridad compartida.\n8. Migrar webhook al final, preservando replays.'
);
write(inventoryPath, inventory);

const ciPath = '.github/workflows/ci.yml';
let ci = read(ciPath);
ci = replaceOnce(
  ci,
  'test/interviewBookingDeletionStateService.test.js test/adminInterviewBookingAuthority.test.js',
  'test/interviewBookingDeletionStateService.test.js test/adminInterviewBookingAuthority.test.js test/chatEngineInterviewBookingAuthority.test.js',
  'ci_chat_engine_authority_gate'
);
write(ciPath, ci);
