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

function replaceSection(content, start, end, replacement, label) {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) throw new Error(`${label}_start_not_found`);
  const endIndex = content.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`${label}_end_not_found`);
  return content.slice(0, startIndex) + replacement + content.slice(endIndex);
}

const webhookPath = 'src/routes/webhook.js';
let webhook = read(webhookPath);

webhook = replaceOnce(
  webhook,
  "import { cancelCandidateBookings, createBooking, formatInterviewDate, getNextAvailableSlot, getNextAvailableSlotAfter, getInterviewReminderAt, hydrateOfferedSlot } from '../services/interviewScheduler.js';",
  "import { createBooking, formatInterviewDate, getNextAvailableSlot, getNextAvailableSlotAfter, getInterviewReminderAt, hydrateOfferedSlot } from '../services/interviewScheduler.js';",
  'webhook_scheduler_import'
);

webhook = replaceOnce(
  webhook,
  "import { detectInterviewIntent } from '../services/interviewLifecycle.js';",
  "import { detectInterviewIntent } from '../services/interviewLifecycle.js';\nimport { applyInterviewReminderResponse } from '../services/interviewBookingStateService.js';",
  'webhook_authority_import'
);

const helper = `async function applyActiveInterviewResponse(prisma, candidate, activeBooking, responseText, intent) {
  if (!activeBooking?.id || !activeBooking?.status) {
    await recordIntentionalSilence(prisma, candidate, responseText, {
      reason: 'interview_booking_missing_for_response',
      gate: 'interview_booking_authority',
      action: intent
    });
    return null;
  }

  const transition = await applyInterviewReminderResponse(prisma, {
    bookingId: activeBooking.id,
    currentStatus: activeBooking.status,
    responseText,
    intent
  });

  if (transition.count !== 1) {
    await recordIntentionalSilence(prisma, candidate, responseText, {
      reason: 'interview_booking_transition_not_applied',
      gate: 'interview_booking_authority',
      action: intent
    });
    return null;
  }

  return transition;
}

`;

webhook = replaceOnce(
  webhook,
  'async function loadVacancyContext(prisma, vacancyId) {',
  helper + 'async function loadVacancyContext(prisma, vacancyId) {',
  'webhook_authority_helper'
);

const oldCancel = `    if (interviewIntent === 'cancel_interview') {
      if (activeBooking?.id) {
        await prisma.interviewBooking.update({
          where: { id: activeBooking.id },
          data: {
            status: 'CANCELLED',
            reminderResponse: cleanText,
            reminderWindowClosed: true
          }
        });
      }
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        }
      });
      const body = 'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.';
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'interview_booking_cancel' });
    }
`;

const newCancel = `    if (interviewIntent === 'cancel_interview') {
      const transition = await applyActiveInterviewResponse(prisma, candidate, activeBooking, cleanText, 'cancel_interview');
      if (!transition) return;

      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        }
      });
      const body = 'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.';
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'interview_booking_cancel' });
    }
`;
webhook = replaceOnce(webhook, oldCancel, newCancel, 'webhook_cancel_branch');

const oldReschedule = `    if (interviewIntent === 'reschedule_interview' || isSchedulingRescheduleIntent(cleanText)) {
      if (activeBooking?.id) {
        await prisma.interviewBooking.update({
          where: { id: activeBooking.id },
          data: {
            status: 'RESCHEDULED',
            reminderResponse: cleanText,
            reminderWindowClosed: true
          }
        });
      }
      if (!nextSlot?.slot) {
        await pauseInterviewFlow(prisma, candidate.id, 'No hay un siguiente slot valido para reagendar');
        const body = 'En este momento no tengo un siguiente horario válido para ofrecerte. El equipo te contactará para ayudarte con la reprogramación.';
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }

      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          currentStep: ConversationStep.SCHEDULING,
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        }
      });
      const body = await buildInterviewOfferReply(candidate, currentVacancy, nextSlot, true);
      return reply(prisma, candidate.id, from, body, cleanText, buildInterviewReplyPayload(body, 'interview_reschedule', nextSlot, currentVacancy));
    }
`;

