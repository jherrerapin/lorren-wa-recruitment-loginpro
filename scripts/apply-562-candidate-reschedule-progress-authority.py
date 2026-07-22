from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one anchor, found {count}")
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# CandidateStateService: reflejo estrecho de reprogramación con CAS.
# ---------------------------------------------------------------------------
service_path = "src/services/candidateStateService.js"
service = read(service_path)
service_marker = "\nexport const CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS = Object.freeze({"
service_block = r'''

const CANDIDATE_INTERVIEW_RESCHEDULE_PROGRESS_ORIGINS = new Set([
  ConversationStep.SCHEDULING,
  ConversationStep.SCHEDULED
]);

function normalizeCandidateInterviewRescheduleProgressSnapshot(expected) {
  const requiredFields = [
    'currentStep',
    'reminderScheduledFor',
    'reminderState'
  ];
  if (
    !expected
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || requiredFields.some((field) => !Object.hasOwn(expected, field))
  ) {
    throw new TypeError('candidate_interview_reschedule_snapshot_required');
  }

  const currentStep = requireConversationStep(
    expected.currentStep,
    'candidate_interview_reschedule_expected_current_step'
  );
  if (!CANDIDATE_INTERVIEW_RESCHEDULE_PROGRESS_ORIGINS.has(currentStep)) {
    throw new TypeError('candidate_interview_reschedule_expected_step_invalid');
  }

  return {
    currentStep,
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_interview_reschedule_expected_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(
      expected.reminderState,
      'candidate_interview_reschedule_expected_reminder_state'
    )
  };
}

function candidateInterviewRescheduleProgressExpectedWhere(snapshot) {
  return {
    currentStep: snapshot.currentStep,
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor),
    reminderState: snapshot.reminderState
  };
}

export async function reflectCandidateInterviewRescheduleProgress(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);

  if (Object.hasOwn(input, 'nextStep')) {
    throw new TypeError('candidate_interview_reschedule_next_step_not_allowed');
  }
  if (Object.hasOwn(input, 'update') || Object.hasOwn(input, 'data')) {
    throw new TypeError('candidate_interview_reschedule_patch_not_allowed');
  }

  const expected = normalizeCandidateInterviewRescheduleProgressSnapshot(input.expected);
  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      ...candidateInterviewRescheduleProgressExpectedWhere(expected)
    },
    data: {
      currentStep: ConversationStep.SCHEDULING,
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  });
  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    expected,
    nextStep: ConversationStep.SCHEDULING,
    nextReminderState: ReminderState.SKIPPED
  };
}
'''
if service_marker not in service:
    raise RuntimeError("candidateStateService insertion marker not found")
service = service.replace(service_marker, service_block + service_marker, 1)
write(service_path, service)


# ---------------------------------------------------------------------------
# chatEngine: reserva primero, alternativa preservada, CAS antes de responder.
# ---------------------------------------------------------------------------
chat_path = "src/services/chatEngine.js"
chat = read(chat_path)
chat = replace_once(
    chat,
    "import { applyInterviewReminderResponse } from './interviewBookingStateService.js';\n",
    "import { applyInterviewReminderResponse } from './interviewBookingStateService.js';\nimport { reflectCandidateInterviewRescheduleProgress } from './candidateStateService.js';\n",
    "chatEngine CandidateStateService import",
)
old_reschedule = r'''  if (intent === 'reschedule_interview') {
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
      ? `Listo, dejé marcada la solicitud de reprogramación. Te puedo ofrecer ${alternative.formattedDate}; si te sirve, respóndeme confirmando ese horario.`
      : 'Listo, dejé marcada la solicitud de reprogramación. En este momento no tengo otro horario válido para ofrecerte, así que el equipo te contactará para ayudarte con la reprogramación.';

    return buildEngineHandledResult({ currentStep: ConversationStep.SCHEDULING, intent, classification, reply });
  }'''
