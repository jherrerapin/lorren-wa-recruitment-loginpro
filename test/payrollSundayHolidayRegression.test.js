import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';
import {
  PAYROLL_COMPENSATION_STATUS,
  PAYROLL_CONCEPT_CODES,
  calculatePayrollConceptReport,
  formatPayrollMinutes,
  normalizePayrollPolicy
} from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';
import { savePayrollCompensation } from '../src/modules/dispatch-payroll/application/payrollReport.js';

function payrollSession({
  id,
  arrivalAt,
  departureAt,
  workedMinutes,
  workerId = 'TEST-WORKER-1',
  clientId = 'TEST-CLIENT-1'
}) {
  return {
    id,
    arrivalReportedAt: new Date(arrivalAt),
    departureReportedAt: new Date(departureAt),
    expectedStartAt: new Date(arrivalAt),
    expectedEndAt: new Date(departureAt),
    workedMinutes,
    validationStatus: 'MANUAL_VALIDATED',
    marks: [],
    assignment: {
      workerId,
      worker: {
        id: workerId,
        fullName: 'Auxiliar de prueba',
        documentType: 'CC',
        documentNumber: 'TEST-DOC-1',
        phone: 'TEST-PHONE-1'
      },
      serviceRequest: {
        clientName: 'Cliente de prueba',
        operationPointName: 'Operación de prueba',
        operationPoint: {
          id: 'TEST-POINT-1',
          clientId,
          name: 'Operación de prueba',
          client: { id: clientId, name: 'Cliente de prueba' }
        }
      }
    }
  };
}

function calculate(sessions, {
  from,
  to = from,
  policy = {},
  compensation = new Map()
} = {}) {
  return calculatePayrollConceptReport({
    sessions,
    range: { from, to },
    policiesByClientId: new Map([['TEST-CLIENT-1', policy]]),
    compensationByWorkerDate: compensation
  });
}

test('domingo de 18:00 a 22:00 separa recargo diurno y nocturno sin perder minutos', () => {
  const sunday = payrollSession({
    id: 'TEST-SUNDAY-ORDINARY',
    arrivalAt: '2026-08-09T23:00:00.000Z',
    departureAt: '2026-08-10T03:00:00.000Z',
    workedMinutes: 240
  });

  const pending = calculate([sunday], {
    from: '2026-08-09',
    compensation: new Map([['TEST-WORKER-1|2026-08-09', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]])
  });
  const pendingRow = pending.rows[0];
  assert.equal(pendingRow.totalMinutes, 240);
  assert.equal(pendingRow.conceptMinutes.RDD, 60);
  assert.equal(pendingRow.conceptMinutes.RND, 180);
  assert.equal(pendingRow.conceptMinutes.RNO, 0);
  assert.equal(pendingRow.daily[0].isRestDay, true);
  assert.equal(pendingRow.daily[0].isHoliday, false);

  const compensated = calculate([sunday], {
    from: '2026-08-09',
    compensation: new Map([['TEST-WORKER-1|2026-08-09', PAYROLL_COMPENSATION_STATUS.COMPENSATED]])
  });
  assert.equal(compensated.rows[0].conceptMinutes.RDDC, 60);
  assert.equal(compensated.rows[0].conceptMinutes.RNDC, 180);
  assert.equal(compensated.rows[0].conceptMinutes.RDD, 0);
  assert.equal(compensated.rows[0].conceptMinutes.RND, 0);
});

test('una política histórica que inicia domingo se normaliza a lunes y no reinicia las 42 horas antes del dominical nocturno', () => {
  const historicalPolicy = {
    weeklyOrdinaryMinutes: 42 * 60,
    dailyOrdinaryMinutes: 7 * 60,
    maxDailyOvertimeMinutes: 2 * 60,
    maxWeeklyOvertimeMinutes: 12 * 60,
    nightStartMinute: 19 * 60,
    nightEndMinute: 6 * 60,
    weekStartsOn: 0,
    restDay: 0,
    holidaySundayPriority: 'REST'
  };
  const normalized = normalizePayrollPolicy(historicalPolicy);
  assert.equal(normalized.weekStartsOn, 1);
  assert.equal(normalized.holidaySundayPriority, 'HOLIDAY');

  const sessions = [];
  for (let day = 3; day <= 8; day += 1) {
    sessions.push(payrollSession({
      id: `TEST-WEEK-${day}`,
      arrivalAt: `2026-08-${String(day).padStart(2, '0')}T13:00:00.000Z`,
      departureAt: `2026-08-${String(day).padStart(2, '0')}T20:00:00.000Z`,
      workedMinutes: 420
    }));
  }
  sessions.push(payrollSession({
    id: 'TEST-SUNDAY-NIGHT-EXTRA',
    arrivalAt: '2026-08-10T00:00:00.000Z',
    departureAt: '2026-08-10T02:00:00.000Z',
    workedMinutes: 120
  }));

  const result = calculate(sessions, {
    from: '2026-08-09',
    policy: historicalPolicy,
    compensation: new Map([['TEST-WORKER-1|2026-08-09', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]])
  });
  const row = result.rows[0];
  assert.equal(row.totalMinutes, 120);
  assert.equal(row.ordinaryMinutes, 0);
  assert.equal(row.overtimeMinutes, 120);
  assert.equal(row.conceptMinutes.HEND, 120);
  assert.equal(row.conceptMinutes.RND, 0);
});

