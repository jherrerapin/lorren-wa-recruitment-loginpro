import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePayrollAttendanceImport,
  buildPayrollAttendanceImportPreview,
  commitPayrollAttendanceImport,
  parsePayrollAttendanceImportFile
} from '../src/modules/dispatch-payroll/application/payrollAttendanceImport.js';

function csvFile(text) {
  return { originalname: 'marcaciones.csv', mimetype: 'text/csv', buffer: Buffer.from(text, 'utf8') };
}

function worker() {
  return {
    id: 'TEST-WORKER-1253',
    fullName: 'Auxiliar Prueba',
    documentNumber: 'TEST-1253',
    isTestProfile: false
  };
}

function assignment(session) {
  return {
    id: 'TEST-ASSIGNMENT-1253',
    workerId: 'TEST-WORKER-1253',
    status: 'CONFIRMED',
    serviceRequest: {
      id: 'TEST-REQUEST-1253',
      serviceDate: new Date('2027-02-10T00:00:00.000Z'),
      startTime: '07:00',
      endTime: '16:00',
      operationPointName: 'Operación Prueba',
      clientName: 'Cliente Prueba',
      operationPoint: {
        id: 'TEST-POINT-1253',
        name: 'Operación Prueba',
        manualAttendanceAllowed: true,
        earlyArrivalWindowMinutes: 60
      }
    },
    attendanceSession: session
  };
}

function manualMark(id, markType, localDateTime) {
  return {
    id,
    markType,
    idempotencyKey: `manual-${id}`,
    clientCapturedAt: new Date(`${localDateTime}-05:00`),
    serverReceivedAt: new Date('2027-02-11T12:00:00.000Z'),
    workerDeviceId: null,
    installationIdHash: null,
    evidenceStorageKey: null
  };
}

function portalMark(id, markType, localDateTime) {
  return {
    id,
    markType,
    idempotencyKey: `portal-${id}`,
    clientCapturedAt: new Date(`${localDateTime}-05:00`),
    serverReceivedAt: new Date('2027-02-11T12:00:00.000Z'),
    workerDeviceId: 'TEST-DEVICE-1253',
    installationIdHash: 'TEST-INSTALLATION-1253',
    evidenceStorageKey: `attendance/TEST/${id}.jpg`
  };
}

function prismaFixture(session) {
  const state = { assignment: assignment(session), auditEvents: [], cleared: 0 };
  const prisma = {
    dispatchWorker: { async findMany() { return [worker()]; } },
    dispatchAssignment: { async findMany() { return [state.assignment]; } },
    dispatchAttendanceSession: {
      async findUnique() { return state.assignment.attendanceSession; }
    },
    devAuditEvent: {
      async findMany() { return []; },
      async create({ data }) {
        state.auditEvents.push(data);
        return { id: `TEST-AUDIT-${state.auditEvents.length}`, createdAt: new Date(), ...data };
      }
    }
  };
  return { prisma, state };
}

function correctedFile() {
  return csvFile([
    'Documento;Fecha;Entrada;Salida',
    'TEST-1253;10/02/2027;07:00;16:00'
  ].join('\n'));
}

test('reimportar Excel corregido reemplaza una jornada administrativa con horas distintas', async () => {
  const session = {
    id: 'TEST-SESSION-1253',
    source: 'MANUAL',
    arrivalReportedAt: new Date('2027-02-10T12:15:00.000Z'),
    departureReportedAt: new Date('2027-02-10T21:00:00.000Z'),
    marks: [
      manualMark('TEST-MARK-ARRIVAL', 'ARRIVAL', '2027-02-10T07:15:00'),
      manualMark('TEST-MARK-DEPARTURE', 'DEPARTURE', '2027-02-10T16:00:00')
    ],
    reviews: [{
      id: 'TEST-REVIEW-1253',
      action: 'MANUAL_WORKDAY',
      reason: 'Registro administrativo de prueba.',
      createdAt: new Date('2027-02-11T11:59:00.000Z')
    }]
  };
  const { prisma, state } = prismaFixture(session);
  const file = correctedFile();
  const parsed = await parsePayrollAttendanceImportFile(file);
  const analysis = await analyzePayrollAttendanceImport(prisma, parsed);

  assert.equal(analysis.summary.ready, 1);
  assert.equal(analysis.summary.replacements, 1);
  assert.equal(analysis.rows[0].replaceExisting, true);
  assert.equal(analysis.rows[0].replaceMode, 'ADMINISTRATIVE');
  assert.match(analysis.rows[0].replaceStateFingerprint, /^[a-f0-9]{64}$/);

  const preview = buildPayrollAttendanceImportPreview(analysis);
  const workdayReviewer = async (_prisma, input) => {
    assert.equal(input.action, 'CLEAR');
    state.cleared += 1;
    state.assignment.attendanceSession = {
      ...state.assignment.attendanceSession,
      arrivalReportedAt: null,
      departureReportedAt: null,
      marks: [],
      reviews: [{
        id: 'TEST-CLEAR-1253',
        action: 'WORKDAY_CLEAR_MARKS',
        reason: 'Prueba de limpieza.',
        createdAt: new Date('2027-02-11T12:04:00.000Z')
      }]
    };
    return state.assignment.attendanceSession;
  };
  const attendanceWriter = async (_prisma, input) => {
    const marks = [
      manualMark('TEST-NEW-ARRIVAL', 'ARRIVAL', input.arrivalReportedAt),
      manualMark('TEST-NEW-DEPARTURE', 'DEPARTURE', input.departureReportedAt)
    ];
    state.assignment.attendanceSession = {
      ...state.assignment.attendanceSession,
      source: 'MANUAL',
      arrivalReportedAt: marks[0].clientCapturedAt,
      departureReportedAt: marks[1].clientCapturedAt,
      marks
    };
    return state.assignment.attendanceSession;
  };

  const committed = await commitPayrollAttendanceImport(prisma, file, {
    previewFingerprint: preview.previewFingerprint,
    actor: { actorUsername: 'coordinacion-prueba', actorRole: 'admin' },
    now: new Date('2027-02-11T12:03:00.000Z')
  }, { attendanceWriter, workdayReviewer });

  assert.equal(state.cleared, 1);
  assert.equal(committed.summary.replacedWorkdays, 1);
  assert.equal(state.auditEvents[0].metadata.workdays[0].replacementMode, 'ADMINISTRATIVE');
});

