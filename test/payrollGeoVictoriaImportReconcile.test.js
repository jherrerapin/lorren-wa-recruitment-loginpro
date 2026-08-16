import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  analyzePayrollAttendanceImport,
  buildPayrollAttendanceImportPreview,
  commitPayrollAttendanceImport,
  parsePayrollAttendanceImportFile
} from '../src/modules/dispatch-payroll/application/payrollAttendanceImport.js';

function csvFile(text, name = 'marcaciones.csv') {
  return { originalname: name, mimetype: 'text/csv', buffer: Buffer.from(text, 'utf8') };
}

function assignment({
  id = 'TEST-ASSIGNMENT-1249',
  requestId = null,
  pointId = null,
  session = null,
  serviceDate = '2027-01-20',
  startTime = '08:00',
  endTime = '17:00',
  operationPointName = 'Operación Prueba'
} = {}) {
  const serviceRequestId = requestId || (id === 'TEST-ASSIGNMENT-1249' ? 'TEST-REQUEST-1249' : `${id}-REQUEST`);
  const operationPointId = pointId || (id === 'TEST-ASSIGNMENT-1249' ? 'TEST-POINT-1249' : `${id}-POINT`);
  return {
    id,
    workerId: 'TEST-WORKER-1249',
    status: 'CONFIRMED',
    serviceRequest: {
      id: serviceRequestId,
      serviceDate: new Date(`${serviceDate}T00:00:00.000Z`),
      startTime,
      endTime,
      operationPointName,
      clientName: 'Cliente Prueba',
      operationPoint: {
        id: operationPointId,
        name: operationPointName,
        manualAttendanceAllowed: true,
        earlyArrivalWindowMinutes: 60
      }
    },
    attendanceSession: session
  };
}

function worker() {
  return {
    id: 'TEST-WORKER-1249',
    fullName: 'Auxiliar Prueba',
    documentNumber: 'TEST-1001',
    isTestProfile: false
  };
}

function eventMatches(event, where = {}) {
  if (where.entityType && event.entityType !== where.entityType) return false;
  if (where.entityId && event.entityId !== where.entityId) return false;
  if (where.action) {
    if (typeof where.action === 'string' && event.action !== where.action) return false;
    if (Array.isArray(where.action.in) && !where.action.in.includes(event.action)) return false;
  }
  return true;
}

function prismaFixture({ currentAssignment, currentAssignments = null, auditEvents = [] }) {
  const assignments = Array.isArray(currentAssignments)
    ? currentAssignments.filter(Boolean)
    : [currentAssignment].filter(Boolean);
  const state = {
    assignment: assignments[0] || null,
    assignments,
    auditEvents: [...auditEvents],
    cleared: 0
  };
  const prisma = {
    dispatchWorker: {
      async findMany() { return [worker()]; }
    },
    dispatchAssignment: {
      async findMany() { return state.assignments; }
    },
    dispatchAttendanceSession: {
      async findUnique({ where } = {}) {
        const matched = state.assignments.find((item) => item.attendanceSession?.id === where?.id);
        return matched?.attendanceSession || state.assignment?.attendanceSession || null;
      }
    },
    devAuditEvent: {
      async findMany({ where = {}, orderBy, take } = {}) {
        let result = state.auditEvents.filter((event) => eventMatches(event, where));
        if (orderBy?.createdAt === 'desc') result = [...result].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
        return Number.isInteger(take) ? result.slice(0, take) : result;
      },
      async create({ data }) {
        const event = {
          id: `TEST-AUDIT-1249-${state.auditEvents.length + 1}`,
          createdAt: new Date(`2027-01-21T12:${String(state.auditEvents.length).padStart(2, '0')}:30.000Z`),
          ...data
        };
        state.auditEvents.unshift(event);
        return event;
      }
    }
  };
  return { prisma, state };
}

function signature(markType, localDateTime) {
  return `${markType}|${new Date(`${localDateTime}-05:00`).getTime()}`;
}

