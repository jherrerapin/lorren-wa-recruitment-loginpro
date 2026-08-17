import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKER_REST_ACTION,
  WORKER_REST_ENTITY_TYPE,
  WORKER_REST_REASONS,
  buildPayrollExportRows,
  loadPayrollReport,
  workerRestDayAdjustment
} from '../src/modules/dispatch-payroll/application/payrollReport.js';
import { buildPayrollExcelWorkbook } from '../src/routes/dispatchPayroll.js';

const WORKER_ID = 'TEST-WORKER-REMUNERATED';
const CLIENT_ID = 'TEST-CLIENT-REMUNERATED';
const POINT_ID = 'TEST-POINT-REMUNERATED';

function worker() {
  return {
    id: WORKER_ID,
    fullName: 'TEST Auxiliar remunerado',
    documentType: 'CC',
    documentNumber: 'TEST-DOC-REMUNERATED',
    phone: 'TEST-PHONE-REMUNERATED',
    contractType: 'DIRECTO',
    isTestProfile: false
  };
}

function session({ id, start, end, attendanceStatus = 'ON_TIME' }) {
  const arrivalReportedAt = start ? new Date(start) : null;
  const departureReportedAt = end ? new Date(end) : null;
  const expectedStartAt = new Date(start || '2026-08-14T13:00:00.000Z');
  const expectedEndAt = new Date(end || '2026-08-14T20:00:00.000Z');
  return {
    id,
    attendanceStatus,
    validationStatus: start && end ? 'MANUAL_VALIDATED' : 'PENDING',
    arrivalReportedAt,
    departureReportedAt,
    expectedStartAt,
    expectedEndAt,
    marks: [],
    reviews: [],
    assignment: {
      workerId: WORKER_ID,
      worker: worker(),
      serviceRequest: {
        source: 'INTERNAL',
        clientName: 'TEST Cliente',
        operationPointName: 'TEST Operación',
        operationPoint: {
          id: POINT_ID,
          clientId: CLIENT_ID,
          name: 'TEST Operación',
          client: { id: CLIENT_ID, name: 'TEST Cliente' }
        }
      }
    }
  };
}

function absenceSession() {
  return {
    ...session({ id: 'TEST-ABSENCE', start: null, end: null, attendanceStatus: 'ABSENT' }),
    expectedStartAt: new Date('2026-08-14T13:00:00.000Z'),
    expectedEndAt: new Date('2026-08-14T20:00:00.000Z'),
    arrivalReportedAt: null,
    departureReportedAt: null,
    attendanceStatus: 'ABSENT'
  };
}

function restEvent(restDate, reason, originSundayDate = null) {
  return {
    entityType: WORKER_REST_ENTITY_TYPE,
    entityId: `${WORKER_ID}|${restDate}`,
    action: WORKER_REST_ACTION,
    createdAt: new Date(`${restDate}T22:00:00.000Z`),
    metadata: {
      workerId: WORKER_ID,
      restDate,
      reason,
      status: 'ACTIVE',
      originSundayDate,
      dayAdjustment: workerRestDayAdjustment(reason),
      requiresJustification: true
    }
  };
}

