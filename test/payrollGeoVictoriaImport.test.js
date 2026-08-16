import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  analyzePayrollAttendanceImport,
  buildPayrollAttendanceImportPreview,
  commitPayrollAttendanceImport,
  parsePayrollAttendanceImportFile,
  reversePayrollAttendanceImportBatch
} from '../src/modules/dispatch-payroll/application/payrollAttendanceImport.js';

function csvFile(text, name = 'marcaciones.csv') {
  return { originalname: name, mimetype: 'text/csv', buffer: Buffer.from(text, 'utf8') };
}

function attendanceAssignment({ session = null } = {}) {
  return {
    id: 'TEST-ASSIGNMENT-1',
    workerId: 'TEST-WORKER-1',
    status: 'CONFIRMED',
    serviceRequest: {
      id: 'TEST-REQUEST-1',
      serviceDate: new Date('2027-01-20T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '17:00',
      operationPointName: 'Operación Prueba',
      clientName: 'Cliente Prueba',
      operationPoint: {
        id: 'TEST-POINT-1',
        name: 'Operación Prueba',
        manualAttendanceAllowed: true,
        earlyArrivalWindowMinutes: 60
      }
    },
    attendanceSession: session
  };
}

function importPrismaFixture() {
  const state = {
    session: null,
    auditEvents: [],
    reviewed: []
  };
  const prisma = {
    dispatchWorker: {
      async findMany() {
        return [{
          id: 'TEST-WORKER-1',
          fullName: 'Auxiliar Prueba',
          documentNumber: 'TEST-1001',
          isTestProfile: false
        }];
      }
    },
    dispatchAssignment: {
      async findMany() { return [attendanceAssignment({ session: state.session })]; }
    },
    dispatchAttendanceSession: {
      async findUnique() { return state.session; }
    },
    devAuditEvent: {
      async create({ data }) {
        const event = { id: `TEST-AUDIT-${state.auditEvents.length + 1}`, createdAt: new Date(Date.UTC(2027, 0, 21, 12, state.auditEvents.length)), ...data };
        state.auditEvents.unshift(event);
        return event;
      },
      async findMany({ where }) {
        return state.auditEvents.filter((event) => (
          event.entityType === where.entityType
          && (!where.entityId || event.entityId === where.entityId)
          && (!where.action || (Array.isArray(where.action.in) ? where.action.in.includes(event.action) : event.action === where.action))
        ));
      }
    }
  };
  const attendanceWriter = async (_prisma, input) => {
    const marks = [
      ['ARRIVAL', input.arrivalReportedAt],
      ['BREAK_START', input.breakStartAt],
      ['BREAK_END', input.breakEndAt],
      ['DEPARTURE', input.departureReportedAt]
    ].filter(([, value]) => value).map(([markType, value], index) => ({
      id: `TEST-IMPORTED-MARK-${index + 1}`,
      markType,
      clientCapturedAt: new Date(`${value}-05:00`),
      serverReceivedAt: new Date('2027-01-21T12:00:00.000Z')
    }));
    state.session = {
      id: 'TEST-SESSION-1',
      assignmentId: input.assignmentId,
      marks
    };
    return state.session;
  };
  const workdayReviewer = async (_prisma, input) => {
    state.reviewed.push(input);
    state.session.marks = [];
    return state.session;
  };
  return { prisma, state, attendanceWriter, workdayReviewer };
}

test('CSV de eventos reconoce sinónimos e infiere cuatro marcaciones sin bloquear fecha futura', async () => {
  const file = csvFile([
    'Identificación;Colaborador;Fecha;Hora;Movimiento',
    'TEST-1001;Auxiliar Prueba;20/01/2027;08:00;Entrada',
    'TEST-1001;Auxiliar Prueba;20/01/2027;12:00;Salida',
    'TEST-1001;Auxiliar Prueba;20/01/2027;13:00;Entrada',
    'TEST-1001;Auxiliar Prueba;20/01/2027;17:00;Salida'
  ].join('\n'));

  const parsed = await parsePayrollAttendanceImportFile(file);
  assert.equal(parsed.format, 'CSV');
  assert.equal(parsed.needsMapping, false);
  assert.equal(parsed.workdays.length, 1);
  assert.equal(parsed.workdays[0].dateKey, '2027-01-20');
  assert.deepEqual(parsed.workdays[0].marks.map((mark) => mark.markType), ['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);
});

test('conserva los segundos de GeoVictoria y rechaza fechas calendario imposibles sin imponer límite temporal', async () => {
  const file = csvFile([
    'Documento;Fecha;Entrada;Salida',
    'TEST-1001;20/01/2027;08:00:37;17:00:49',
    'TEST-1002;31/02/2027;08:00:00;17:00:00'
  ].join('\n'));

  const parsed = await parsePayrollAttendanceImportFile(file);
  assert.equal(parsed.workdays.length, 2);
  assert.deepEqual(parsed.workdays[0].marks.map((mark) => mark.localDateTime), [
    '2027-01-20T08:00:37',
    '2027-01-20T17:00:49'
  ]);
  assert.equal(parsed.workdays[1].parseStatus, 'INVALID');
  assert.equal(parsed.workdays[1].dateKey, null);
});

test('Excel diario reconoce Entrada 1/Salida 1/Entrada 2/Salida 2', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Marcaciones');
  sheet.addRow(['Cédula', 'Empleado', 'Fecha turno', 'Entrada 1', 'Salida 1', 'Entrada 2', 'Salida 2']);
  sheet.addRow(['TEST-1001', 'Auxiliar Prueba', '20/01/2027', '08:00', '12:00', '13:00', '17:00']);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const parsed = await parsePayrollAttendanceImportFile({ originalname: 'geovictoria.xlsx', buffer });
  assert.equal(parsed.format, 'XLSX');
  assert.equal(parsed.sheetName, 'Marcaciones');
  assert.equal(parsed.workdays.length, 1);
  assert.deepEqual(parsed.workdays[0].marks.map((mark) => mark.localDateTime), [
    '2027-01-20T08:00:00',
    '2027-01-20T12:00:00',
    '2027-01-20T13:00:00',
    '2027-01-20T17:00:00'
  ]);
});

test('si los encabezados no son conocidos, permite mapearlos sin modificar el CSV', async () => {
  const file = csvFile([
    'Legajo;Persona;DíaLaboral;Reloj1;Reloj2',
    'TEST-1001;Auxiliar Prueba;20/01/2027;08:00;17:00'
  ].join('\n'));

  const first = await parsePayrollAttendanceImportFile(file);
  assert.equal(first.needsMapping, true);
  assert.deepEqual(first.headers, ['Legajo', 'Persona', 'DíaLaboral', 'Reloj1', 'Reloj2']);

  const mapped = await parsePayrollAttendanceImportFile(file, {
    mapping: {
      document: 'Legajo',
      name: 'Persona',
      date: 'DíaLaboral',
      arrival: 'Reloj1',
      departure: 'Reloj2'
    }
  });
  assert.equal(mapped.needsMapping, false);
  assert.deepEqual(mapped.workdays[0].marks.map((mark) => mark.markType), ['ARRIVAL', 'DEPARTURE']);
});

test('conciliación usa documento, asignación real y no sobrescribe una jornada con marcas diferentes', async () => {
  const file = csvFile([
    'Documento;Fecha;Entrada;Salida',
    'TEST-1001;20/01/2027;08:00;17:00'
  ].join('\n'));
  const parsed = await parsePayrollAttendanceImportFile(file);
  const { prisma, state } = importPrismaFixture();

  const ready = await analyzePayrollAttendanceImport(prisma, parsed);
  assert.equal(ready.summary.ready, 1);
  assert.equal(ready.rows[0].assignmentId, 'TEST-ASSIGNMENT-1');

  state.session = {
    id: 'TEST-SESSION-1',
    marks: [
      { id: 'TEST-OLD-1', markType: 'ARRIVAL', clientCapturedAt: new Date('2027-01-20T13:15:00.000Z') },
      { id: 'TEST-OLD-2', markType: 'DEPARTURE', clientCapturedAt: new Date('2027-01-20T22:00:00.000Z') }
    ]
  };
  const conflict = await analyzePayrollAttendanceImport(prisma, parsed);
  assert.equal(conflict.summary.ready, 0);
  assert.equal(conflict.summary.unresolved, 1);
  assert.match(conflict.rows[0].message, /ya tiene marcaciones diferentes/i);
});

test('no considera libre una sesión que conserva horas persistidas aunque no tenga marcas detalladas', async () => {
  const file = csvFile([
    'Documento;Fecha;Entrada;Salida',
    'TEST-1001;20/01/2027;08:00;17:00'
  ].join('\n'));
  const parsed = await parsePayrollAttendanceImportFile(file);
  const { prisma, state } = importPrismaFixture();
  state.session = {
    id: 'TEST-SESSION-LEGACY',
    arrivalReportedAt: new Date('2027-01-20T13:00:00.000Z'),
    departureReportedAt: new Date('2027-01-20T22:00:00.000Z'),
    marks: []
  };

  const analysis = await analyzePayrollAttendanceImport(prisma, parsed);
  assert.equal(analysis.summary.ready, 0);
  assert.equal(analysis.summary.unresolved, 1);
  assert.match(analysis.rows[0].message, /horas persistidas/i);
});

test('la confirmación exige la misma conciliación que fue previsualizada', async () => {
  const file = csvFile([
    'Documento;Fecha;Entrada;Salida',
    'TEST-1001;20/01/2027;08:00;17:00'
  ].join('\n'));
  const { prisma, attendanceWriter } = importPrismaFixture();

  await assert.rejects(
    () => commitPayrollAttendanceImport(prisma, file, {
      previewFingerprint: 'TEST-FINGERPRINT-ANTERIOR',
      actor: { actorUsername: 'coordinacion-prueba', actorRole: 'admin' }
    }, { attendanceWriter }),
    /payroll_import_preview_stale/
  );
});

test('importación audita el lote y la reversa protege una marca modificada después', async () => {
  const file = csvFile([
    'Documento;Fecha;Entrada;Inicio almuerzo;Fin almuerzo;Salida',
    'TEST-1001;20/01/2027;08:00;12:00;13:00;17:00'
  ].join('\n'));
  const { prisma, state, attendanceWriter, workdayReviewer } = importPrismaFixture();
  const parsed = await parsePayrollAttendanceImportFile(file);
  const preview = buildPayrollAttendanceImportPreview(await analyzePayrollAttendanceImport(prisma, parsed));
  const committed = await commitPayrollAttendanceImport(prisma, file, {
    previewFingerprint: preview.previewFingerprint,
    actor: { actorUserId: 'TEST-USER', actorUsername: 'coordinacion-prueba', actorRole: 'admin' }
  }, { attendanceWriter });

  assert.equal(committed.summary.importedWorkdays, 1);
  assert.equal(committed.summary.importedMarks, 4);
  const importedEvent = state.auditEvents.find((event) => event.action === 'PAYROLL_ATTENDANCE_IMPORTED');
  assert.ok(importedEvent);
  assert.equal(importedEvent.metadata.workdays[0].marks.length, 4);
  assert.equal(JSON.stringify(importedEvent.metadata).includes('Auxiliar Prueba'), false);
  assert.equal(JSON.stringify(importedEvent.metadata).includes('TEST-1001'), false);

  state.session.marks[0].clientCapturedAt = new Date('2027-01-20T13:05:00.000Z');
  const protectedReverse = await reversePayrollAttendanceImportBatch(prisma, committed.batchId, {
    actor: { actorUsername: 'coordinacion-prueba', actorRole: 'admin' }
  }, { workdayReviewer });
  assert.equal(protectedReverse.status, 'PARTIAL');
  assert.equal(protectedReverse.conflicts, 1);
  assert.equal(state.reviewed.length, 0);
  assert.equal(state.session.marks.length, 4);

  state.session.marks[0].clientCapturedAt = new Date('2027-01-20T13:00:00.000Z');
  const completedReverse = await reversePayrollAttendanceImportBatch(prisma, committed.batchId, {
    actor: { actorUsername: 'coordinacion-prueba', actorRole: 'admin' }
  }, { workdayReviewer });
  assert.equal(completedReverse.status, 'REVERSED');
  assert.equal(completedReverse.reversedWorkdays, 1);
  assert.equal(state.reviewed[0].action, 'CLEAR');
  assert.equal(state.session.marks.length, 0);
});