const newReschedule = `    if (interviewIntent === 'reschedule_interview' || isSchedulingRescheduleIntent(cleanText)) {
      const transition = await applyActiveInterviewResponse(prisma, candidate, activeBooking, cleanText, 'reschedule_interview');
      if (!transition) return;

      if (!nextSlot?.slot) {
        await pauseInterviewFlow(prisma, candidate.id, 'No hay un siguiente slot valido para reagendar');
        const body = 'En este momento no tengo un siguiente horario válido para ofrecerte. El equipo te contactará para ayudarte con la reprogramación.';
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }

      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          currentStep: ConversationStep.SCHEDULING,
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        }
      });
      const body = await buildInterviewOfferReply(candidate, currentVacancy, nextSlot, true);
      return reply(prisma, candidate.id, from, body, cleanText, buildInterviewReplyPayload(body, 'interview_reschedule', nextSlot, currentVacancy));
    }
`;
webhook = replaceOnce(webhook, oldReschedule, newReschedule, 'webhook_reschedule_branch');

const oldConfirm = `    if (interviewIntent === 'confirm_attendance') {
      await prisma.interviewBooking.update({
        where: { id: activeBooking.id },
        data: {
          status: 'CONFIRMED',
          reminderResponse: cleanText,
          reminderWindowClosed: true
        }
      });
      const body = \`Perfecto, gracias por confirmar asistencia. Te esperamos \${nextSlot?.formattedDate || 'en el horario acordado'}.\`;
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'interview_attendance_confirmed' });
    }
`;

const newConfirm = `    if (interviewIntent === 'confirm_attendance') {
      const transition = await applyActiveInterviewResponse(prisma, candidate, activeBooking, cleanText, 'confirm_attendance');
      if (!transition) return;

      const body = \`Perfecto, gracias por confirmar asistencia. Te esperamos \${nextSlot?.formattedDate || 'en el horario acordado'}.\`;
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'interview_attendance_confirmed' });
    }
`;
webhook = replaceOnce(webhook, oldConfirm, newConfirm, 'webhook_confirm_branch');

const cancelBeforeCreate = `      await cancelCandidateBookings(
        prisma,
        candidate.id,
        candidate.currentStep === ConversationStep.SCHEDULED ? 'RESCHEDULED' : 'CANCELLED'
      );
`;
webhook = replaceOnce(webhook, cancelBeforeCreate, '', 'webhook_cancel_before_create');
write(webhookPath, webhook);