new_reschedule = r'''  if (intent === 'reschedule_interview') {
    const lastInboundAt = candidate.lastInboundAt ? new Date(candidate.lastInboundAt) : null;
    const alternative = nextSlot?.slot && !nextSlot?.isConfirmedBooking
      ? nextSlot
      : (vacancy?.id
        ? await getNextAvailableSlotAfter(prisma, vacancy.id, lastInboundAt, booking, now).catch(() => null)
        : null);

    const progressTransition = await reflectCandidateInterviewRescheduleProgress(prisma, {
      candidateId: candidate.id,
      expected: {
        currentStep,
        reminderScheduledFor: candidate.reminderScheduledFor ?? null,
        reminderState: candidate.reminderState
      }
    });

    if (progressTransition.count !== 1) {
      const observedCandidate = progressTransition.candidate || candidate;
      console.warn('[STALE_CANDIDATE_RESCHEDULE_PROGRESS]', JSON.stringify({
        candidateId: candidate.id,
        bookingId: booking.id,
        expectedStep: currentStep,
        observedStep: observedCandidate?.currentStep || null,
        expectedReminderState: candidate.reminderState || null,
        observedReminderState: observedCandidate?.reminderState || null
      }));
      return {
        ...buildEngineHandledResult({
          reply: null,
          currentStep: observedCandidate?.currentStep || currentStep,
          intent,
          classification
        }),
        suppressed: true,
        suppressedReason: 'stale_candidate_reschedule_progress',
        candidateProgressConflict: true
      };
    }

    const reply = alternative?.slot
      ? `Listo, dejé marcada la solicitud de reprogramación. Te puedo ofrecer ${alternative.formattedDate}; si te sirve, respóndeme confirmando ese horario.`
      : 'Listo, dejé marcada la solicitud de reprogramación. En este momento no tengo otro horario válido para ofrecerte, así que el equipo te contactará para ayudarte con la reprogramación.';

    return buildEngineHandledResult({ currentStep: ConversationStep.SCHEDULING, intent, classification, reply });
  }'''
chat = replace_once(chat, old_reschedule, new_reschedule, "chatEngine reschedule branch")
write(chat_path, chat)


# ---------------------------------------------------------------------------
# Prueba unitaria de la nueva autoridad.
# ---------------------------------------------------------------------------
service_test_path = "test/candidateInterviewRescheduleProgressStateService.test.js"
service_test = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep, ReminderState } from '@prisma/client';
import { reflectCandidateInterviewRescheduleProgress } from '../src/services/candidateStateService.js';

function matchesDate(actual, expected) {
  if (expected === null) return actual === null;
  const date = actual instanceof Date ? actual : new Date(actual);
  return date >= expected.gte && date < expected.lt;
}

function createClient(initialState) {
  let state = { ...initialState };
  const calls = { updateMany: [], findUnique: [], transaction: 0 };
  return {
    calls,
    getState: () => ({ ...state }),
    candidate: {
      updateMany: async (args) => {
        calls.updateMany.push(args);
        const where = args.where;
        const matches = state.id === where.id
          && state.currentStep === where.currentStep
          && matchesDate(state.reminderScheduledFor, where.reminderScheduledFor)
          && state.reminderState === where.reminderState;
        if (!matches) return { count: 0 };
        state = { ...state, ...args.data };
        return { count: 1 };
      },
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return state.id === args.where.id ? { ...state } : null;
      }
    },
    $transaction: async () => {
      calls.transaction += 1;
      throw new Error('nested_transaction_not_allowed');
    }
  };
}

function candidate(overrides = {}) {
  return {
    id: 'candidate-reschedule-progress-1',
    currentStep: ConversationStep.SCHEDULED,
    reminderScheduledFor: new Date('2026-07-23T14:00:00.000Z'),
    reminderState: ReminderState.SCHEDULED,
    ...overrides
  };
}

function input(snapshot, overrides = {}) {
  return {
    candidateId: snapshot.id,
    expected: {
      currentStep: snapshot.currentStep,
      reminderScheduledFor: snapshot.reminderScheduledFor,
      reminderState: snapshot.reminderState
    },
    ...overrides
  };
}

test('refleja la reprogramación con snapshot exacto y tres campos fijos', async () => {
  const snapshot = candidate();
  const client = createClient(snapshot);
  const result = await reflectCandidateInterviewRescheduleProgress(client, input(snapshot));

  assert.equal(result.count, 1);
  assert.deepEqual(client.calls.updateMany[0].data, {
    currentStep: ConversationStep.SCHEDULING,
    reminderScheduledFor: null,
    reminderState: ReminderState.SKIPPED
  });
  assert.equal(result.candidate.currentStep, ConversationStep.SCHEDULING);
  assert.equal(result.candidate.reminderScheduledFor, null);
  assert.equal(result.candidate.reminderState, ReminderState.SKIPPED);
});

