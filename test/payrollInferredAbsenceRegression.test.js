import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKER_REST_ACTION,
  WORKER_REST_ENTITY_TYPE,
  WORKER_REST_REASONS,
  loadPayrollReport
} from '../src/modules/dispatch-payroll/application/payrollReport.js';

const WORKER_ID = 'TEST-WORKER-ABSENCE';
const CLIENT_ID = 'TEST-CLIENT-ABSENCE';
const POINT_ID = 'TEST-POINT-ABSENCE';

function worker() {
  return {
    id: WORKER_ID,
    fullName: 'TEST Auxiliar ausencia',
    documentType: 'CC',
    documentNumber: 'TEST-DOC-ABSENCE',
    phone: 'TEST-PHONE-ABSENCE',
    contractType: 'DIRECTO',
    operationalStatus: 'ACTIVE',
    isTestProfile: false
  };
}

function assignment({
  id = 'TEST-ASSIGNMENT-ABSENCE',
  dateKey = '2026-08-10',
  startTime = '08:00',
  endTime = '15:00',
  clientId = CLIENT_ID,
  attendanceSession = null
} = {}) {
  return {
    id,
    workerId: WORKER_ID,
    status: 'CONFIRMED',
    worker: worker(),
    attendanceSession,
    serviceRequest: {
      id: `TEST-REQUEST-${id}`,
      source: 'INTERNAL',
      serviceDate: new Date(`${dateKey}T00:00:00.000Z`),
      startTime,
      endTime,
      clientName: 'TEST Cliente ausencia',
      operationPointName: 'TEST Operación ausencia',
      operationPoint: {
        id: POINT_ID,
        clientId,
        name: 'TEST Operación ausencia',
        absenceGraceMinutes: 15,
        client: { id: clientId, name: 'TEST Cliente ausencia' }
      }
    }
  };
}

function completedSession(baseAssignment, dateKey = '2026-08-10') {
  const session = {
    id: 'TEST-SESSION-WORKED',
    attendanceStatus: 'ON_TIME',
    validationStatus: 'MANUAL_VALIDATED',
    expectedStartAt: new Date(`${dateKey}T13:00:00.000Z`),
    expectedEndAt: new Date(`${dateKey}T20:00:00.000Z`),
    arrivalReportedAt: new Date(`${dateKey}T13:00:00.000Z`),
    departureReportedAt: new Date(`${dateKey}T20:00:00.000Z`),
    workedMinutes: 420,
    marks: [],
    reviews: [],
    assignment: baseAssignment
  };
  baseAssignment.attendanceSession = {
    id: session.id,
    attendanceStatus: session.attendanceStatus,
    validationStatus: session.validationStatus,
    expectedStartAt: session.expectedStartAt,
    expectedEndAt: session.expectedEndAt,
    arrivalReportedAt: session.arrivalReportedAt,
    departureReportedAt: session.departureReportedAt
  };
  return session;
}

function persistedAbsence(baseAssignment, dateKey = '2026-08-10') {
  const session = {
    id: 'TEST-SESSION-PERSISTED-ABSENCE',
    attendanceStatus: 'ABSENT',
    validationStatus: 'PENDING',
    expectedStartAt: new Date(`${dateKey}T13:00:00.000Z`),
    expectedEndAt: new Date(`${dateKey}T20:00:00.000Z`),
    arrivalReportedAt: null,
    departureReportedAt: null,
    marks: [],
    reviews: [],
    assignment: baseAssignment
  };
  baseAssignment.attendanceSession = {
    id: session.id,
    attendanceStatus: session.attendanceStatus,
    validationStatus: session.validationStatus,
    expectedStartAt: session.expectedStartAt,
    expectedEndAt: session.expectedEndAt,
    arrivalReportedAt: null,
    departureReportedAt: null
  };
  return session;
}