test('festivo conserva RDF y RNF como indicativo y nunca abre compensatorio', () => {
  const sessions = [
    payrollSession({
      id: 'TEST-HOLIDAY-DAY',
      arrivalAt: '2026-08-17T13:00:00.000Z',
      departureAt: '2026-08-17T15:00:00.000Z',
      workedMinutes: 120
    }),
    payrollSession({
      id: 'TEST-HOLIDAY-NIGHT',
      arrivalAt: '2026-08-18T00:00:00.000Z',
      departureAt: '2026-08-18T02:00:00.000Z',
      workedMinutes: 120
    })
  ];
  const result = calculate(sessions, {
    from: '2026-08-17',
    compensation: new Map([['TEST-WORKER-1|2026-08-17', PAYROLL_COMPENSATION_STATUS.COMPENSATED]])
  });
  const row = result.rows[0];
  assert.equal(row.conceptMinutes.RDF, 120);
  assert.equal(row.conceptMinutes.RNF, 120);
  assert.equal('RDFC' in row.conceptMinutes, false);
  assert.equal('RNFC' in row.conceptMinutes, false);
  assert.equal(row.daily[0].isHoliday, true);
  assert.equal(row.daily[0].isRestDay, false);
  assert.equal(row.daily[0].compensationStatus, null);
  assert.ok(!row.novelties.some((item) => item.code === 'COMPENSATION_PENDING'));
  assert.equal(row.exportable, true);
});

test('el backend rechaza guardar compensatorio en una fecha festiva', async () => {
  let workerLookupCalled = false;
  let auditCreateCalled = false;
  const prisma = {
    dispatchWorker: {
      async findUnique() {
        workerLookupCalled = true;
        return { id: 'TEST-WORKER-1', fullName: 'Auxiliar de prueba' };
      }
    },
    devAuditEvent: {
      async create() {
        auditCreateCalled = true;
      }
    }
  };

  await assert.rejects(
    savePayrollCompensation(prisma, {
      workerId: 'TEST-WORKER-1',
      dateKey: '2026-08-17',
      status: PAYROLL_COMPENSATION_STATUS.COMPENSATED,
      actorUsername: 'TEST-ADMIN'
    }),
    /payroll_compensation_invalid/
  );
  assert.equal(workerLookupCalled, false);
  assert.equal(auditCreateCalled, false);
});

test('la interfaz usa calendario propio de lunes a domingo y muestra festivo sin formulario compensatorio', async () => {
  const template = await readFile('src/views/operacionesNomina.ejs', 'utf8');
  const emptyConcepts = Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, 0]));
  const html = ejs.render(template, {
    pageTitle: 'Nómina y tiempo trabajado',
    role: 'admin',
    report: {
      period: { periodType: 'WEEKLY', from: '2026-08-17', to: '2026-08-23', anchor: '2026-08-17' },
      filters: { clientId: '', operationPointId: '', workerId: '', search: '', includeTest: false },
      clients: [],
      workers: [],
      rows: [{
        workerId: 'TEST-WORKER-1',
        fullName: 'Auxiliar de prueba',
        documentType: 'CC',
        documentNumber: 'TEST-DOC-1',
        exportable: true,
        status: 'CALCULADO',
        totalHours: 2,
        ordinaryHours: 2,
        overtimeHours: 0,
        unrecognizedOvertimeHours: 0,
        conceptHours: { ...emptyConcepts, RDF: 2 },
        novelties: [],
        daily: [{
          dateKey: '2026-08-17',
          totalHours: 2,
          ordinaryHours: 2,
          overtimeHours: 0,
          unrecognizedOvertimeHours: 0,
          clientNames: ['Cliente de prueba'],
          operationNames: ['Operación de prueba'],
          isHoliday: true,
          isRestDay: false,
          compensationStatus: PAYROLL_COMPENSATION_STATUS.COMPENSATED
        }]
      }],
      totals: {
        workers: 1,
        totalMinutes: 120,
        ordinaryHours: 2,
        overtimeHours: 0,
        unrecognizedOvertimeMinutes: 0,
        workersWithNovelties: 0
      }
    },
    selectedPolicy: normalizePayrollPolicy({}),
    conceptCodes: PAYROLL_CONCEPT_CODES,
    formatPayrollMinutes,
    success: null,
    error: null
  });

  assert.match(html, /<span class="date-weekday">Lun<\/span><span class="date-weekday">Mar<\/span><span class="date-weekday">Mié<\/span><span class="date-weekday">Jue<\/span><span class="date-weekday">Vie<\/span><span class="date-weekday">Sáb<\/span><span class="date-weekday">Dom<\/span>/);
  assert.match(html, /name="anchor" type="hidden"/);
  assert.match(html, /name="from" type="hidden"/);
  assert.match(html, /name="to" type="hidden"/);
  assert.doesNotMatch(html, /type="date"/);
  assert.match(html, /mondayOffset = \(firstOfMonth\.getUTCDay\(\) \+ 6\) % 7/);
  assert.match(html, />Festivo<\/span>/);
  assert.doesNotMatch(html, /action="\/admin\/operaciones\/asistencia\/nomina\/compensation"/);
  assert.doesNotMatch(html, /RDFC|RNFC/);
});
