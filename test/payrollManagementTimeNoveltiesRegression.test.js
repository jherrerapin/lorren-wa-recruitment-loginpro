import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayrollConceptReport } from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';
import { buildPayrollExportRows, loadPayrollReport } from '../src/modules/dispatch-payroll/application/payrollReport.js';

const DATE_KEY = '2026-08-22';
const WORKER = Object.freeze({
  id: 'TEST-WORKER-MANAGEMENT-NOVELTIES',
  fullName: 'TEST Auxiliar novedades operativas',
  documentType: 'CC',
  documentNumber: 'TEST-DOC-MANAGEMENT-NOVELTIES',
  phone: '',
  contractType: 'DIRECTO',
  isTestProfile: false
});

function operationPoint() {
  return {
    id: 'TEST-POINT-MANAGEMENT-NOVELTIES',
    clientId: 'TEST-CLIENT-MANAGEMENT-NOVELTIES',
    name: 'TEST Operación novedades',
    absenceGraceMinutes: 15,
    client: {
      id: 'TEST-CLIENT-MANAGEMENT-NOVELTIES',
      name: 'TEST Cliente novedades'
    }
  };
}

function serviceRequest() {
  return {
    id: 'TEST-REQUEST-MANAGEMENT-NOVELTIES',
    source: 'INTERNAL',
    serviceDate: new Date(`${DATE_KEY}T00:00:00.000Z`),
    startTime: '08:00',
    endTime: '16:00',
    clientName: 'TEST Cliente novedades',
    operationPointName: 'TEST Operación novedades',
    operationPoint: operationPoint()
  };
}

function assignment(session = null) {
  return {
    id: 'TEST-ASSIGNMENT-MANAGEMENT-NOVELTIES',
    workerId: WORKER.id,
    worker: { ...WORKER },
    status: 'ASSIGNED',
    serviceRequestId: 'TEST-REQUEST-MANAGEMENT-NOVELTIES',
    serviceRequest: serviceRequest(),
    attendanceSession: session
  };
}

function mark(markType, localHour) {
  const capturedAt = new Date(`${DATE_KEY}T${localHour}:00-05:00`);
  return {
    id: `TEST-MARK-${markType}-${localHour}`,
    markType,
    clientCapturedAt: capturedAt,
    serverReceivedAt: capturedAt
  };
}

function session(overrides = {}) {
  const arrivalReportedAt = overrides.arrivalReportedAt === undefined
    ? new Date(`${DATE_KEY}T08:00:00-05:00`)
    : overrides.arrivalReportedAt;
  const departureReportedAt = overrides.departureReportedAt === undefined
    ? new Date(`${DATE_KEY}T16:00:00-05:00`)
    : overrides.departureReportedAt;
  const marks = overrides.marks || [];
  const value = {
    id: overrides.id || 'TEST-SESSION-MANAGEMENT-NOVELTIES',
    attendanceStatus: overrides.attendanceStatus || (departureReportedAt ? 'COMPLETED' : 'ARRIVAL_REPORTED'),
    validationStatus: overrides.validationStatus || 'MANUAL_VALIDATED',
    expectedStartAt: new Date(`${DATE_KEY}T08:00:00-05:00`),
    expectedEndAt: new Date(`${DATE_KEY}T16:00:00-05:00`),
    arrivalReportedAt,
    departureReportedAt,
    workedMinutes: departureReportedAt ? 480 : null,
    marks,
    reviews: [],
    source: 'SYSTEM'
  };
  value.assignment = assignment();
  return value;
}

function assignmentProjection(sourceSession = null) {
  const projectedSession = sourceSession
    ? {
        id: sourceSession.id,
        attendanceStatus: sourceSession.attendanceStatus,
        validationStatus: sourceSession.validationStatus,
        expectedStartAt: sourceSession.expectedStartAt,
        expectedEndAt: sourceSession.expectedEndAt,
        arrivalReportedAt: sourceSession.arrivalReportedAt,
        departureReportedAt: sourceSession.departureReportedAt,
        marks: sourceSession.marks
      }
    : null;
  return assignment(projectedSession);
}

function prismaFixture({ sessions = [], assignments = [] } = {}) {
  return {
    dispatchAttendanceSession: {
      async findMany() { return sessions; }
    },
    dispatchAssignment: {
      async findMany() { return assignments; }
    },
    dispatchClient: {
      async findMany() { return []; }
    },
    dispatchWorker: {
      async findMany() { return [{ ...WORKER }]; }
    },
    devAuditEvent: {
      async findMany() { return []; }
    }
  };
}