test('una carrera por paso, fecha o estado conserva el candidato vigente', async () => {
  const expected = candidate();
  const races = [
    { currentStep: ConversationStep.SCHEDULING },
    { reminderScheduledFor: new Date('2026-07-24T14:00:00.000Z') },
    { reminderState: ReminderState.SENT }
  ];

  for (const race of races) {
    const current = candidate(race);
    const client = createClient(current);
    const result = await reflectCandidateInterviewRescheduleProgress(client, input(expected));
    assert.equal(result.count, 0);
    assert.deepEqual(client.getState(), current);
    assert.equal(client.calls.updateMany.length, 1);
  }
});

test('acepta recordatorio nulo en el snapshot', async () => {
  const snapshot = candidate({
    currentStep: ConversationStep.SCHEDULING,
    reminderScheduledFor: null,
    reminderState: ReminderState.NONE
  });
  const client = createClient(snapshot);
  const result = await reflectCandidateInterviewRescheduleProgress(client, input(snapshot));

  assert.equal(result.count, 1);
  assert.equal(client.calls.updateMany[0].where.reminderScheduledFor, null);
});

test('rechaza clientes, snapshots, enums y patches arbitrarios inválidos', async () => {
  const snapshot = candidate();
  const valid = input(snapshot);
  const cases = [
    [{}, valid, /candidate_state_client_required/],
    [createClient(snapshot), { ...valid, candidateId: '' }, /candidate_id_required/],
    [createClient(snapshot), { ...valid, expected: null }, /candidate_interview_reschedule_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: [] }, /candidate_interview_reschedule_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: { currentStep: snapshot.currentStep, reminderState: snapshot.reminderState } }, /candidate_interview_reschedule_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, currentStep: ConversationStep.DONE } }, /candidate_interview_reschedule_expected_step_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, currentStep: 'INVALID' } }, /candidate_interview_reschedule_expected_current_step_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderScheduledFor: true } }, /candidate_interview_reschedule_expected_reminder_scheduled_for_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderState: 'INVALID' } }, /candidate_interview_reschedule_expected_reminder_state_invalid/],
    [createClient(snapshot), { ...valid, nextStep: ConversationStep.SCHEDULED }, /candidate_interview_reschedule_next_step_not_allowed/],
    [createClient(snapshot), { ...valid, update: {} }, /candidate_interview_reschedule_patch_not_allowed/],
    [createClient(snapshot), { ...valid, data: {} }, /candidate_interview_reschedule_patch_not_allowed/]
  ];

  for (const [client, args, pattern] of cases) {
    await assert.rejects(() => reflectCandidateInterviewRescheduleProgress(client, args), pattern);
    assert.equal(client.calls?.updateMany?.length || 0, 0);
  }
});

