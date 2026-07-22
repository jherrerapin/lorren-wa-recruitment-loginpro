from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one anchor, found {count}")
    return text.replace(old, new, 1)


def replace_in_section(
    text: str,
    start_marker: str,
    end_marker: str,
    old: str,
    new: str,
    label: str,
) -> str:
    start = text.find(start_marker)
    end = text.find(end_marker, start + len(start_marker))
    if start < 0 or end < 0:
        raise RuntimeError(f"{label}: section markers not found")
    section = text[start:end]
    updated = replace_once(section, old, new, label)
    return text[:start] + updated + text[end:]


# ---------------------------------------------------------------------------
# CandidateStateService: autoridad estrecha para reflejar acciones admin.
# ---------------------------------------------------------------------------
service_path = "src/services/candidateStateService.js"
service = read(service_path)
service_marker = "\n\nconst CONSENT_STEP_DESTINATIONS = new Set(["
service_block = r'''

export const CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS = Object.freeze({
  MANUAL_BOOKING_CREATED: 'MANUAL_BOOKING_CREATED',
  LAST_BOOKING_DELETED: 'LAST_BOOKING_DELETED'
});

const CANDIDATE_ADMIN_INTERVIEW_PROGRESS_DESTINATIONS = new Map([
  [
    CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
    ConversationStep.SCHEDULED
  ],
  [
    CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.LAST_BOOKING_DELETED,
    ConversationStep.SCHEDULING
  ]
]);

function requireCandidateAdminInterviewProgressAction(value) {
  const action = String(value || '').trim();
  if (!CANDIDATE_ADMIN_INTERVIEW_PROGRESS_DESTINATIONS.has(action)) {
    throw new TypeError('candidate_admin_interview_action_invalid');
  }
  return action;
}

export async function reflectCandidateAdminInterviewProgress(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const action = requireCandidateAdminInterviewProgressAction(input.action);
  const expectedStep = requireConversationStep(
    input.expected?.currentStep,
    'candidate_admin_interview_expected_current_step'
  );
  const actor = requireNonEmptyString(input.actor, 'candidate_admin_interview_actor');
  const reason = requireNonEmptyString(input.reason, 'candidate_admin_interview_reason');

  if (Object.hasOwn(input, 'nextStep')) {
    throw new TypeError('candidate_admin_interview_next_step_not_allowed');
  }

  const nextStep = CANDIDATE_ADMIN_INTERVIEW_PROGRESS_DESTINATIONS.get(action);
  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      currentStep: expectedStep
    },
    data: {
      currentStep: nextStep
    }
  });
  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    action,
    actor,
    reason,
    expectedStep,
    nextStep
  };
}
'''
if service_marker not in service:
    raise RuntimeError("candidateStateService: insertion marker not found")
service = service.replace(service_marker, service_block + service_marker, 1)
write(service_path, service)


# ---------------------------------------------------------------------------
# admin.js: delegar los dos reflejos de progreso de entrevistas.
# ---------------------------------------------------------------------------
admin_path = "src/routes/admin.js"
admin = read(admin_path)

admin = replace_once(
    admin,
    """import {
  pauseCandidateAutomationFromAdmin,
  recordManualWhatsAppOpen,
  resumeCandidateAutomationFromAdmin
} from '../services/candidateStateService.js';""",
    """import {
  CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS,
  pauseCandidateAutomationFromAdmin,
  recordManualWhatsAppOpen,
  reflectCandidateAdminInterviewProgress,
  resumeCandidateAutomationFromAdmin
} from '../services/candidateStateService.js';""",
    "admin import CandidateStateService",
)