test('reconoce el export diario real Entró/Salió/Entró/Salió y conserva almuerzo ausente como dos marcas', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Asistencia');
  sheet.addRow(['Nombre', 'Identificador', 'Fecha', 'Entró', 'Salió', 'Entró', 'Salió']);
  sheet.addRow(['Auxiliar Prueba', 'TEST-1001', '20/01/2027', '08:00', '12:00', '13:00', '17:00']);
  sheet.addRow(['Auxiliar Prueba', 'TEST-1001', '21/01/2027', '07:00', '', '', '15:00']);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const parsed = await parsePayrollAttendanceImportFile({ originalname: 'geovictoria.xlsx', buffer });

  assert.equal(parsed.needsMapping, false);
  assert.equal(parsed.columns.document, 1);
  assert.equal(parsed.columns.arrival, 3);
  assert.equal(parsed.columns.breakStart, 4);
  assert.equal(parsed.columns.breakEnd, 5);
  assert.equal(parsed.columns.departure, 6);
  assert.deepEqual(parsed.workdays[0].marks.map((mark) => mark.markType), [
    'ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'
  ]);
  assert.deepEqual(parsed.workdays[1].marks.map((mark) => mark.markType), ['ARRIVAL', 'DEPARTURE']);
  assert.deepEqual(parsed.workdays[1].marks.map((mark) => mark.localDateTime), [
    '2027-01-21T07:00:00',
    '2027-01-21T15:00:00'
  ]);
});

test('resuelve X+1 solo cuando la asignación real es nocturna', async () => {
  const file = csvFile([
    'Documento;Fecha;Entrada 1;Salida 1;Entrada 2;Salida 2',
    'TEST-1001;20/01/2027;21:25;01:00;02:00;06:00'
  ].join('\n'));
  const parsed = await parsePayrollAttendanceImportFile(file);

  const night = prismaFixture({
    currentAssignment: assignment({ startTime: '21:00', endTime: '06:00' })
  });
  const nightAnalysis = await analyzePayrollAttendanceImport(night.prisma, parsed);
  assert.equal(nightAnalysis.summary.ready, 1);
  assert.deepEqual(nightAnalysis.rows[0].marks.map((mark) => mark.localDateTime), [
    '2027-01-20T21:25:00',
    '2027-01-21T01:00:00',
    '2027-01-21T02:00:00',
    '2027-01-21T06:00:00'
  ]);

  const day = prismaFixture({ currentAssignment: assignment({ startTime: '08:00', endTime: '17:00' }) });
  const dayAnalysis = await analyzePayrollAttendanceImport(day.prisma, parsed);
  assert.equal(dayAnalysis.summary.ready, 0);
  assert.equal(dayAnalysis.summary.unresolved, 1);
  assert.deepEqual(dayAnalysis.rows[0].marks.map((mark) => mark.localDateTime), [
    '2027-01-20T21:25:00',
    '2027-01-20T01:00:00',
    '2027-01-20T02:00:00',
    '2027-01-20T06:00:00'
  ]);
});

test('desempata varias asignaciones del mismo día cuando solo una ventana programada coincide', async () => {
  const file = csvFile([
    'Documento;Fecha;Entrada 1;Salida 1;Entrada 2;Salida 2',
    'TEST-1001;20/01/2027;06:34;10:00;11:00;14:51'
  ].join('\n'));
  const parsed = await parsePayrollAttendanceImportFile(file);
  const { prisma } = prismaFixture({
    currentAssignments: [
      assignment({ id: 'TEST-ASSIGNMENT-DAY', startTime: '06:00', endTime: '15:00' }),
      assignment({ id: 'TEST-ASSIGNMENT-NIGHT', startTime: '18:00', endTime: '02:00' })
    ]
  });

  const analysis = await analyzePayrollAttendanceImport(prisma, parsed);

  assert.equal(analysis.summary.ready, 1);
  assert.equal(analysis.summary.unresolved, 0);
  assert.equal(analysis.rows[0].assignmentId, 'TEST-ASSIGNMENT-DAY');
});

test('desempata una jornada nocturna y conserva X+1 al elegir la única ventana compatible', async () => {
  const file = csvFile([
    'Documento;Fecha;Entrada 1;Salida 1;Entrada 2;Salida 2',
    'TEST-1001;20/01/2027;21:25;01:00;02:00;06:00'
  ].join('\n'));
  const parsed = await parsePayrollAttendanceImportFile(file);
  const { prisma } = prismaFixture({
    currentAssignments: [
      assignment({ id: 'TEST-ASSIGNMENT-DAY', startTime: '08:00', endTime: '17:00' }),
      assignment({ id: 'TEST-ASSIGNMENT-NIGHT', startTime: '21:00', endTime: '06:00' })
    ]
  });

  const analysis = await analyzePayrollAttendanceImport(prisma, parsed);

  assert.equal(analysis.summary.ready, 1);
  assert.equal(analysis.rows[0].assignmentId, 'TEST-ASSIGNMENT-NIGHT');
  assert.deepEqual(analysis.rows[0].marks.map((mark) => mark.localDateTime), [
    '2027-01-20T21:25:00',
    '2027-01-21T01:00:00',
    '2027-01-21T02:00:00',
    '2027-01-21T06:00:00'
  ]);
});