test('una jornada con evidencia de portal o dispositivo sigue protegida', async () => {
  const session = {
    id: 'TEST-SESSION-PORTAL-1253',
    source: 'PORTAL',
    arrivalReportedAt: new Date('2027-02-10T12:15:00.000Z'),
    departureReportedAt: new Date('2027-02-10T21:00:00.000Z'),
    marks: [
      portalMark('TEST-PORTAL-ARRIVAL', 'ARRIVAL', '2027-02-10T07:15:00'),
      portalMark('TEST-PORTAL-DEPARTURE', 'DEPARTURE', '2027-02-10T16:00:00')
    ],
    reviews: []
  };
  const { prisma } = prismaFixture(session);
  const parsed = await parsePayrollAttendanceImportFile(correctedFile());
  const analysis = await analyzePayrollAttendanceImport(prisma, parsed);

  assert.equal(analysis.summary.ready, 0);
  assert.equal(analysis.summary.replacements, 0);
  assert.equal(analysis.summary.unresolved, 1);
  assert.match(analysis.rows[0].message, /portal\/dispositivo|no son inequívocamente administrativas/i);
});

test('si la jornada cambia después del preview, la reimportación corregida queda obsoleta', async () => {
  const session = {
    id: 'TEST-SESSION-STALE-1253',
    source: 'MANUAL',
    arrivalReportedAt: new Date('2027-02-10T12:15:00.000Z'),
    departureReportedAt: new Date('2027-02-10T21:00:00.000Z'),
    marks: [
      manualMark('TEST-STALE-ARRIVAL', 'ARRIVAL', '2027-02-10T07:15:00'),
      manualMark('TEST-STALE-DEPARTURE', 'DEPARTURE', '2027-02-10T16:00:00')
    ],
    reviews: [{
      id: 'TEST-STALE-REVIEW',
      action: 'MANUAL_WORKDAY',
      reason: 'Registro administrativo de prueba.',
      createdAt: new Date('2027-02-11T11:59:00.000Z')
    }]
  };
  const { prisma, state } = prismaFixture(session);
  const file = correctedFile();
  const parsed = await parsePayrollAttendanceImportFile(file);
  const analysis = await analyzePayrollAttendanceImport(prisma, parsed);
  const preview = buildPayrollAttendanceImportPreview(analysis);

  state.assignment.attendanceSession.marks[0] = manualMark(
    'TEST-STALE-ARRIVAL',
    'ARRIVAL',
    '2027-02-10T07:20:00'
  );

  await assert.rejects(
    commitPayrollAttendanceImport(prisma, file, {
      previewFingerprint: preview.previewFingerprint,
      actor: { actorUsername: 'coordinacion-prueba', actorRole: 'admin' }
    }, {
      workdayReviewer: async () => assert.fail('No debe limpiar una jornada que cambió después del preview.'),
      attendanceWriter: async () => assert.fail('No debe escribir una jornada que cambió después del preview.')
    }),
    /payroll_import_preview_stale/
  );
});

test('horas administrativas legacy sin marcas detalladas también pueden sustituirse', async () => {
  const session = {
    id: 'TEST-SESSION-LEGACY-1253',
    source: 'MANUAL',
    arrivalReportedAt: new Date('2027-02-10T12:15:00.000Z'),
    departureReportedAt: new Date('2027-02-10T21:00:00.000Z'),
    marks: [],
    reviews: []
  };
  const { prisma } = prismaFixture(session);
  const parsed = await parsePayrollAttendanceImportFile(correctedFile());
  const analysis = await analyzePayrollAttendanceImport(prisma, parsed);

  assert.equal(analysis.summary.ready, 1);
  assert.equal(analysis.summary.replacements, 1);
  assert.equal(analysis.rows[0].replaceMode, 'ADMINISTRATIVE');
});