test('reutiliza Prisma o tx sin abrir una transacción anidada', async () => {
  const snapshot = candidate();
  const client = createClient(snapshot);
  await reflectCandidateInterviewRescheduleProgress(client, input(snapshot));
  assert.equal(client.calls.transaction, 0);
});
'''
write(service_test_path, service_test)


# ---------------------------------------------------------------------------
# Contratos estáticos de chatEngine existentes, ahora con autoridad CAS.
# ---------------------------------------------------------------------------
chat_test_path = "test/chatEngineInterviewBookingAuthority.test.js"
chat_test = read(chat_test_path)
old_chat_test = r'''test('la reprogramación conserva la reserva y busca alternativa antes de cambiar el paso', () => {
  assert.doesNotMatch(handler, /status:\s*['"]RESCHEDULED['"]/);

  const rescheduleStart = handler.indexOf("if (intent === 'reschedule_interview')");
  assert.ok(rescheduleStart >= 0, 'No se encontró la rama de reprogramación.');
  const rescheduleBranch = handler.slice(rescheduleStart);
  const alternativeIndex = rescheduleBranch.indexOf('getNextAvailableSlotAfter');
  const candidateUpdateIndex = rescheduleBranch.indexOf('prisma.candidate.update');

  assert.ok(alternativeIndex >= 0, 'No se encontró la búsqueda del horario alternativo.');
  assert.ok(candidateUpdateIndex >= 0, 'No se encontró la actualización del paso del candidato.');
  assert.ok(alternativeIndex < candidateUpdateIndex, 'La alternativa debe resolverse antes de cambiar el paso.');
});'''
new_chat_test = r'''test('la reprogramación conserva la reserva, busca alternativa y delega el reflejo del candidato', () => {
  assert.doesNotMatch(handler, /status:\s*['"]RESCHEDULED['"]/);

  const rescheduleStart = handler.indexOf("if (intent === 'reschedule_interview')");
  assert.ok(rescheduleStart >= 0, 'No se encontró la rama de reprogramación.');
  const rescheduleBranch = handler.slice(rescheduleStart);
  const alternativeIndex = rescheduleBranch.indexOf('getNextAvailableSlotAfter');
  const progressIndex = rescheduleBranch.indexOf('reflectCandidateInterviewRescheduleProgress');
  const replyIndex = rescheduleBranch.indexOf('const reply =');

  assert.ok(alternativeIndex >= 0, 'No se encontró la búsqueda del horario alternativo.');
  assert.ok(progressIndex >= 0, 'No se encontró la autoridad de progreso del candidato.');
  assert.ok(replyIndex >= 0, 'No se encontró la construcción de la respuesta final.');
  assert.ok(alternativeIndex < progressIndex, 'La búsqueda de alternativa debe conservar su orden previo.');
  assert.ok(progressIndex < replyIndex, 'El CAS debe resolverse antes de construir la respuesta final.');
  assert.doesNotMatch(rescheduleBranch, /prisma\.candidate\.update\s*\(/);
});

test('la reserva se transiciona antes del CAS y un conflicto suprime la respuesta', () => {
  const bookingTransitionIndex = handler.indexOf('applyInterviewReminderResponse');
  const progressIndex = handler.indexOf('reflectCandidateInterviewRescheduleProgress');

  assert.ok(bookingTransitionIndex >= 0 && progressIndex > bookingTransitionIndex);
  assert.match(handler, /STALE_CANDIDATE_RESCHEDULE_PROGRESS/);
  assert.match(handler, /suppressed:\s*true/);
  assert.match(handler, /suppressedReason:\s*['"]stale_candidate_reschedule_progress['"]/);
  assert.match(handler, /candidateProgressConflict:\s*true/);
});'''
chat_test = replace_once(chat_test, old_chat_test, new_chat_test, "chatEngine authority test")
write(chat_test_path, chat_test)


# ---------------------------------------------------------------------------
# Manifiesto de autoridad de Candidate.
# ---------------------------------------------------------------------------
manifest_path = ROOT / "config/candidate-progress-authority.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["schemaVersion"] = 12
manifest["phase"] = "interview_reschedule_progress_authority_migrated"
if "interview_reschedule_progress_authority" not in manifest["completedSlices"]:
    manifest["completedSlices"].append("interview_reschedule_progress_authority")

for source in manifest["sourceInventory"]:
    if source["path"] == "src/services/candidateStateService.js":
        source["notes"] = (
            "Autoridad canónica del progreso multilinea, engine, consentimiento, vacancyFirstGate, "
            "captura silenciosa, reflejos administrativos de entrevista, pausa por revisión manual "
            "y reflejo de reprogramación mediante contratos estrechos y compare-and-set."
        )
    if source["path"] == "src/services/chatEngine.js":
        source["notes"] = (
            "Delega el reflejo de reprogramación en CandidateStateService y la reducción general en act(); "
            "conserva escrituras determinísticas de vacante pausada y otras ramas aún no migradas."
        )

family = next(
    (item for item in manifest["transitionFamilies"] if item["id"] == "appointment_reschedule_direct"),
    None,
)
if not family:
    raise RuntimeError("appointment_reschedule_direct family not found")
family.update({
    "id": "appointment_reschedule_progress_reflection",
    "writers": ["src/services/candidateStateService.js"],
    "trigger": "Solicitud explícita de reprogramación ya aceptada por la autoridad canónica de InterviewBooking.",
    "concurrency": "CandidateStateService compara id, currentStep, fecha y estado del recordatorio; count cero conserva el candidato vigente y chatEngine suprime la respuesta obsoleta.",
    "idempotency": "La reserva conserva su transición canónica; repetir con el snapshot anterior devuelve count cero y no aplica un patch parcial."
})

if not any(item["id"] == "interview_reschedule_progress_reflection" for item in manifest["compositeContracts"]):
    manifest["compositeContracts"].append({
        "id": "interview_reschedule_progress_reflection",
        "owner": "src/services/candidateStateService.js",
        "consumer": "src/services/chatEngine.js",
        "responseConsumer": "src/services/chatEngine.js",
        "status": "canonical",
        "allowedFields": [
            "currentStep",
            "reminderScheduledFor",
            "reminderState"
        ],
        "observedFields": [
            "currentStep",
            "reminderScheduledFor",
            "reminderState"
        ],
        "origins": [
            "SCHEDULING",
            "SCHEDULED"
        ],
        "preconditions": [
            "candidateId requerido",
            "reserva ya transicionada por InterviewBookingStateService",
            "snapshot explícito de paso y recordatorio",
            "nextStep y patch arbitrario prohibidos"
        ],
        "mutation": {
            "currentStep": "SCHEDULING",
            "reminderScheduledFor": None,
            "reminderState": "SKIPPED"
        },
        "concurrency": "updateMany compara id, currentStep, reminderScheduledFor y reminderState; count cero conserva el estado vigente.",
        "idempotency": "Una segunda ejecución con el snapshot anterior devuelve count cero sin revertir ni duplicar la transición de la reserva.",
        "conflictPolicy": "chatEngine registra STALE_CANDIDATE_RESCHEDULE_PROGRESS y devuelve silencio controlado antes de construir la respuesta final.",
        "excludedCombinations": [
            "confirm_attendance",
            "cancel_interview",
            "new_booking_creation",
            "paused_vacancy",
            "gender_logic"
        ]
    })

manifest["nextMigrationSlices"] = [
    "migrar las demás ramas legacy del webhook por familias pequeñas",
    "migrar cancelación de entrevista y decisiones de vacante pausada en chatEngine"
]
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Gate permanente de progreso.
# ---------------------------------------------------------------------------
progress_test_path = "test/candidateProgressAuthority.test.js"
progress_test = read(progress_test_path)
progress_test = replace_once(
    progress_test,
    "assert.equal(manifest.phase, 'manual_review_pause_authority_migrated');",
    "assert.equal(manifest.phase, 'interview_reschedule_progress_authority_migrated');",
    "candidate progress phase",
)
progress_test = replace_once(
    progress_test,
    "    'admin_interview_progress_authority',\n    'manual_review_pause_authority'\n",
    "    'admin_interview_progress_authority',\n    'manual_review_pause_authority',\n    'interview_reschedule_progress_authority'\n",
    "candidate progress completed slices",
)
progress_test = replace_once(
    progress_test,
    "assert.equal(manifest.compositeContracts.length, 6);",
    "assert.equal(manifest.compositeContracts.length, 7);",
    "candidate progress composite contract count",
)
progress_append = r'''


test('el manifiesto registra la autoridad del reflejo de reprogramación', () => {
  const contract = manifest.compositeContracts.find((item) => item.id === 'interview_reschedule_progress_reflection');
  assert.ok(contract);
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/services/chatEngine.js');
  assert.equal(contract.responseConsumer, 'src/services/chatEngine.js');
  assert.equal(contract.status, 'canonical');
  assert.deepEqual(contract.allowedFields, [
    'currentStep',
    'reminderScheduledFor',
    'reminderState'
  ]);
  assert.deepEqual(contract.origins, ['SCHEDULING', 'SCHEDULED']);
  assert.ok(contract.excludedCombinations.includes('cancel_interview'));
  assert.ok(contract.excludedCombinations.includes('gender_logic'));

  const family = manifest.transitionFamilies.find((item) => item.id === 'appointment_reschedule_progress_reflection');
  assert.ok(family);
  assert.deepEqual(family.writers, ['src/services/candidateStateService.js']);
  assert.deepEqual(family.destinations, ['SCHEDULING']);

  const authority = extractFunctionSource(
    readSource('src/services/candidateStateService.js'),
    'reflectCandidateInterviewRescheduleProgress'
  );
  assert.match(authority, /candidate\.updateMany\s*\(/);
  assert.match(authority, /candidateInterviewRescheduleProgressExpectedWhere\(expected\)/);
  assert.match(authority, /currentStep:\s*ConversationStep\.SCHEDULING/);
  assert.match(authority, /reminderScheduledFor:\s*null/);
  assert.match(authority, /reminderState:\s*ReminderState\.SKIPPED/);
  assert.match(authority, /candidate_interview_reschedule_next_step_not_allowed/);
  assert.match(authority, /candidate_interview_reschedule_patch_not_allowed/);
  assert.doesNotMatch(authority, /InterviewBooking|interviewBooking|gender|vacancyId|botPaused/);
});

test('chatEngine delega la reprogramación y suprime respuestas sobre snapshots obsoletos', () => {
  const handler = extractFunctionSource(readSource('src/services/chatEngine.js'), 'handleAppointmentIntentDirectly');
  const rescheduleStart = handler.indexOf("if (intent === 'reschedule_interview')");
  assert.ok(rescheduleStart >= 0);
  const rescheduleBranch = handler.slice(rescheduleStart);

  assert.match(rescheduleBranch, /reflectCandidateInterviewRescheduleProgress/);
  assert.match(rescheduleBranch, /STALE_CANDIDATE_RESCHEDULE_PROGRESS/);
  assert.match(rescheduleBranch, /suppressedReason:\s*['"]stale_candidate_reschedule_progress['"]/);
  assert.doesNotMatch(rescheduleBranch, /prisma\.candidate\.update\s*\(/);

  const transitionIndex = handler.indexOf('applyInterviewReminderResponse');
  const reflectionIndex = handler.indexOf('reflectCandidateInterviewRescheduleProgress');
  const replyIndex = rescheduleBranch.indexOf('const reply =');
  assert.ok(transitionIndex >= 0 && reflectionIndex > transitionIndex);
  assert.ok(replyIndex > rescheduleBranch.indexOf('reflectCandidateInterviewRescheduleProgress'));
});

test('la documentación registra la fase del reflejo de reprogramación', () => {
  const documentation = readSource('docs/architecture/candidate-state-transition-inventory.md');
  assert.match(documentation, /Fase 12: reflejo de reprogramación/);
  assert.match(documentation, /reflectCandidateInterviewRescheduleProgress/);
  assert.match(documentation, /STALE_CANDIDATE_RESCHEDULE_PROGRESS/);
  assert.match(documentation, /no construye ni envía la respuesta obsoleta/i);
});
'''
if "Fase 12: reflejo de reprogramación" not in progress_test:
    progress_test += progress_append
write(progress_test_path, progress_test)


# ---------------------------------------------------------------------------
# Documentación arquitectónica.
# ---------------------------------------------------------------------------
doc_path = "docs/architecture/candidate-state-transition-inventory.md"
doc = read(doc_path)
phase = r'''


## Fase 12: reflejo de reprogramación

`handleAppointmentIntentDirectly()` conserva la clasificación de intención y entrega
primero la solicitud a `InterviewBookingStateService`. Cuando la reserva acepta la
transición de reprogramación, `reflectCandidateInterviewRescheduleProgress()` pasa a
ser el escritor exclusivo del reflejo en `Candidate`.

La autoridad exige un snapshot explícito de `currentStep`, `reminderScheduledFor` y
`reminderState`, limita los orígenes a `SCHEDULING` o `SCHEDULED` y fija únicamente
`SCHEDULING / null / SKIPPED`. No acepta `nextStep`, `data` ni un patch arbitrario y
reutiliza Prisma raíz o un cliente transaccional sin abrir otra transacción.

La búsqueda del horario alternativo conserva su comportamiento. El CAS se resuelve
antes de construir la respuesta final. Si `updateMany` devuelve `count=0`, la reserva
mantiene su transición canónica, `chatEngine` registra
`STALE_CANDIDATE_RESCHEDULE_PROGRESS` y no construye ni envía la respuesta obsoleta.
No reintenta ni aplica parcialmente.

Confirmación, cancelación, creación de una nueva reserva, disponibilidad, vacantes
pausadas, webhook, consentimiento, CV, perfil, permisos, asistencia, Prisma y cualquier
lógica relacionada con género permanecen fuera de esta fase.
'''
if "## Fase 12: reflejo de reprogramación" not in doc:
    doc += phase
write(doc_path, doc)


# ---------------------------------------------------------------------------
# Retiro de auxiliares temporales de esta aplicación.
# ---------------------------------------------------------------------------
for relative_path in [
    ".github/workflows/apply-562-candidate-reschedule-progress-authority.yml",
    "scripts/apply-562-candidate-reschedule-progress-authority.py"
]:
    target = ROOT / relative_path
    if target.exists():
        target.unlink()

print("Slice #562 aplicado correctamente")