test('mantiene la ambigüedad cuando dos asignaciones siguen siendo compatibles con las horas', async () => {
  const file = csvFile([
    'Documento;Fecha;Entrada;Salida',
    'TEST-1001;20/01/2027;10:00;14:00'
  ].join('\n'));
  const parsed = await parsePayrollAttendanceImportFile(file);
  const { prisma } = prismaFixture({
    currentAssignments: [
      assignment({ id: 'TEST-ASSIGNMENT-EARLY', startTime: '06:00', endTime: '15:00' }),
      assignment({ id: 'TEST-ASSIGNMENT-LATE', startTime: '08:00', endTime: '17:00' })
    ]
  });

  const analysis = await analyzePayrollAttendanceImport(prisma, parsed);

  assert.equal(analysis.summary.ready, 0);
  assert.equal(analysis.summary.unresolved, 1);
  assert.match(analysis.rows[0].message, /varias asignaciones posibles/i);
});

test('explica cuando ninguna de varias asignaciones admite las horas del archivo', async () => {
  const file = csvFile([
    'Documento;Fecha;Entrada;Salida',
    'TEST-1001;20/01/2027;12:00;14:00'
  ].join('\n'));
  const parsed = await parsePayrollAttendanceImportFile(file);
  const { prisma } = prismaFixture({
    currentAssignments: [
      assignment({ id: 'TEST-ASSIGNMENT-MORNING', startTime: '06:00', endTime: '09:00' }),
      assignment({ id: 'TEST-ASSIGNMENT-EVENING', startTime: '18:00', endTime: '22:00' })
    ]
  });

  const analysis = await analyzePayrollAttendanceImport(prisma, parsed);

  assert.equal(analysis.summary.ready, 0);
  assert.equal(analysis.summary.unresolved, 1);
  assert.match(analysis.rows[0].message, /ninguna admite.*horas/i);
});