const testPath = 'test/webhookInterviewBookingAuthority.test.js';
write(testPath, `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/webhook.js', 'utf8');

function between(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1, \`No se encontró el marcador inicial: \${start}\`);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, \`No se encontró el marcador final: \${end}\`);
  return content.slice(startIndex, endIndex);
}

const helper = between(source, 'async function applyActiveInterviewResponse', 'async function loadVacancyContext');
const scheduling = between(
  source,
  "if ((candidate.currentStep === ConversationStep.SCHEDULING || candidate.currentStep === ConversationStep.SCHEDULED) && currentVacancy && isSchedulingEligibleCandidate(candidate, currentVacancy))",
  'if (candidate.currentStep === ConversationStep.ASK_CV'
);
const cancelBranch = between(scheduling, "if (interviewIntent === 'cancel_interview')", "if (interviewIntent === 'reschedule_interview'");
const rescheduleBranch = between(scheduling, "if (interviewIntent === 'reschedule_interview'", "if (interviewIntent === 'confirm_attendance')");
const confirmBranch = between(scheduling, "if (interviewIntent === 'confirm_attendance')", 'if (candidate.currentStep === ConversationStep.SCHEDULING && isSchedulingConfirmationIntent(cleanText))');
const initialBookingBranch = between(
  scheduling,
  'if (candidate.currentStep === ConversationStep.SCHEDULING && isSchedulingConfirmationIntent(cleanText))',
  'if (candidate.currentStep === ConversationStep.SCHEDULED && isSchedulingConfirmationIntent(cleanText))'
);

test('webhook delega respuestas de reserva exacta en la autoridad compartida', () => {
  assert.match(source, /import \{ applyInterviewReminderResponse \} from '\.\.\/services\/interviewBookingStateService\.js';/);
  assert.match(helper, /applyInterviewReminderResponse\(prisma,\s*\{/);
  assert.match(helper, /bookingId:\s*activeBooking\.id/);
  assert.match(helper, /currentStatus:\s*activeBooking\.status/);
  assert.match(helper, /responseText/);
  assert.match(helper, /intent/);
  assert.match(cancelBranch, /applyActiveInterviewResponse\([^;]+['"]cancel_interview['"]\)/s);
  assert.match(rescheduleBranch, /applyActiveInterviewResponse\([^;]+['"]reschedule_interview['"]\)/s);
  assert.match(confirmBranch, /applyActiveInterviewResponse\([^;]+['"]confirm_attendance['"]\)/s);
});

test('webhook no escribe InterviewBooking directamente', () => {
  assert.doesNotMatch(source, /prisma\.interviewBooking\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/);
  assert.doesNotMatch(scheduling, /status:\s*['"](?:RESCHEDULED|CANCELLED|CONFIRMED)['"]/);
});

test('reserva ausente o carrera producen silencio trazado antes de efectos posteriores', () => {
  const transitionIndex = helper.indexOf('applyInterviewReminderResponse');
  const countIndex = helper.indexOf('transition.count !== 1');
  const silenceIndex = helper.lastIndexOf('recordIntentionalSilence');
  const returnIndex = helper.lastIndexOf('return null');
  assert.ok(transitionIndex >= 0 && countIndex > transitionIndex);
  assert.ok(silenceIndex > countIndex, 'La carrera debe registrar silencio intencional.');
  assert.ok(returnIndex > silenceIndex, 'La carrera debe terminar sin éxito.');
});

test('cancelación persiste antes de limpiar candidato y responder', () => {
  const authorityIndex = cancelBranch.indexOf('applyActiveInterviewResponse');
  const candidateIndex = cancelBranch.indexOf('prisma.candidate.update');
  const replyIndex = cancelBranch.indexOf('return reply');
  assert.ok(authorityIndex >= 0 && candidateIndex > authorityIndex);
  assert.ok(replyIndex > candidateIndex);
  assert.match(cancelBranch, /Listo, ya registré la cancelación de tu entrevista\. Si más adelante deseas retomarla, me escribes por aquí\./);
  assert.match(cancelBranch, /source:\s*['"]interview_booking_cancel['"]/);
});

test('reprogramación conserva reserva activa y registra solicitud antes de pausa u oferta', () => {
  const authorityIndex = rescheduleBranch.indexOf('applyActiveInterviewResponse');
  const pauseIndex = rescheduleBranch.indexOf('pauseInterviewFlow');
  const candidateIndex = rescheduleBranch.indexOf('prisma.candidate.update');
  assert.ok(authorityIndex >= 0);
  assert.ok(pauseIndex > authorityIndex);
  assert.ok(candidateIndex > authorityIndex);
  assert.doesNotMatch(rescheduleBranch, /RESCHEDULED/);
  assert.match(rescheduleBranch, /En este momento no tengo un siguiente horario válido para ofrecerte\. El equipo te contactará para ayudarte con la reprogramación\./);
  assert.match(rescheduleBranch, /buildInterviewReplyPayload\(body, ['"]interview_reschedule['"]/);
});

test('confirmación de asistencia persiste antes de responder y conserva texto', () => {
  const authorityIndex = confirmBranch.indexOf('applyActiveInterviewResponse');
  const replyIndex = confirmBranch.indexOf('return reply');
  assert.ok(authorityIndex >= 0 && replyIndex > authorityIndex);
  assert.match(confirmBranch, /Perfecto, gracias por confirmar asistencia\. Te esperamos/);
  assert.match(confirmBranch, /source:\s*['"]interview_attendance_confirmed['"]/);
});

test('aceptación inicial usa una sola creación atómica después del guard', () => {
  const guardIndex = initialBookingBranch.indexOf('evaluateSchedulingGuard');
  const createIndex = initialBookingBranch.indexOf('createBooking(');
  const candidateIndex = initialBookingBranch.indexOf('prisma.candidate.update');
  const replyIndex = initialBookingBranch.indexOf('return reply');
  assert.ok(guardIndex >= 0 && createIndex > guardIndex);
  assert.equal((initialBookingBranch.match(/createBooking\(/g) || []).length, 1);
  assert.doesNotMatch(initialBookingBranch, /cancelCandidateBookings/);
  assert.ok(candidateIndex > createIndex);
  assert.ok(replyIndex > candidateIndex);
  assert.match(initialBookingBranch, /source|interview_booking_confirmation/);
});
`);