function paidRestEvent(dateKey = '2026-08-10') {
  return {
    entityType: WORKER_REST_ENTITY_TYPE,
    entityId: `${WORKER_ID}|${dateKey}`,
    action: WORKER_REST_ACTION,
    createdAt: new Date(`${dateKey}T22:00:00.000Z`),
    metadata: {
      workerId: WORKER_ID,
      restDate: dateKey,
      reason: WORKER_REST_REASONS.REMUNERADO,
      status: 'ACTIVE',
      originSundayDate: null,
      dayAdjustment: 0
    }
  };
}

function makePrisma({ assignments = [], sessions = [], events = [] } = {}) {
  return {
    dispatchAssignment: {
      async findMany() { return assignments; }
    },
    dispatchAttendanceSession: {
      async findMany() { return sessions; }
    },
    dispatchClient: {
      async findMany() {
        return [{ id: CLIENT_ID, name: 'TEST Cliente ausencia', isActive: true, operationPoints: [] }];
      }
    },
    dispatchWorker: {
      async findMany() { return [worker()]; }
    },
    devAuditEvent: {
      async findMany({ where = {} } = {}) {
        return events.filter((event) => (
          (!where.entityType || event.entityType === where.entityType)
          && (!where.action || event.action === where.action)
          && (!where.entityId?.in || where.entityId.in.includes(event.entityId))
        ));
      }
    }
  };
}

async function reportFor(prisma, query = {}, now = new Date('2026-08-12T15:00:00.000Z')) {
  return loadPayrollReport(prisma, {
    periodType: 'CUSTOM',
    from: '2026-08-10',
    to: '2026-08-12',
    ...query
  }, { now });
}

test('asignación vencida sin sesión ni marcación suma un día no remunerado', async () => {
  const assigned = assignment({ dateKey: '2026-08-10' });
  const report = await reportFor(makePrisma({ assignments: [assigned] }));

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].workerId, WORKER_ID);
  assert.equal(report.rows[0].workedDays, 0);
  assert.equal(report.rows[0].unremuneratedDays, 1);
  assert.equal(report.totals.unremuneratedDays, 1);
});

test('el día actual espera la tolerancia de ausencia y después infiere el no show', async () => {
  const assigned = assignment({ dateKey: '2026-08-12', startTime: '08:00' });
  const prisma = makePrisma({ assignments: [assigned] });

  const beforeGrace = await reportFor(prisma, {}, new Date('2026-08-12T13:10:00.000Z'));
  assert.equal(beforeGrace.rows.length, 0, 'antes de 08:15 Bogotá no debe anticipar una ausencia');

  const afterGrace = await reportFor(prisma, {}, new Date('2026-08-12T13:16:00.000Z'));
  assert.equal(afterGrace.rows.length, 1);
  assert.equal(afterGrace.rows[0].unremuneratedDays, 1);
});

test('una jornada realmente marcada prevalece y no se convierte en ausencia', async () => {
  const assigned = assignment({ dateKey: '2026-08-10' });
  const worked = completedSession(assigned);
  const report = await reportFor(makePrisma({ assignments: [assigned], sessions: [worked] }));

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].workedDays, 1);
  assert.equal(report.rows[0].unremuneratedDays, 0);
});

test('permiso remunerado sustituye la ausencia inferida en la misma fecha', async () => {
  const assigned = assignment({ dateKey: '2026-08-10' });
  const report = await reportFor(makePrisma({
    assignments: [assigned],
    events: [paidRestEvent('2026-08-10')]
  }));

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].paidPermissionDays, 1);
  assert.equal(report.rows[0].unremuneratedDays, 0);
});

test('ausencia persistida y asignación sin marcas se deduplican y respetan filtro de cliente', async () => {
  const assigned = assignment({ dateKey: '2026-08-10' });
  const absent = persistedAbsence(assigned);
  const report = await reportFor(makePrisma({ assignments: [assigned], sessions: [absent] }));
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].unremuneratedDays, 1);

  const filteredOut = await reportFor(
    makePrisma({ assignments: [assignment({ id: 'TEST-OTHER-CLIENT', clientId: 'TEST-CLIENT-OTHER' })] }),
    { clientId: CLIENT_ID }
  );
  assert.equal(filteredOut.rows.length, 0);
});