test('una segunda importación reemplaza solo una jornada creada por GeoVictoria que sigue intacta', async () => {
  const oldBatchId = 'TEST-BATCH-1249-OLD';
  const oldMarks = [
    { id: 'TEST-OLD-ARRIVAL', markType: 'ARRIVAL', clientCapturedAt: new Date('2027-01-20T13:15:00.000Z') },
    { id: 'TEST-OLD-DEPARTURE', markType: 'DEPARTURE', clientCapturedAt: new Date('2027-01-20T22:00:00.000Z') }
  ];
  const session = {
    id: 'TEST-SESSION-1249',
    arrivalReportedAt: oldMarks[0].clientCapturedAt,
    departureReportedAt: oldMarks[1].clientCapturedAt,
    marks: oldMarks,
    reviews: [{
      action: 'MANUAL_WORKDAY',
      reason: `Marcaciones importadas desde GeoVictoria · lote ${oldBatchId}`,
      createdAt: new Date('2027-01-21T11:59:00.000Z')
    }]
  };
  const oldImport = {
    entityType: 'DISPATCH_PAYROLL_ATTENDANCE_IMPORT',
    entityId: oldBatchId,
    action: 'PAYROLL_ATTENDANCE_IMPORTED',
    createdAt: new Date('2027-01-21T12:00:00.000Z'),
    metadata: {
      workdays: [{
        sessionId: session.id,
        assignmentId: 'TEST-ASSIGNMENT-1249',
        marks: [
          { id: 'TEST-OLD-ARRIVAL', signature: signature('ARRIVAL', '2027-01-20T08:15:00') },
          { id: 'TEST-OLD-DEPARTURE', signature: signature('DEPARTURE', '2027-01-20T17:00:00') }
        ]
      }]
    }
  };
  const { prisma, state } = prismaFixture({
    currentAssignment: assignment({ session }),
    auditEvents: [oldImport]
  });
  const replacement = csvFile([
    'Documento;Fecha;Entrada;Salida',
    'TEST-1001;20/01/2027;08:00;17:00'
  ].join('\n'));
  const parsed = await parsePayrollAttendanceImportFile(replacement);
  const analysis = await analyzePayrollAttendanceImport(prisma, parsed);

  assert.equal(analysis.summary.ready, 1);
  assert.equal(analysis.summary.replacements, 1);
  assert.equal(analysis.rows[0].replaceExisting, true);
  assert.equal(analysis.rows[0].replaceBatchId, oldBatchId);

  const preview = buildPayrollAttendanceImportPreview(analysis);
  const workdayReviewer = async (_prisma, input) => {
    assert.equal(input.action, 'CLEAR');
    assert.equal(input.sessionId, session.id);
    state.cleared += 1;
    state.assignment.attendanceSession = {
      ...state.assignment.attendanceSession,
      arrivalReportedAt: null,
      departureReportedAt: null,
      marks: []
    };
    return state.assignment.attendanceSession;
  };
  const attendanceWriter = async (_prisma, input) => {
    const marks = [
      ['ARRIVAL', input.arrivalReportedAt],
      ['BREAK_START', input.breakStartAt],
      ['BREAK_END', input.breakEndAt],
      ['DEPARTURE', input.departureReportedAt]
    ].filter(([, value]) => value).map(([markType, value], index) => ({
      id: `TEST-NEW-MARK-${index + 1}`,
      markType,
      clientCapturedAt: new Date(`${value}-05:00`),
      serverReceivedAt: new Date('2027-01-21T12:05:00.000Z')
    }));
    state.assignment.attendanceSession = {
      id: session.id,
      assignmentId: 'TEST-ASSIGNMENT-1249',
      arrivalReportedAt: marks.find((mark) => mark.markType === 'ARRIVAL')?.clientCapturedAt || null,
      departureReportedAt: marks.find((mark) => mark.markType === 'DEPARTURE')?.clientCapturedAt || null,
      marks,
      reviews: []
    };
    return state.assignment.attendanceSession;
  };

  const committed = await commitPayrollAttendanceImport(prisma, replacement, {
    previewFingerprint: preview.previewFingerprint,
    actor: { actorUsername: 'coordinacion-prueba', actorRole: 'admin' },
    now: new Date('2027-01-21T12:04:00.000Z')
  }, { attendanceWriter, workdayReviewer });

  assert.equal(state.cleared, 1);
  assert.equal(committed.summary.replacedWorkdays, 1);
  assert.deepEqual(state.assignment.attendanceSession.marks.map((mark) => [mark.markType, mark.clientCapturedAt.toISOString()]), [
    ['ARRIVAL', '2027-01-20T13:00:00.000Z'],
    ['DEPARTURE', '2027-01-20T22:00:00.000Z']
  ]);
});

test('una jornada importada pero modificada después sigue protegida contra sobrescritura', async () => {
  const oldBatchId = 'TEST-BATCH-1249-PROTECTED';
  const session = {
    id: 'TEST-SESSION-1249-PROTECTED',
    marks: [
      { id: 'TEST-PROTECTED-ARRIVAL', markType: 'ARRIVAL', clientCapturedAt: new Date('2027-01-20T13:20:00.000Z') },
      { id: 'TEST-PROTECTED-DEPARTURE', markType: 'DEPARTURE', clientCapturedAt: new Date('2027-01-20T22:00:00.000Z') }
    ],
    reviews: [{
      action: 'WORKDAY_EDIT_MARK',
      reason: 'Corrección de prueba posterior al lote.',
      createdAt: new Date('2027-01-21T12:10:00.000Z')
    }]
  };
  const oldImport = {
    entityType: 'DISPATCH_PAYROLL_ATTENDANCE_IMPORT',
    entityId: oldBatchId,
    action: 'PAYROLL_ATTENDANCE_IMPORTED',
    createdAt: new Date('2027-01-21T12:00:00.000Z'),
    metadata: { workdays: [] }
  };
  const { prisma } = prismaFixture({ currentAssignment: assignment({ session }), auditEvents: [oldImport] });
  const file = csvFile([
    'Documento;Fecha;Entrada;Salida',
    'TEST-1001;20/01/2027;08:00;17:00'
  ].join('\n'));
  const analysis = await analyzePayrollAttendanceImport(prisma, await parsePayrollAttendanceImportFile(file));

  assert.equal(analysis.summary.ready, 0);
  assert.equal(analysis.summary.unresolved, 1);
  assert.match(analysis.rows[0].message, /no corresponde a un lote GeoVictoria intacto/i);
});