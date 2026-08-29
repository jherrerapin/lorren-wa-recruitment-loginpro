import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveDispatchAttendanceFailureCoordinatorDecision } from '../src/services/dispatchWhatsappAdminAlerts.js';

const ASSIGNMENT_ID = 'assignment-route-gps-test';
const COORDINATOR_PHONE = '573000000111';
const FIFTH_FAILURE_ID = `attendance_failure_${'e'.repeat(48)}`;
const SIXTH_FAILURE_ID = `attendance_failure_${'f'.repeat(48)}`;

function failedAttempt(id, occurredAt, latitude, longitude) {
  return {
    id,
    entityType: 'DISPATCH_ATTENDANCE_MARK_FAILURE',
    entityId: ASSIGNMENT_ID,
    action: 'MARK_ATTEMPT_FAILED',
    createdAt: new Date(new Date(occurredAt).getTime() + 1000),
    metadata: {
      assignmentId: ASSIGNMENT_ID,
      markType: 'ARRIVAL',
      failureCode: 'outside_operation_range',
      phaseLabel: 'Ubicación',
      descriptionEs: 'La ubicación estaba fuera del rango permitido para marcar.',
      sourceLabel: 'Portal del auxiliar',
      occurredAt,
      latitude,
      longitude,
      accuracyMeters: 12
    }
  };
}

test('un WhatsApp viejo no acepta un intento posterior fuera de rango cuyo GPS no fue mostrado', async () => {
  const fifth = failedAttempt(FIFTH_FAILURE_ID, '2026-08-28T15:45:00.000Z', 4.62001, -74.10001);
  const sixth = failedAttempt(SIXTH_FAILURE_ID, '2026-08-28T15:47:00.000Z', 4.63123, -74.11234);
  let writerCalled = false;

  const prismaClient = {
    devAuditEvent: {
      async findUnique({ where }) {
        if (where.id === FIFTH_FAILURE_ID) return fifth;
        if (where.id === SIXTH_FAILURE_ID) return sixth;
        return null;
      },
      async findMany() {
        return [sixth, fifth];
      }
    },
    dispatchAssignment: {
      async findUnique({ where }) {
        if (where.id !== ASSIGNMENT_ID) return null;
        return {
          id: ASSIGNMENT_ID,
          createdByUsername: 'coordinador-prueba',
          attendanceSession: null
        };
      }
    },
    appUser: {
      async findUnique({ where }) {
        if (where.username !== 'coordinador-prueba') return null;
        return {
          id: 'coordinator-test',
          username: 'coordinador-prueba',
          isActive: true,
          dispatchAlertPhone: COORDINATOR_PHONE
        };
      }
    }
  };

  await assert.rejects(
    resolveDispatchAttendanceFailureCoordinatorDecision({
      failureEventId: FIFTH_FAILURE_ID,
      decision: 'ACCEPT',
      coordinatorPhone: COORDINATOR_PHONE,
      prismaClient,
      registerManualAttendanceFn: async () => {
        writerCalled = true;
        return { id: 'unexpected' };
      }
    }),
    /attendance_failure_decision_stale_gps_evidence/
  );

  assert.equal(writerCalled, false);
});

test('el inbound existente responde al coordinador que revise Asistencia cuando una decisión no puede aplicarse', () => {
  const inbound = fs.readFileSync(new URL('../src/services/dispatchWhatsappWebhookService.js', import.meta.url), 'utf8');
  assert.match(inbound, /No fue posible aplicar la decisión sobre esta marcación\. Revísala en Asistencia operativa\./);
  assert.doesNotMatch(inbound, /attendance_failure_decision_stale_gps_evidence/);
});