const manifestPath = 'docs/architecture/state-authority-manifest.json';
const manifest = JSON.parse(read(manifestPath));
manifest.models.interviewBooking.migrationStage = 'canonical';
manifest.models.interviewBooking.writers = manifest.models.interviewBooking.writers.filter(
  (writer) => writer.path === 'src/services/interviewBookingStateService.js'
);
if (manifest.models.interviewBooking.writers.length !== 1 || manifest.models.interviewBooking.writers[0].role !== 'canonical') {
  throw new Error('interview_booking_canonical_writer_invalid');
}
write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const mapPath = 'docs/architecture/state-authority-map.md';
let map = read(mapPath);
map = replaceOnce(
  map,
  '| `InterviewBooking` | 2 | Crítico | En consolidación | `InterviewBookingStateService` |',
  '| `InterviewBooking` | 1 | Crítico | Canónico | `InterviewBookingStateService` |',
  'state_map_booking_row'
);
const canonicalBookingSection = `### Reservas de entrevista canónicas

\`InterviewBookingStateService\` es el único escritor de \`InterviewBooking\`. Scheduler, recordatorios, panel, chat engine y webhook conservan sus decisiones especializadas, pero delegan la persistencia y las transiciones en la autoridad compartida.

La autoridad protege estas invariantes:

- una reserva activa exacta se reutiliza;
- el reemplazo respeta el índice único parcial de una reserva activa por candidato;
- el cierre anterior y la creación del reemplazo se confirman o revierten juntos dentro de una transacción serializable;
- los conflictos \`P2034\` se reintentan de forma acotada y una recuperación \`P2002\` solo acepta la reserva exacta;
- una solicitud de reprogramación conserva \`SCHEDULED\` o \`CONFIRMED\` hasta crear un reemplazo válido;
- confirmación y cancelación comparan ID y estado leído antes de informar éxito;
- el webhook registra como silencio intencional una reserva ausente o una carrera y no ejecuta efectos posteriores;
- la aceptación conversacional valida primero la oferta y delega una sola creación o sustitución atómica con el cliente Prisma raíz;
- recordatorios, acciones manuales y eliminaciones conservan sus filtros y contratos explícitos.

El scanner de CI bloquea cualquier nueva escritura directa fuera de la autoridad. Los textos, horarios, payloads, interpretación conversacional y efectos existentes sobre el candidato permanecen en sus fronteras.

`;
map = replaceSection(map, '### Reservas de entrevista en consolidación', '## Hallazgos', canonicalBookingSection + '## Hallazgos\n\n', 'state_map_booking_section');
const bookingFinding = `### 2. Las reservas tienen autoridad canónica

La consolidación de \`InterviewBooking\` quedó completa: no existen escrituras directas desde rutas, webhooks, scheduler, recordatorios, panel o motores conversacionales. La evolución pendiente es separada y comprende historial inmutable, actor y motivo estructurados, retención y \`tenantId\`.

`;
map = replaceSection(map, '### 2. Las reservas conservan una frontera directa por migrar', '### 3. La persistencia de mensajes ya tiene una autoridad única', bookingFinding + '### 3. La persistencia de mensajes ya tiene una autoridad única', 'state_map_booking_finding');
map = replaceOnce(map, '2. Completar `InterviewBooking` y sus transiciones.', '2. Diseñar historial, retención y `tenantId` sobre la autoridad canónica de `InterviewBooking`.', 'state_map_order');
write(mapPath, map);