# Eliminar una reserva: leer snapshot del candidato y reflejar después de que la
# autoridad de reservas confirme la eliminación, sin mezclar transacciones.
delete_start = "router.post('/interviews/:id/delete'"
delete_end = "router.post('/candidates/:id/interview-assign'"
admin = replace_in_section(
    admin,
    delete_start,
    delete_end,
    """      select: {
        id: true,
        candidateId: true
      }""",
    """      select: {
        id: true,
        candidateId: true,
        candidate: {
          select: { currentStep: true }
        }
      }""",
    "admin delete booking snapshot",
)
admin = replace_in_section(
    admin,
    delete_start,
    delete_end,
    """      if (!remainingActiveBooking) {
        await tx.candidate.update({
          where: { id: booking.candidateId },
          data: {
            currentStep: ConversationStep.SCHEDULING
          }
        });
      }

      return { deleted: true };""",
    """      return {
        deleted: true,
        shouldReflectProgress: !remainingActiveBooking
      };""",
    "admin delete direct Candidate update",
)
admin = replace_in_section(
    admin,
    delete_start,
    delete_end,
    """    if (!deletionResult.deleted) {
      return res.redirect(withFlashMessage(
        returnTo,
        'error',
        'El agendamiento cambió mientras se procesaba la eliminación. Actualiza la página e intenta nuevamente.'
      ));
    }

    return res.redirect(withFlashMessage(returnTo, 'success', 'Agendamiento eliminado correctamente.'));""",
    """    if (!deletionResult.deleted) {
      return res.redirect(withFlashMessage(
        returnTo,
        'error',
        'El agendamiento cambió mientras se procesaba la eliminación. Actualiza la página e intenta nuevamente.'
      ));
    }

    let progressTransition = null;
    if (deletionResult.shouldReflectProgress) {
      try {
        progressTransition = await reflectCandidateAdminInterviewProgress(prisma, {
          candidateId: booking.candidateId,
          action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.LAST_BOOKING_DELETED,
          expected: { currentStep: booking.candidate.currentStep },
          actor: req.username || req.userRole || 'dev',
          reason: 'Última entrevista activa eliminada desde administración'
        });
      } catch (progressError) {
        console.error('[admin_interview_delete_progress_update]', {
          candidateId: booking.candidateId,
          expectedStep: booking.candidate.currentStep,
          progressError
        });
        progressTransition = { count: 0, candidate: null, error: progressError };
      }

      if (progressTransition.count !== 1) {
        console.warn('[admin_interview_delete_progress_conflict]', {
          candidateId: booking.candidateId,
          expectedStep: booking.candidate.currentStep,
          observedStep: progressTransition.candidate?.currentStep || null
        });
      }
    }

    const successMessage = deletionResult.shouldReflectProgress && progressTransition?.count !== 1
      ? 'Agendamiento eliminado correctamente. El progreso del candidato cambió en paralelo y se conservó su estado más reciente.'
      : 'Agendamiento eliminado correctamente.';
    return res.redirect(withFlashMessage(returnTo, 'success', successMessage));""",
    "admin delete progress reflection",
)

