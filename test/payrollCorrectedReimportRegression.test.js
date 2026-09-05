import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    id: 'TEST-WORKER-1255',
    fullName: 'Auxiliar Prueba',
    documentNumber: 'TEST-1255',
    isTestProfile: false
  };
}

function assignment(session) {
  return {
    id: 'TEST-ASSIGNMENT-1255',
    workerId: 'TEST-WORKER-1255',
    status: 'CONFIRMED',
    serviceRequest: {
      id: 'TEST-REQUEST-1255',
      serviceDate: new Date('2027-02-10T00:00:00.000Z'),
      startTime: '07:00',
      endTime: '16:00',
      operationPointName: 'Operación Prueba',
      clientName: 'Cliente Prueba',
      operationPoint: {
        id: 'TEST-POINT-1255',
        name: 'Operación Prueba',
        manualAttendanceAllowed: true,
        earlyArrivalWindowMinutes: 60
      }
    },
    attendanceSession: session
  };
}

function mark(id, markType, localDateTime, { source = 'manual' } = {}) {
  const portal = source === 'portal';
  return {
    id,
    markType,
    idempotencyKey: `${source}-${id}`,
    clientCapturedAt: new Date(`${localDateTime}-05:00`),
    serverReceivedAt: new Date('2027-02-11T12:00:00.000Z'),
    workerDeviceId: portal ? 'TEST-DEVICE-1255' : null,
    installationIdHash: portal ? 'TEST-INSTALLATION-1255' : null,
    evidenceStorageKey: portal ? `attendance/TEST/${id}.jpg` : null
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
    'TEST-1255;10/02/2027;07:00;16:00'
  ].join('\n'));
}

function replacementDependencies(state) {
  return {
    workdayReviewer: async (_prisma, input) => {
      assert.equal(input.action, 'CLEAR');
      assert.equal(input.sessionId, state.assignment.attendanceSession.id);
      state.cleared += 1;
      state.assignment.attendanceSession = {
        ...state.assignment.attendanceSession,
        arrivalReportedAt: null,
        departureReportedAt: null,
        marks: []
      };
      return state.assignment.attendanceSession;
    },
    attendanceWriter: async (_prisma, input) => {
      const marks = [
        mark('TEST-NEW-ARRIVAL', 'ARRIVAL', input.arrivalReportedAt),
        mark('TEST-NEW-DEPARTURE', 'DEPARTURE', input.departureReportedAt)
      ];
      state.assignment.attendanceSession = {
        ...state.assignment.attendanceSession,
        source: 'MANUAL',
        arrivalReportedAt: marks[0].clientCapturedAt,
        departureReportedAt: marks[1].clientCapturedAt,
        marks
      };
      return state.assignment.attendanceSession;
    }
  };
}

async function previewFor(prisma, file = correctedFile()) {
  const parsed = await parsePayrollAttendanceImportFile(file);
  const analysis = await analyzePayrollAttendanceImport(prisma, parsed);
  return { analysis, preview: buildPayrollAttendanceImportPreview(analysis) };
}

test('reimportar Excel corregido reemplaza una jornada existente con horas distintas', async () => {
  const session = {
    id: 'TEST-SESSION-1255',
    source: 'MANUAL',
    arrivalReportedAt: new Date('2027-02-10T12:15:00.000Z'),
    departureReportedAt: new Date('2027-02-10T21:00:00.000Z'),
    marks: [
      mark('TEST-MARK-ARRIVAL', 'ARRIVAL', '2027-02-10T07:15:00'),
      mark('TEST-MARK-DEPARTURE', 'DEPARTURE', '2027-02-10T16:00:00')
    ],
    reviews: []
  };
  const { prisma, state } = prismaFixture(session);
  const file = correctedFile();
  const { analysis, preview } = await previewFor(prisma, file);

  assert.equal(analysis.summary.ready, 1);
  assert.equal(analysis.summary.replacements, 1);
  assert.equal(analysis.rows[0].replaceExisting, true);
  assert.equal(analysis.rows[0].replaceMode, undefined);
  assert.equal(analysis.rows[0].replaceStateFingerprint, undefined);

  const committed = await commitPayrollAttendanceImport(prisma, file, {
    previewFingerprint: preview.previewFingerprint,
    actor: { actorUsername: 'coordinacion-prueba', actorRole: 'admin' },
    now: new Date('2027-02-11T12:03:00.000Z')
  }, replacementDependencies(state));

  assert.equal(state.cleared, 1);
  assert.equal(committed.summary.replacedWorkdays, 1);
  assert.deepEqual(state.assignment.attendanceSession.marks.map((item) => [item.markType, item.clientCapturedAt.toISOString()]), [
    ['ARRIVAL', '2027-02-10T12:00:00.000Z'],
    ['DEPARTURE', '2027-02-10T21:00:00.000Z']
  ]);
  assert.equal(state.auditEvents[0].metadata.workdays[0].replaced, true);
  assert.equal(state.auditEvents[0].metadata.workdays[0].replacementMode, undefined);
});