const inventoryPath = 'docs/architecture/interview-booking-transition-inventory.md';
let inventory = read(inventoryPath);
const consumersSection = `## Autoridad y consumidores migrados

| Componente | Responsabilidad conservada | Persistencia de reservas |
| --- | --- | --- |
| \`src/services/interviewBookingStateService.js\` | transiciones, creación, reemplazo, recordatorios y eliminaciones | Único escritor canónico |
| \`src/services/interviewScheduler.js\` | disponibilidad, cupos, anticipación y selección de slots | Delega en la autoridad |
| \`src/services/reminder.js\` | ventanas, dispatchers, WhatsApp y jobs | Delega en la autoridad |
| \`src/routes/admin.js\` | permisos, auditoría y acciones humanas | Delega en la autoridad |
| \`src/services/chatEngine.js\` | clasificación y respuestas del motor alternativo | Delega en la autoridad |
| \`src/routes/webhook.js\` | interpretación, silencios, textos, candidato y payloads | Delega en la autoridad |

No quedan escrituras directas de \`InterviewBooking\` fuera de \`InterviewBookingStateService\`. El manifiesto y su scanner bloquean regresiones.

`;
inventory = replaceSection(inventory, '## Escritores directos observados', '## Invariantes objetivo', consumersSection + '## Invariantes objetivo', 'inventory_writers');
const webhookSection = `## webhook.js

### Estado migrado

El bloque de agenda conserva clasificación, resolución de slots, textos, payloads, pausas y efectos del candidato, pero delega toda persistencia de reservas:

- \`cancel_interview\`: aplica la transición condicional por ID y estado; después limpia el recordatorio del candidato;
- \`reschedule_interview\`: registra respuesta y cierre de ventana sin cambiar el estado activo; después pausa u ofrece una alternativa;
- \`confirm_attendance\`: aplica \`CONFIRMED\` mediante comparación condicional antes de responder;
- aceptación inicial: mantiene el scheduling guard y llama una sola vez a \`createBooking(prisma, ...)\`; la autoridad reutiliza la reserva exacta o sustituye y crea dentro de su transacción serializable;
- reserva ausente o carrera: registra silencio intencional y termina sin respuesta de éxito ni efectos posteriores.

El webhook deja de llamar \`cancelCandidateBookings()\` antes de crear y ya no ejecuta escrituras Prisma directas sobre \`InterviewBooking\`.

`;
inventory = replaceSection(inventory, '## webhook.js', '## admin.js', webhookSection + '## admin.js', 'inventory_webhook');
const consolidatedSection = `## Estado consolidado y deuda restante

### Autoridad canónica completada

Todas las transiciones vigentes pasan por \`InterviewBookingStateService\`. \`RESCHEDULED\` solo se asigna durante una sustitución que crea una reserva válida; una solicitud conserva la reserva activa. La creación inicial y el reemplazo son atómicos, y las respuestas comparan el booking exacto y su estado leído.

### Deuda separada

El modelo aún no incorpora historial inmutable, actor y motivo estructurados para todas las transiciones, reserva reemplazante explícita, retención ni \`tenantId\`. Esa evolución no altera la autoridad canónica alcanzada.

## Matriz canónica vigente

| Origen | Acción | Destino o efecto | Autoridad | Atomicidad o guard |
| --- | --- | --- | --- | --- |
| sin reserva exacta | aceptar horario | nueva \`SCHEDULED\` | autoridad | transacción serializable |
| \`SCHEDULED\`/\`CONFIRMED\` | crear reemplazo | anterior \`RESCHEDULED\`, nueva \`SCHEDULED\` | autoridad | cierre y creación atómicos |
| activo | confirmar asistencia | \`CONFIRMED\` | autoridad | condicional por ID y estado |
| activo | cancelar entrevista | \`CANCELLED\` | autoridad | condicional por ID y estado |
| activo | pedir reprogramación | conserva estado y registra respuesta | autoridad | condicional por ID y estado |
| ventana abierta | reclamar o cerrar recordatorio | fechas y cierre | autoridad | filtros idempotentes |
| \`SCHEDULED\` | sin respuesta | \`NO_RESPONSE\` | autoridad | booking exacto y ventana |
| estado permitido | acción administrativa | destino validado | autoridad | origen validado y auditoría externa |
| booking exacto | corregir/eliminar | borrado físico | autoridad | coincidencia booking/candidato |
| candidato eliminado | limpiar bookings | borrado por candidato | autoridad | reutiliza \`tx\` |

`;
inventory = replaceSection(inventory, '## Inconsistencias confirmadas', '## Contratos objetivo', consolidatedSection + '## Contratos objetivo', 'inventory_consolidated');
const completedOrder = `## Orden de trabajo completado

1. Matriz canónica de transiciones: completada.
2. Pruebas negativas: completadas.
3. Autoridad compartida: completada.
4. Scheduler y reemplazo atómico: completados.
5. Recordatorios: migrados.
6. Administración: migrada.
7. Chat engine: migrado.
8. Webhook: migrado preservando replays.
9. Historial, retención y \`tenantId\`: evolución separada.
10. \`InterviewBooking\`: marcado canónico con un único escritor.

`;
inventory = replaceSection(inventory, '## Orden de trabajo', '## Fuera de alcance', completedOrder + '## Fuera de alcance', 'inventory_order');
write(inventoryPath, inventory);

fs.rmSync('.codex-477-bootstrap.md', { force: true });
fs.rmSync('scripts/apply-webhook-interview-authority.mjs', { force: true });