# Asignación manual: leer currentStep, crear booking canónico y reflejar con CAS.
assign_start = "router.post('/candidates/:id/interview-assign'"
assign_end = "router.post('/candidates/:id/status'"
admin = replace_in_section(
    admin,
    assign_start,
    assign_end,
    """          id: true,
          vacancyId: true,
          lastInboundAt: true,""",
    """          id: true,
          currentStep: true,
          vacancyId: true,
          lastInboundAt: true,""",
    "admin assign currentStep snapshot",
)
admin = replace_in_section(
    admin,
    assign_start,
    assign_end,
    """      try {
        await prisma.candidate.update({
          where: { id: candidate.id },
          data: { currentStep: ConversationStep.SCHEDULED }
        });
      } catch (stepError) {
        console.error('[manual_interview_assign_step_update]', {
          candidateId: candidate.id,
          preferredStep: ConversationStep.SCHEDULED,
          stepError
        });
        try {
          await prisma.candidate.update({
            where: { id: candidate.id },
            data: { currentStep: ConversationStep.SCHEDULING }
          });
        } catch (fallbackStepError) {
          console.error('[manual_interview_assign_step_update_fallback]', {
            candidateId: candidate.id,
            fallbackStep: ConversationStep.SCHEDULING,
            fallbackStepError
          });
        }
      }

      await logCandidateAdminEvent(prisma, {
        candidateId: candidate.id,
        actorRole: req.userRole,
        eventType: 'INTERVIEW_ASSIGNED',
        eventLabel: 'Asignó entrevista manualmente',
        note: chosenOffer.formattedDate
      });

    return res.redirect(withFlashMessage(returnTo, 'success', `Entrevista asignada para ${chosenOffer.formattedDate}.`));""",
    """      let progressTransition = null;
      try {
        progressTransition = await reflectCandidateAdminInterviewProgress(prisma, {
          candidateId: candidate.id,
          action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
          expected: { currentStep: candidate.currentStep },
          actor: req.username || req.userRole || 'dev',
          reason: 'Entrevista asignada manualmente desde administración'
        });
      } catch (progressError) {
        console.error('[manual_interview_assign_progress_update]', {
          candidateId: candidate.id,
          expectedStep: candidate.currentStep,
          progressError
        });
        progressTransition = { count: 0, candidate: null, error: progressError };
      }

      if (progressTransition.count !== 1) {
        console.warn('[manual_interview_assign_progress_conflict]', {
          candidateId: candidate.id,
          expectedStep: candidate.currentStep,
          observedStep: progressTransition.candidate?.currentStep || null
        });
      }

      await logCandidateAdminEvent(prisma, {
        candidateId: candidate.id,
        actorRole: req.userRole,
        eventType: 'INTERVIEW_ASSIGNED',
        eventLabel: 'Asignó entrevista manualmente',
        note: progressTransition.count === 1
          ? chosenOffer.formattedDate
          : `${chosenOffer.formattedDate}. El progreso conversacional cambió en paralelo y se conservó.`
      });

      const assignmentMessage = progressTransition.count === 1
        ? `Entrevista asignada para ${chosenOffer.formattedDate}.`
        : `Entrevista asignada para ${chosenOffer.formattedDate}. El progreso del candidato cambió en paralelo y se conservó su estado más reciente.`;
      return res.redirect(withFlashMessage(returnTo, 'success', assignmentMessage));""",
    "admin assign progress reflection",
)
write(admin_path, admin)


# ---------------------------------------------------------------------------
# Manifiesto canónico.
# ---------------------------------------------------------------------------
manifest_path = ROOT / "config/candidate-progress-authority.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["schemaVersion"] = 10
manifest["phase"] = "admin_interview_progress_authority_migrated"
if "admin_interview_progress_authority" not in manifest["completedSlices"]:
    manifest["completedSlices"].append("admin_interview_progress_authority")

for source in manifest["sourceInventory"]:
    if source["path"] == "src/services/candidateStateService.js":
        source["notes"] = (
            "Autoridad canónica del progreso multilinea, engine, consentimiento, "
            "vacancyFirstGate, captura silenciosa y reflejos administrativos de entrevista "
            "mediante contratos estrechos y compare-and-set."
        )
    if source["path"] == "src/routes/admin.js":
        source["role"] = "indirect_writer"
        source["notes"] = (
            "Lee currentStep para panel y acciones administrativas; los reflejos de asignación "
            "y eliminación de entrevistas delegan en CandidateStateService con actor, motivo y origen esperado."
        )

admin_family = next(
    family for family in manifest["transitionFamilies"]
    if family["id"] == "admin_progress_override"
)
admin_family.update({
    "id": "admin_interview_progress_reflection",
    "owners": ["src/routes/admin.js"],
    "writers": ["src/services/candidateStateService.js"],
    "origins": ["*"],
    "destinations": ["SCHEDULING", "SCHEDULED"],
    "allowedFields": ["currentStep"],
    "trigger": "Asignación manual de entrevista o eliminación administrativa de la última reserva activa.",
    "concurrency": "CandidateStateService compara candidateId y currentStep observado; count cero conserva el paso más reciente sin revertir la mutación canónica de InterviewBooking.",
    "idempotency": "Cada acción fija su destino y no acepta nextStep arbitrario; repetir con un snapshot obsoleto devuelve count cero.",
    "externalEffects": ["interview_booking_transition", "admin_audit"]
})

