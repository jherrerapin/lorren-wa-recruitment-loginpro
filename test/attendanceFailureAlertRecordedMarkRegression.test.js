import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDispatchAttendanceFailureAdminAlert } from '../src/services/dispatchWhatsappAdminAlerts.js';

const ASSIGNMENT_ID = 'assignment-test-recorded-mark';
const BASE_AT = new Date('2026-08-28T15:40:00.000Z');

function failureEvent(index) {
  const occurredAt = new Date(BASE_AT.getTime() + index * 60_000);
  return {
    id: `attendance_failure_${index.toString(16).padStart(48, '0')}`,
    entityType: 'DISPATCH_ATTENDANCE_MARK_FAILURE',
    entityId: ASSIGNMENT_ID,
    action: 'MARK_ATTEMPT_FAILED',
    createdAt: new Date(occurredAt.getTime() + 1000),
    metadata: {
      assignmentId: ASSIGNMENT_ID,
      attemptId: `attempt-test-${index}`,
      markType: 'ARRIVAL',
      failureCode: 'outside_operation_range',
      descriptionEs: 'La ubicación estaba fuera del rango permitido para marcar.',
      occurredAt: occurredAt.toISOString()
    }
  };
}

test('cinco fallos no alertan al coordinador si la marcación ya quedó registrada', async () => {
  const failures = Array.from({ length: 5 }, (_, index) => failureEvent(index));
  const latest = failures.at(-1);
  let assignmentQuery = null;
  let appUserLookups = 0;
  let notificationWrites = 0;
  let sends = 0;

  const prismaClient = {
    devAuditEvent: {
      async findMany() {
        return [...failures].reverse();
      },
      async findFirst() {
        return null;
      },
      async create() {
        notificationWrites += 1;
        throw new Error('notification_must_not_be_created');
      }
    },
    dispatchAssignment: {
      async findUnique(query) {
        assignmentQuery = query;
        return {
          id: ASSIGNMENT_ID,
          createdByUsername: 'coordinador-test',
          worker: { id: 'worker-test', fullName: 'Auxiliar Prueba' },
          serviceRequest: { id: 'request-test', operationPointName: 'Operación Prueba' },
          attendanceSession: {
            arrivalReportedAt: new Date('2026-08-28T15:44:30.000Z'),
            departureReportedAt: null,
            marks: [{ markType: 'ARRIVAL' }]
          }
        };
      }
    },
    appUser: {
      async findUnique() {
        appUserLookups += 1;
        return {
          id: 'coordinator-test',
          username: 'coordinador-test',
          isActive: true,
          dispatchAlertPhone: '573000000111'
        };
      }
    }
  };

  const result = await sendDispatchAttendanceFailureAdminAlert({
    failureEvent: latest,
    failureContext: latest.metadata,
    prismaClient,
    now: latest.createdAt,
    sendDecisionMessage: async () => {
      sends += 1;
      return { providerMessageId: 'unexpected' };
    }
  });

  assert.equal(result.sent, false);
  assert.equal(result.reason, 'mark_already_recorded');
  assert.equal(result.failureCount, 5);
  assert.equal(result.assignmentId, ASSIGNMENT_ID);
  assert.equal(result.markType, 'ARRIVAL');
  assert.equal(sends, 0);
  assert.equal(notificationWrites, 0);
  assert.equal(appUserLookups, 0);

  assert.equal(assignmentQuery.where.id, ASSIGNMENT_ID);
  assert.equal(assignmentQuery.include.worker, true);
  assert.equal(assignmentQuery.include.serviceRequest, true);
  assert.equal(assignmentQuery.include.attendanceSession.select.arrivalReportedAt, true);
  assert.equal(assignmentQuery.include.attendanceSession.select.departureReportedAt, true);
  assert.equal(assignmentQuery.include.attendanceSession.select.marks.select.markType, true);
});