function makePrisma() {
  const sessions = [
    // Empieza el sábado a las 21:00 Bogotá y termina el domingo a las 05:00: un solo turno nocturno.
    session({
      id: 'TEST-NIGHT-SHIFT',
      start: '2026-08-16T02:00:00.000Z',
      end: '2026-08-16T10:00:00.000Z'
    }),
    // Trabaja el mismo domingo entre 18:00 y 22:00; no debe duplicar el contador de domingos ni contar como turno nocturno.
    session({
      id: 'TEST-SUNDAY-EVENING',
      start: '2026-08-16T23:00:00.000Z',
      end: '2026-08-17T03:00:00.000Z'
    }),
    // 17 de agosto de 2026 es festivo trasladado en Colombia.
    session({
      id: 'TEST-HOLIDAY',
      start: '2026-08-17T13:00:00.000Z',
      end: '2026-08-17T20:00:00.000Z'
    }),
    absenceSession()
  ];
  const events = [
    restEvent('2026-08-12', WORKER_REST_REASONS.REMUNERADO, '2026-08-09'),
    // Coincide con una fecha efectivamente trabajada y por eso no debe sumar dos veces.
    restEvent('2026-08-15', WORKER_REST_REASONS.REMUNERADO, '2026-08-02'),
    restEvent('2026-08-13', WORKER_REST_REASONS.NO_REMUNERADA)
  ];

  return {
    dispatchAttendanceSession: {
      async findMany() { return sessions; }
    },
    dispatchClient: {
      async findMany() { return []; }
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

test('Nómina cuenta días remunerados/no remunerados y jornadas especiales sin duplicar fechas ni turnos nocturnos', async () => {
  const report = await loadPayrollReport(makePrisma(), {
    periodType: 'CUSTOM',
    from: '2026-08-12',
    to: '2026-08-17'
  }, { now: new Date('2026-08-18T12:00:00.000Z') });

  assert.equal(report.rows.length, 1);
  const row = report.rows[0];

  assert.equal(row.workedDays, 3, 'compatibilidad: conserva tres fechas operativas trabajadas');
  assert.equal(row.remuneratedDays, 4, '3 trabajadas + 2 compensatorios, con una fecha superpuesta contada una sola vez');
  assert.equal(row.unremuneratedDays, 2, '1 descanso no remunerado + 1 ausencia persistida');
  assert.equal(row.nightShiftCount, 1, 'el turno 21:00→05:00 cuenta una sola vez aunque cruce medianoche');
  assert.equal(row.sundayCount, 1, 'dos sesiones que tocan el mismo domingo cuentan una sola fecha dominical');
  assert.equal(row.holidayCount, 1, 'el festivo trabajado cuenta una sola fecha');

  assert.equal(report.totals.remuneratedDays, 4);
  assert.equal(report.totals.unremuneratedDays, 2);
  assert.equal(report.totals.nightShiftCount, 1);
  assert.equal(report.totals.sundayCount, 1);
  assert.equal(report.totals.holidayCount, 1);
});

test('el XLSX usa las nuevas columnas, elimina Días netos y el CSV heredado conserva su contrato', async () => {
  const report = await loadPayrollReport(makePrisma(), {
    periodType: 'CUSTOM',
    from: '2026-08-12',
    to: '2026-08-17'
  }, { now: new Date('2026-08-18T12:00:00.000Z') });

  const legacyRow = buildPayrollExportRows(report)[0];
  assert.equal(legacyRow.DiasTrabajados, 3);
  assert.equal(legacyRow.DiasDescontados, 1);
  assert.equal(legacyRow.DiasLaboradosNetos, 2);
  assert.equal(Object.hasOwn(legacyRow, 'DiasRemunerados'), false);

  const workbook = buildPayrollExcelWorkbook(report);
  const sheet = workbook.getWorksheet('Nómina');
  const headers = sheet.getRow(4).values.slice(1);
  assert.ok(headers.includes('DiasRemunerados'));
  assert.ok(headers.includes('DiasNoRemunerados'));
  assert.ok(headers.includes('TurnosNocturnos'));
  assert.ok(headers.includes('Domingos'));
  assert.ok(headers.includes('Festivos'));
  assert.equal(headers.includes('DiasTrabajados'), false);
  assert.equal(headers.includes('DiasDescontados'), false);
  assert.equal(headers.includes('DiasLaboradosNetos'), false);

  const valueFor = (header) => sheet.getCell(5, headers.indexOf(header) + 1).value;
  assert.equal(valueFor('DiasRemunerados'), 4);
  assert.equal(valueFor('DiasNoRemunerados'), 2);
  assert.equal(valueFor('TurnosNocturnos'), 1);
  assert.equal(valueFor('Domingos'), 1);
  assert.equal(valueFor('Festivos'), 1);
});