if not any(item["id"] == "admin_interview_progress_reflection" for item in manifest["stepContracts"]):
    manifest["stepContracts"].append({
        "id": "admin_interview_progress_reflection",
        "owner": "src/services/candidateStateService.js",
        "consumer": "src/routes/admin.js",
        "status": "canonical",
        "actions": {
            "MANUAL_BOOKING_CREATED": "SCHEDULED",
            "LAST_BOOKING_DELETED": "SCHEDULING"
        },
        "allowedFields": ["currentStep"],
        "preconditions": [
            "candidateId requerido",
            "currentStep esperado válido",
            "acción administrativa conocida",
            "actor y motivo no vacíos",
            "nextStep arbitrario prohibido"
        ],
        "mutation": {
            "currentStep": "destino fijo derivado de la acción"
        },
        "concurrency": "updateMany compara id y currentStep; count cero conserva el estado vigente.",
        "idempotency": "La misma acción converge si el snapshot coincide; una carrera no se presenta como transición aplicada.",
        "conflictPolicy": "La reserva permanece creada o eliminada por su autoridad; administración informa que conservó el progreso concurrente."
    })

manifest["nextMigrationSlices"] = [
    "migrar las demás ramas legacy del webhook por familias pequeñas",
    "migrar reflejos de agenda y vacantes pausadas en chatEngine"
]
manifest_path.write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)


# ---------------------------------------------------------------------------
# Prueba unitaria de la nueva autoridad.
# ---------------------------------------------------------------------------
unit_test = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep } from '@prisma/client';
import {
  CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS,
  reflectCandidateAdminInterviewProgress
} from '../src/services/candidateStateService.js';

function createHarness(initialCandidate) {
  let state = initialCandidate ? { ...initialCandidate } : null;
  const calls = { updateMany: [], findUnique: [], transactions: 0 };
  const client = {
    candidate: {
      updateMany: async (args) => {
        calls.updateMany.push(args);
        if (!state || state.id !== args.where.id || state.currentStep !== args.where.currentStep) {
          return { count: 0 };
        }
        state = { ...state, ...args.data };
        return { count: 1 };
      },
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return state && state.id === args.where.id ? { ...state } : null;
      }
    },
    $transaction: async () => {
      calls.transactions += 1;
      throw new Error('nested_transaction_not_allowed');
    }
  };
  return {
    client,
    calls,
    getState: () => (state ? { ...state } : null),
    setState: (next) => { state = next ? { ...next } : null; }
  };
}

const candidate = {
  id: 'candidate-admin-interview-1',
  currentStep: ConversationStep.CONFIRMING_DATA
};

test('la creación manual de reserva fija SCHEDULED mediante CAS', async () => {
  const { client, calls, getState } = createHarness(candidate);
  const result = await reflectCandidateAdminInterviewProgress(client, {
    candidateId: candidate.id,
    action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
    expected: { currentStep: ConversationStep.CONFIRMING_DATA },
    actor: 'devloginpro',
    reason: 'Entrevista asignada manualmente'
  });

  assert.equal(result.count, 1);
  assert.equal(result.nextStep, ConversationStep.SCHEDULED);
  assert.equal(result.candidate.currentStep, ConversationStep.SCHEDULED);
  assert.equal(getState().currentStep, ConversationStep.SCHEDULED);
  assert.deepEqual(calls.updateMany[0], {
    where: {
      id: candidate.id,
      currentStep: ConversationStep.CONFIRMING_DATA
    },
    data: { currentStep: ConversationStep.SCHEDULED }
  });
  assert.equal(calls.transactions, 0);
});

test('eliminar la última reserva fija SCHEDULING y reutiliza un cliente tx', async () => {
  const txHarness = createHarness({
    id: candidate.id,
    currentStep: ConversationStep.SCHEDULED
  });
  const result = await reflectCandidateAdminInterviewProgress(txHarness.client, {
    candidateId: candidate.id,
    action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.LAST_BOOKING_DELETED,
    expected: { currentStep: ConversationStep.SCHEDULED },
    actor: 'devloginpro',
    reason: 'Última reserva eliminada'
  });

  assert.equal(result.count, 1);
  assert.equal(result.nextStep, ConversationStep.SCHEDULING);
  assert.equal(txHarness.getState().currentStep, ConversationStep.SCHEDULING);
  assert.equal(txHarness.calls.transactions, 0);
});

