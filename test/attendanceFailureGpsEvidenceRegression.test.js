import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadAttendanceAdminBoard } from '../src/modules/dispatch-attendance/application/adminAttendance.js';

const ASSIGNMENT_ID = 'assignment-gps-test-1';
const FAILURE_ID = `attendance_failure_${'d'.repeat(48)}`;

function assignment() {
  return {
    id: ASSIGNMENT_ID,
    workerId: 'worker-gps-test-1',
    serviceRequestId: 'request-gps-test-1',
    status: 'CONFIRMED',
    worker: {
      id: 'worker-gps-test-1',
      fullName: 'Auxiliar Ruta Prueba',
      documentType: 'CC',
      documentNumber: 'TEST-ROUTE-001',
      phone: 'TEST-PHONE'
    },
    serviceRequest: {
      id: 'request-gps-test-1',
      serviceDate: new Date('2026-08-28T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '17:00',
      clientName: 'Cliente de prueba',
      operationPointName: 'Operación base de prueba',
      cityName: 'Bogotá',
      address: 'Dirección de prueba',
      operationPoint: {
        id: 'operation-gps-test-1',
        name: 'Operación base de prueba',
        cityName: 'Bogotá',
        address: 'Dirección de prueba',
        attendanceEnabled: true,
        attendanceLatitude: 4.7111,
        attendanceLongitude: -74.0721,
        geofenceRadiusMeters: 100,
        absenceGraceMinutes: 15,
        manualAttendanceAllowed: true
      }
    },
    attendanceSession: null
  };
}

function failureEvent(overrides = {}) {
  return {
    id: FAILURE_ID,
    entityType: 'DISPATCH_ATTENDANCE_MARK_FAILURE',
    entityId: ASSIGNMENT_ID,
    action: 'MARK_ATTEMPT_FAILED',
    createdAt: new Date('2026-08-28T15:43:01.000Z'),
    metadata: {
      assignmentId: ASSIGNMENT_ID,
      attemptId: 'attempt-gps-test-1',
      markType: 'ARRIVAL',
      failureCode: 'outside_operation_range',
      phaseLabel: 'Ubicación',
      descriptionEs: 'La ubicación estaba fuera del rango permitido para marcar.',
      sourceLabel: 'Portal del auxiliar',
      occurredAt: '2026-08-28T15:43:00.000Z',
      latitude: 4.62001,
      longitude: -74.10001,
      accuracyMeters: 13,
      ...overrides
    }
  };
}

function boardPrisma(event) {
  const row = assignment();
  return {
    dispatchAssignment: {
      async findMany() { return [row]; },
      async findUnique() { return row; }
    },
    dispatchAttendanceSession: {
      async findUnique() { return null; },
      async create({ data }) { return { id: 'session-test', ...data }; },
      async update({ where, data }) { return { id: where.id, ...data }; }
    },
    dispatchAttendanceMark: {
      async findFirst() { return null; },
      async create({ data }) { return { id: 'mark-test', ...data }; },
      async update({ where, data }) { return { id: where.id, ...data }; }
    },
    dispatchAttendanceReview: {
      async create({ data }) { return { id: 'review-test', ...data }; }
    },
    devAuditEvent: {
      async findMany({ where }) {
        if (where?.entityType === 'DISPATCH_ATTENDANCE_MARK_FAILURE') return [event];
        if (where?.entityType === 'DISPATCH_ATTENDANCE_MARK_FAILURE_DECISION') return [];
        return [];
      }
    },
    async $transaction(callback) { return callback(this); }
  };
}

async function projectedAttempt(event) {
  const board = await loadAttendanceAdminBoard(boardPrisma(event), {
    from: '2026-08-28',
    to: '2026-08-28',
    now: new Date('2026-08-28T16:00:00.000Z')
  });
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].failedMarkAttempts.length, 1);
  return board.rows[0].failedMarkAttempts[0];
}

test('el dashboard proyecta el GPS real cuando el fallo es fuera de geocerca', async () => {
  const attempt = await projectedAttempt(failureEvent());
  assert.equal(attempt.failureCode, 'outside_operation_range');
  assert.equal(attempt.latitude, 4.62001);
  assert.equal(attempt.longitude, -74.10001);
  assert.equal(attempt.accuracyMeters, 13);
});

test('el dashboard no expone coordenadas de fallos que no requieren evidencia de fuera de rango', async () => {
  const attempt = await projectedAttempt(failureEvent({
    failureCode: 'client_location_timeout',
    descriptionEs: 'El GPS agotó el tiempo disponible para obtener ubicación.'
  }));
  assert.equal(attempt.failureCode, 'client_location_timeout');
  assert.equal(attempt.latitude, null);
  assert.equal(attempt.longitude, null);
  assert.equal(attempt.accuracyMeters, null);
});

test('la vista muestra mapa y enlace GPS junto al intento fuera de rango sin cambiar la autoridad de decisión', () => {
  const view = fs.readFileSync(new URL('../src/views/operacionesAsistencia.ejs', import.meta.url), 'utf8');
  assert.match(view, /Ver ubicación GPS del intento/);
  assert.match(view, /data-failure-map-details/);
  assert.match(view, /data-failure-lat/);
  assert.match(view, /Punto real desde donde intentó marcar/);
  assert.match(view, /https:\/\/www\.google\.com\/maps\?q=/);
  assert.match(view, /Intento fuera de rango/);
  assert.match(view, /latestFailureEventByMarkType/);
  assert.match(view, /name="decision" value="ACCEPT"/);
  assert.match(view, /name="decision" value="REJECT"/);
});
