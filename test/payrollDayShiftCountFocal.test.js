import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPayrollReport } from '../src/modules/dispatch-payroll/application/payrollReport.js';
import { buildPayrollExcelWorkbook } from '../src/routes/dispatchPayroll.js';

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
          clientId: 'TEST-CLIENT-DAY-NIGHT',
          name: 'TEST Operación',
          client: { id: 'TEST-CLIENT-DAY-NIGHT', name: 'TEST Cliente' }
        }
      }
    }
  };
}

function prisma() {
  return {
    dispatchAttendanceSession: {
      async findMany() {
        return [
          // 21:00 del 15 → 05:00 del 16 en Bogotá: un turno nocturno, nunca un diurno adicional por la madrugada.
          shift('TEST-NIGHT-OVERNIGHT', '2026-08-16T02:00:00.000Z', '2026-08-16T10:00:00.000Z'),
          // 08:00 → 16:00 del 16 en Bogotá: un turno diurno.
          shift('TEST-DAY', '2026-08-16T13:00:00.000Z', '2026-08-16T21:00:00.000Z')
        ];
      }
    },
    dispatchClient: { async findMany() { return []; } },
    dispatchWorker: { async findMany() { return [worker]; } },
    devAuditEvent: { async findMany() { return []; } }
  };
}

test('21:00→05:00 queda exclusivamente nocturno y la jornada diurna cuenta una vez', async () => {
  const report = await loadPayrollReport(prisma(), {
    periodType: 'CUSTOM',
    from: '2026-08-15',
    to: '2026-08-16'
  }, { now: new Date('2026-08-17T12:00:00.000Z') });

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].workedDays, 2, 'hay dos fechas operativas con trabajo');
  assert.equal(report.rows[0].nightShiftCount, 1, 'el cruce de medianoche cuenta una sola vez como nocturno');

  const workbook = buildPayrollExcelWorkbook(report, { columns: ['TurnosDiurnos', 'TurnosNocturnos'] });
  const sheet = workbook.getWorksheet('Nómina');
  assert.deepEqual(sheet.getRow(4).values.slice(1), ['TurnosDiurnos', 'TurnosNocturnos']);
  assert.deepEqual(sheet.getRow(5).values.slice(1), [1, 1]);
});