test('una carrera devuelve count cero y conserva el paso observado', async () => {
  const { client, setState, getState } = createHarness(candidate);
  setState({ ...candidate, currentStep: ConversationStep.ASK_CV });

  const result = await reflectCandidateAdminInterviewProgress(client, {
    candidateId: candidate.id,
    action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
    expected: { currentStep: ConversationStep.CONFIRMING_DATA },
    actor: 'devloginpro',
    reason: 'Entrevista asignada manualmente'
  });

  assert.equal(result.count, 0);
  assert.equal(result.candidate.currentStep, ConversationStep.ASK_CV);
  assert.equal(getState().currentStep, ConversationStep.ASK_CV);
});

test('rechaza acción, snapshot, actor, motivo y nextStep arbitrario', async () => {
  const { client } = createHarness(candidate);

  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(null, {}),
    /candidate_state_client_required/
  );
  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(client, {
      candidateId: candidate.id,
      action: 'UNKNOWN',
      expected: { currentStep: ConversationStep.CONFIRMING_DATA },
      actor: 'dev',
      reason: 'test'
    }),
    /candidate_admin_interview_action_invalid/
  );
  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(client, {
      candidateId: candidate.id,
      action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
      expected: { currentStep: 'UNKNOWN_STEP' },
      actor: 'dev',
      reason: 'test'
    }),
    /candidate_admin_interview_expected_current_step_invalid/
  );
  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(client, {
      candidateId: candidate.id,
      action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
      expected: { currentStep: ConversationStep.CONFIRMING_DATA },
      actor: ' ',
      reason: 'test'
    }),
    /candidate_admin_interview_actor_required/
  );
  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(client, {
      candidateId: candidate.id,
      action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
      expected: { currentStep: ConversationStep.CONFIRMING_DATA },
      actor: 'dev',
      reason: ' '
    }),
    /candidate_admin_interview_reason_required/
  );
  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(client, {
      candidateId: candidate.id,
      action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
      expected: { currentStep: ConversationStep.CONFIRMING_DATA },
      actor: 'dev',
      reason: 'test',
      nextStep: ConversationStep.DONE
    }),
    /candidate_admin_interview_next_step_not_allowed/
  );
});
'''
write("test/candidateAdminInterviewProgressStateService.test.js", unit_test)


# ---------------------------------------------------------------------------
# Contratos estructurales de administración.
# ---------------------------------------------------------------------------
admin_test = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/admin.js', 'utf8');

function between(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `No se encontró el marcador inicial: ${start}`);
  assert.notEqual(endIndex, -1, `No se encontró el marcador final: ${end}`);
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
  assert.doesNotMatch(route, /status:\s*['"]RESCHEDULED['"]/);
});

test('el recordatorio manual usa solo los estados activos canónicos', () => {
  const route = between(
    "router.post('/interviews/:id/manual-reminder'",
    "router.post('/interviews/:id/delete'"
  );
  assert.match(route, /ACTIVE_INTERVIEW_BOOKING_STATUSES\.includes\(booking\.status\)/);
  assert.doesNotMatch(route, /ACTIVE_BOOKING_STATUSES\.includes\(booking\.status\)/);
});

test('la eliminación individual refleja SCHEDULING sin escritura directa de Candidate', () => {
  const route = between(
    "router.post('/interviews/:id/delete'",
    "router.post('/candidates/:id/interview-assign'"
  );
  assert.match(route, /deleteAdministrativeInterviewBooking\(tx,\s*\{/);
  assert.match(route, /bookingId:\s*booking\.id/);
  assert.match(route, /candidateId:\s*booking\.candidateId/);
  assert.match(route, /deletion\.count\s*===\s*0/);
  assert.match(route, /shouldReflectProgress:\s*!remainingActiveBooking/);
  assert.match(route, /reflectCandidateAdminInterviewProgress\(prisma,\s*\{/);
  assert.match(route, /CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS\.LAST_BOOKING_DELETED/);
  assert.match(route, /expected:\s*\{\s*currentStep:\s*booking\.candidate\.currentStep\s*\}/);
  assert.doesNotMatch(route, /(?:prisma|tx)\.candidate\.(?:update|updateMany)\s*\(/);
  assert.doesNotMatch(route, /nextStep\s*:/);

  const deletionIndex = route.indexOf('deleteAdministrativeInterviewBooking(tx');
  const remainingIndex = route.indexOf('remainingActiveBooking');
  const reflectionIndex = route.indexOf('reflectCandidateAdminInterviewProgress(prisma');
  assert.ok(deletionIndex >= 0 && deletionIndex < remainingIndex);
  assert.ok(remainingIndex < reflectionIndex);
});

test('la eliminación del candidato conserva el orden mensajes, reservas y candidato', () => {
  const route = between(
    "router.post('/candidates/:id/delete'",
    "router.post('/candidates/:id/edit'"
  );
  assert.match(route, /deleteCandidateInterviewBookings\(tx,\s*\{/);
  assert.match(route, /candidateId:\s*candidate\.id/);
  assert.doesNotMatch(route, /tx\.interviewBooking\.deleteMany\s*\(/);

  const messagesIndex = route.indexOf('deleteConversationMessagesForCandidate(tx');
  const bookingsIndex = route.indexOf('deleteCandidateInterviewBookings(tx');
  const candidateIndex = route.indexOf('tx.candidate.delete');
  assert.ok(messagesIndex >= 0 && messagesIndex < bookingsIndex);
  assert.ok(bookingsIndex < candidateIndex);
});

test('la asignación manual crea una reserva y refleja SCHEDULED mediante CAS', () => {
  const route = between(
    "router.post('/candidates/:id/interview-assign'",
    "router.post('/candidates/:id/status'"
  );

  assert.doesNotMatch(source, /\bcancelCandidateBookings\b/);
  assert.doesNotMatch(route, /prisma\.\$transaction\s*\(/);
  assert.doesNotMatch(route, /interviewBooking\.findFirst\s*\(/);
  assert.doesNotMatch(route, /\btx\b/);
  assert.doesNotMatch(route, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
  assert.doesNotMatch(route, /manual_interview_assign_step_update_fallback/);
  assert.doesNotMatch(route, /nextStep\s*:/);

  const createCalls = route.match(/\bcreateBooking\s*\(/g) || [];
  assert.equal(createCalls.length, 1, 'La ruta debe llamar createBooking exactamente una vez');
  assert.match(route, /await createBooking\(\s*prisma,\s*candidate\.id,\s*candidate\.vacancyId,\s*chosenOffer\.slot\.id,\s*chosenOffer\.date,\s*!chosenOffer\.windowOk\s*\)/s);
  assert.match(route, /currentStep:\s*true/);
  assert.match(route, /reflectCandidateAdminInterviewProgress\(prisma,\s*\{/);
  assert.match(route, /CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS\.MANUAL_BOOKING_CREATED/);
  assert.match(route, /expected:\s*\{\s*currentStep:\s*candidate\.currentStep\s*\}/);
  assert.match(route, /eventType:\s*['"]INTERVIEW_ASSIGNED['"]/);

  const availabilityIndex = route.indexOf('if (!chosenOffer?.slot)');
  const createIndex = route.indexOf('await createBooking(');
  const reflectionIndex = route.indexOf('reflectCandidateAdminInterviewProgress(prisma');
  const auditIndex = route.indexOf("eventType: 'INTERVIEW_ASSIGNED'");
  assert.ok(availabilityIndex >= 0 && availabilityIndex < createIndex);
  assert.ok(createIndex < reflectionIndex);
  assert.ok(reflectionIndex < auditIndex);
});
'''
write("test/adminInterviewBookingAuthority.test.js", admin_test)