test('una jornada de portal o dispositivo también se reemplaza cuando el Excel difiere', async () => {
  const session = {
    id: 'TEST-SESSION-PORTAL-1255',
    source: 'PORTAL',
    arrivalReportedAt: new Date('2027-02-10T12:15:00.000Z'),
    departureReportedAt: new Date('2027-02-10T21:00:00.000Z'),
    marks: [
      mark('TEST-PORTAL-ARRIVAL', 'ARRIVAL', '2027-02-10T07:15:00', { source: 'portal' }),
      mark('TEST-PORTAL-DEPARTURE', 'DEPARTURE', '2027-02-10T16:00:00', { source: 'portal' })
    ],
    reviews: []
  };
  const { prisma, state } = prismaFixture(session);
  const file = correctedFile();
  const { analysis, preview } = await previewFor(prisma, file);

  assert.equal(analysis.summary.ready, 1);
  assert.equal(analysis.summary.replacements, 1);
  assert.equal(analysis.summary.unresolved, 0);
  assert.equal(analysis.rows[0].replaceExisting, true);

  const committed = await commitPayrollAttendanceImport(prisma, file, {
    previewFingerprint: preview.previewFingerprint,
    actor: { actorUsername: 'coordinacion-prueba', actorRole: 'admin' }
  }, replacementDependencies(state));

  assert.equal(state.cleared, 1);
  assert.equal(committed.summary.replacedWorkdays, 1);
  assert.equal(state.assignment.attendanceSession.marks[0].clientCapturedAt.toISOString(), '2027-02-10T12:00:00.000Z');
});

test('un cambio posterior al preview no bloquea que el Excel confirmado prevalezca', async () => {
  const session = {
    id: 'TEST-SESSION-CHANGED-1255',
    source: 'PORTAL',
    arrivalReportedAt: new Date('2027-02-10T12:15:00.000Z'),
    departureReportedAt: new Date('2027-02-10T21:00:00.000Z'),
    marks: [
      mark('TEST-CHANGED-ARRIVAL', 'ARRIVAL', '2027-02-10T07:15:00', { source: 'portal' }),
      mark('TEST-CHANGED-DEPARTURE', 'DEPARTURE', '2027-02-10T16:00:00', { source: 'portal' })
    ],
    reviews: []
  };
  const { prisma, state } = prismaFixture(session);
  const file = correctedFile();
  const { preview } = await previewFor(prisma, file);

  state.assignment.attendanceSession.marks[0] = mark(
    'TEST-CHANGED-ARRIVAL',
    'ARRIVAL',
    '2027-02-10T07:20:00',
    { source: 'portal' }
  );
  state.assignment.attendanceSession.arrivalReportedAt = new Date('2027-02-10T12:20:00.000Z');

  const committed = await commitPayrollAttendanceImport(prisma, file, {
    previewFingerprint: preview.previewFingerprint,
    actor: { actorUsername: 'coordinacion-prueba', actorRole: 'admin' }
  }, replacementDependencies(state));

  assert.equal(state.cleared, 1);
  assert.equal(committed.summary.replacedWorkdays, 1);
  assert.equal(state.assignment.attendanceSession.arrivalReportedAt.toISOString(), '2027-02-10T12:00:00.000Z');
});

test('horas persistidas sin marcas detalladas también pueden sustituirse', async () => {
  const session = {
    id: 'TEST-SESSION-LEGACY-1255',
    source: 'SYSTEM',
    arrivalReportedAt: new Date('2027-02-10T12:15:00.000Z'),
    departureReportedAt: new Date('2027-02-10T21:00:00.000Z'),
    marks: [],
    reviews: []
  };
  const { prisma } = prismaFixture(session);
  const { analysis } = await previewFor(prisma);

  assert.equal(analysis.summary.ready, 1);
  assert.equal(analysis.summary.replacements, 1);
  assert.equal(analysis.rows[0].replaceExisting, true);
});

test('la vista muestra y confirma cuántas jornadas existentes se reemplazarán', async () => {
  const view = await readFile(new URL('../src/views/operacionesGestionTiempo.ejs', import.meta.url), 'utf8');

  assert.match(view, /metric\('A reemplazar',values\.replacements\|\|0\)/);
  assert.match(view, /Se reemplazarán \${replacements} jornada\(s\) existente\(s\)/);
  assert.doesNotMatch(view, /jornada\(s\) administrativa\(s\) existente\(s\)/);
  assert.match(view, /replacedWorkdays/);
});
