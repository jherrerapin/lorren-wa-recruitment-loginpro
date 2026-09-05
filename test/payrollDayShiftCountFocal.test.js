import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPayrollReport } from '../src/modules/dispatch-payroll/application/payrollReport.js';
import { buildPayrollExcelWorkbook } from '../src/routes/dispatchPayroll.js';

const CLIENT_ID = 'TEST-CLIENT-DAY-NIGHT';
const worker = {
  id: 'TEST-WORKER-DAY-NIGHT',
  fullName: 'TEST Auxiliar turnos',
  documentType: 'CC',
  documentNumber: 'TEST-DOC-DAY-NIGHT',
  phone: 'TEST-PHONE-DAY-NIGHT',
  contractType: 'DIRECTO',
  isTestProfile: false
};

function shift(id, start, end) {
  return {
    id,
    attendanceStatus: 'ON_TIME',
    validationStatus: 'MANUAL_VALIDATED',
    arrivalReportedAt: new Date(start),
    departureReportedAt: new Date(end),
    expectedStartAt: new Date(start),
    expectedEndAt: new Date(end),
    marks: [],
    reviews: [],
    assignment: {
      workerId: worker.id,
      worker,
      serviceRequest: {
        source: 'INTERNAL',
        clientName: 'TEST Cliente',
        operationPointName: 'TEST Operación',
        operationPoint: {
          id: 'TEST-POINT-DAY-NIGHT',
          clientId: CLIENT_ID,
          name: 'TEST Operación',
          client: { id: CLIENT_ID, name: 'TEST Cliente' }
        }
      }
    }
  };
}

function prisma(sessions, policy = null) {
  return {
    dispatchAttendanceSession: {
      async findMany() {
        return sessions;
      }
    },
    dispatchClient: { async findMany() { return []; } },
    dispatchWorker: { async findMany() { return [worker]; } },
    devAuditEvent: {
      async findMany({ where } = {}) {
        if (policy && where?.entityType === 'DISPATCH_PAYROLL_POLICY') {
          return [{ entityId: CLIENT_ID, metadata: { policy } }];
        }
        return [];
      }
    }
  };
}

test('domingo diurno no suma TurnosDiurnos y 21:00→05:00 no crea diurno por la madrugada', async () => {
  const report = await loadPayrollReport(prisma([
    // Sábado 21:00 → domingo 05:00 en Bogotá: un turno nocturno, nunca un diurno adicional por la madrugada.
    shift('TEST-NIGHT-OVERNIGHT', '2026-08-16T02:00:00.000Z', '2026-08-16T10:00:00.000Z'),
    // Domingo 08:00 → 16:00: se refleja como domingo, pero no como turno diurno.
    shift('TEST-SUNDAY-DAY', '2026-08-16T13:00:00.000Z', '2026-08-16T21:00:00.000Z'),
    // Lunes 08:00 → 16:00: un turno diurno válido.
    shift('TEST-MONDAY-DAY', '2026-08-17T13:00:00.000Z', '2026-08-17T21:00:00.000Z')
  ]), {
    periodType: 'CUSTOM',
    from: '2026-08-15',
    to: '2026-08-17'
  }, { now: new Date('2026-08-18T12:00:00.000Z') });

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].workedDays, 3, 'hay tres fechas operativas con trabajo');
  assert.equal(report.rows[0].dayShiftCount, 1, 'solo lunes-sábado diurno incrementa TurnosDiurnos');
  assert.equal(report.rows[0].nightShiftCount, 1, 'el cruce de medianoche cuenta una sola vez como nocturno');
  assert.equal(report.rows[0].sundayCount, 1, 'el domingo permanece en su dimensión propia');
  assert.equal(report.totals.dayShiftCount, 1);
  assert.equal(report.totals.nightShiftCount, 1);

  const workbook = buildPayrollExcelWorkbook(report, { columns: ['TurnosDiurnos', 'TurnosNocturnos'] });
  const sheet = workbook.getWorksheet('Gestión de Tiempo');
  assert.deepEqual(sheet.getRow(4).values.slice(1), ['TurnosDiurnos', 'TurnosNocturnos']);
  assert.deepEqual(sheet.getRow(5).values.slice(1), [1, 1]);
});

test('el inicio en madrugada respeta la ventana nocturna configurada del cliente', async () => {
  const report = await loadPayrollReport(prisma([
    // Martes 06:30 → 14:30 en Bogotá: con ventana 20:00→07:00 debe clasificarse como nocturno por su inicio.
    shift('TEST-EARLY-MORNING', '2026-08-18T11:30:00.000Z', '2026-08-18T19:30:00.000Z')
  ], {
    nightStartMinute: 20 * 60,
    nightEndMinute: 7 * 60
  }), {
    periodType: 'CUSTOM',
    from: '2026-08-18',
    to: '2026-08-18'
  }, { now: new Date('2026-08-19T12:00:00.000Z') });

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].dayShiftCount, 0);
  assert.equal(report.rows[0].nightShiftCount, 1);
});