function report({ sessions = [], assignments = [], now = new Date(`${DATE_KEY}T18:00:00-05:00`) } = {}) {
  return loadPayrollReport(
    prismaFixture({ sessions, assignments }),
    { periodType: 'CUSTOM', from: DATE_KEY, to: DATE_KEY },
    { now }
  );
}

test('conserva el diagnóstico interno pero no muestra validación pendiente en una jornada completa', async () => {
  const completed = session({ validationStatus: 'REVIEW_REQUIRED' });
  const internal = calculatePayrollConceptReport({
    sessions: [completed],
    range: { from: DATE_KEY, to: DATE_KEY }
  });
  assert.ok(internal.rows[0].novelties.some((novelty) => novelty.code === 'SESSION_NOT_VALIDATED'));

  const visible = await report({
    sessions: [completed],
    assignments: [assignmentProjection(completed)]
  });
  assert.deepEqual(visible.rows[0].novelties, []);
  assert.equal(visible.rows[0].status, 'CALCULADO');
  assert.equal(visible.rows[0].exportable, true);

  const exported = buildPayrollExportRows(visible)[0];
  assert.equal(exported.Estado, 'Calculado');
  assert.equal(exported.Novedades, '');
});

test('no genera novedad cuando no se tomó almuerzo', async () => {
  const completed = session({ marks: [] });
  const visible = await report({
    sessions: [completed],
    assignments: [assignmentProjection(completed)]
  });
  assert.deepEqual(visible.rows[0].novelties, []);
});

test('muestra únicamente almuerzo abierto cuando hubo inicio sin fin', async () => {
  const completed = session({ marks: [mark('BREAK_START', '12:00')] });
  const visible = await report({
    sessions: [completed],
    assignments: [assignmentProjection(completed)]
  });
  assert.deepEqual(visible.rows[0].novelties.map((novelty) => novelty.code), ['INCOMPLETE_BREAK']);
  assert.match(visible.rows[0].novelties[0].message, /inicio, pero no el fin/i);
  assert.equal(visible.rows[0].exportable, false);
});

test('muestra falta de salida solo después de terminar la jornada', async () => {
  const partial = session({ departureReportedAt: null });
  const beforeEnd = await report({
    sessions: [partial],
    assignments: [assignmentProjection(partial)],
    now: new Date(`${DATE_KEY}T15:00:00-05:00`)
  });
  assert.equal(beforeEnd.rows.length, 0);

  const afterEnd = await report({
    sessions: [partial],
    assignments: [assignmentProjection(partial)],
    now: new Date(`${DATE_KEY}T16:20:00-05:00`)
  });
  assert.deepEqual(afterEnd.rows[0].novelties.map((novelty) => novelty.code), ['MISSING_DEPARTURE']);
  assert.match(afterEnd.rows[0].novelties[0].message, /salida/i);
  assert.equal(afterEnd.rows[0].exportable, false);
});

test('muestra falta de entrada cuando venció la tolerancia sin ninguna marcación', async () => {
  const visible = await report({
    assignments: [assignmentProjection(null)],
    now: new Date(`${DATE_KEY}T08:20:00-05:00`)
  });
  assert.deepEqual(visible.rows[0].novelties.map((novelty) => novelty.code), ['MISSING_ARRIVAL']);
  assert.match(visible.rows[0].novelties[0].message, /entrada/i);
  assert.equal(visible.rows[0].exportable, false);
});

test('si faltan salida y fin de almuerzo muestra ambas alertas operativas y ninguna técnica', async () => {
  const partial = session({
    departureReportedAt: null,
    validationStatus: 'REVIEW_REQUIRED',
    marks: [mark('BREAK_START', '12:00')]
  });
  const visible = await report({
    sessions: [partial],
    assignments: [assignmentProjection(partial)],
    now: new Date(`${DATE_KEY}T16:20:00-05:00`)
  });
  assert.deepEqual(
    visible.rows[0].novelties.map((novelty) => novelty.code),
    ['MISSING_DEPARTURE', 'INCOMPLETE_BREAK']
  );
  assert.ok(visible.rows[0].novelties.every((novelty) => novelty.blocking === true));
  assert.ok(visible.rows[0].novelties.every((novelty) => novelty.code !== 'SESSION_NOT_VALIDATED'));
});