# ---------------------------------------------------------------------------
# Gate de progreso: fase, slice y contrato nuevos.
# ---------------------------------------------------------------------------
progress_test_path = "test/candidateProgressAuthority.test.js"
progress_test = read(progress_test_path)
progress_test = replace_once(
    progress_test,
    "assert.equal(manifest.phase, 'silent_profile_capture_authority_migrated');",
    "assert.equal(manifest.phase, 'admin_interview_progress_authority_migrated');",
    "candidate progress phase",
)
progress_test = replace_once(
    progress_test,
    """    'consent_step_authority',
    'vacancy_first_gate_authority',
    'silent_profile_capture_authority'
  ]);""",
    """    'consent_step_authority',
    'vacancy_first_gate_authority',
    'silent_profile_capture_authority',
    'admin_interview_progress_authority'
  ]);""",
    "candidate progress completed slices",
)
progress_test += r'''

test('el manifiesto registra la autoridad administrativa de progreso de entrevistas', () => {
  const contract = manifest.stepContracts.find((item) => item.id === 'admin_interview_progress_reflection');
  assert.ok(contract);
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/routes/admin.js');
  assert.equal(contract.status, 'canonical');
  assert.deepEqual(contract.allowedFields, ['currentStep']);
  assert.deepEqual(contract.actions, {
    MANUAL_BOOKING_CREATED: 'SCHEDULED',
    LAST_BOOKING_DELETED: 'SCHEDULING'
  });

  const family = manifest.transitionFamilies.find((item) => item.id === 'admin_interview_progress_reflection');
  assert.ok(family);
  assert.deepEqual(family.writers, ['src/services/candidateStateService.js']);
  assert.deepEqual(family.destinations, ['SCHEDULING', 'SCHEDULED']);

  const authority = extractFunctionSource(
    readSource('src/services/candidateStateService.js'),
    'reflectCandidateAdminInterviewProgress'
  );
  assert.match(authority, /candidate\.updateMany\s*\(/);
  assert.match(authority, /currentStep\s*:\s*expectedStep/);
  assert.match(authority, /currentStep\s*:\s*nextStep/);
  assert.match(authority, /candidate_admin_interview_next_step_not_allowed/);
  assert.doesNotMatch(authority, /InterviewBooking|interviewBooking|status|gender|vacancyId|reminder/);

  const adminSource = manifest.sourceInventory.find((item) => item.path === 'src/routes/admin.js');
  assert.equal(adminSource.role, 'indirect_writer');
});

test('la documentación registra la fase administrativa de entrevistas', () => {
  const documentation = readSource('docs/architecture/candidate-state-transition-inventory.md');
  assert.match(documentation, /Fase 10: progreso administrativo de entrevistas/);
  assert.match(documentation, /reflectCandidateAdminInterviewProgress/);
  assert.match(documentation, /MANUAL_BOOKING_CREATED/);
  assert.match(documentation, /LAST_BOOKING_DELETED/);
  assert.match(documentation, /actor, motivo y origen esperado/i);
});
'''
write(progress_test_path, progress_test)


# ---------------------------------------------------------------------------
# Documentación del inventario.
# ---------------------------------------------------------------------------
doc_path = "docs/architecture/candidate-state-transition-inventory.md"
doc = read(doc_path)
phase_10 = r'''

## Fase 10: progreso administrativo de entrevistas

Las acciones administrativas de entrevista dejaron de escribir `Candidate.currentStep`
directamente desde `admin.js`.

`reflectCandidateAdminInterviewProgress()` es ahora la autoridad estrecha para dos
hechos ya confirmados por `InterviewBookingStateService`:

- `MANUAL_BOOKING_CREATED` fija `SCHEDULED`;
- `LAST_BOOKING_DELETED` fija `SCHEDULING` cuando no queda otra reserva activa.

El contrato exige `candidateId`, actor, motivo y origen esperado. La persistencia usa
`updateMany` como compare-and-set por `id + currentStep`; no acepta `nextStep`
arbitrario y puede reutilizar Prisma raíz o un cliente transaccional sin abrir una
transacción anidada.

La reserva conserva su resultado canónico aunque el reflejo de progreso encuentre una
carrera. En ese caso administración registra el conflicto, conserva el paso más
reciente y comunica que la reserva fue creada o eliminada sin afirmar que reemplazó el
progreso concurrente. Se retiró el fallback que degradaba a `SCHEDULING` después de una
asignación manual ya creada.

Esta fase no modifica disponibilidad, reservas, textos al candidato, consentimiento,
CV, perfil, recordatorios, permisos, asistencia ni ninguna lógica relacionada con
género.
'''
if "## Fase 10: progreso administrativo de entrevistas" not in doc:
    doc += phase_10
write(doc_path, doc)


# Los auxiliares temporales no deben llegar al commit funcional.
(ROOT / "scripts/apply-552-candidate-admin-interview-progress.py").unlink()
workflow = ROOT / ".github/workflows/apply-552-candidate-admin-interview-progress.yml"
if workflow.exists():
    workflow.unlink()

print("Slice #552 aplicado correctamente")
