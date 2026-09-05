import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildProgrammingSummaryText } from '../src/routes/dispatchWhatsappWebhook.js';

function assignment(status, suffix) {
  return {
    id: `TEST-ASSIGNMENT-${suffix}`,
    status,
    worker: {
      id: `TEST-WORKER-${suffix}`,
      fullName: `Auxiliar Asignado ${suffix}`,
      isTestProfile: false
    }
  };
}

function reportWithRests() {
  return {
    selectedDate: '2026-08-15',
    summary: {
      totalRequests: 2,
      completedRequests: 1,
      requiredWorkers: 3,
      assignedWorkers: 3,
      isComplete: false
    },
    requests: [
      {
        id: 'TEST-REQUEST-A',
        requiredWorkers: 1,
        assignments: [assignment('CONFIRMED', 'A')]
      },
      {
        id: 'TEST-REQUEST-B',
        requiredWorkers: 2,
        assignments: [
          assignment('CONFIRMED', 'B'),
          assignment('CONFIRMATION_PENDING', 'C')
        ]
      }
    ],
    workerAbsences: [
      {
        workerId: 'TEST-WORKER-REST-A',
        workerName: 'Auxiliar Prueba Descanso A',
        reason: null,
        reasonLabel: 'Descanso'
      },
      {
        workerId: 'TEST-WORKER-REST-B',
        workerName: 'Auxiliar Prueba Descanso B',
        reason: 'NO_REMUNERADA',
        reasonLabel: 'Descanso no remunerado'
      },
      {
        workerId: 'TEST-WORKER-REST-C',
        workerName: 'Auxiliar Prueba Incapacidad',
        reason: 'INCAPACIDAD_EPS',
        reasonLabel: 'Incapacidad EPS'
      }
    ]
  };
}

test('Resumen del día unifica descansos comunes y separa compensatorios e incapacidades', () => {
  const report = reportWithRests();
  report.workerAbsences.push(
    {
      workerId: 'TEST-WORKER-REST-D',
      workerName: 'Auxiliar Prueba Descanso D',
      reason: 'NO_REMUNERADA',
      reasonLabel: 'Descanso no remunerado'
    },
    {
      workerId: 'TEST-WORKER-REST-E',
      workerName: 'Auxiliar Prueba Descanso E',
      reason: 'REMUNERADO',
      reasonLabel: 'Descanso remunerado'
    },
    {
      workerId: 'TEST-WORKER-REST-F',
      workerName: 'Auxiliar Prueba Compensatorio',
      reason: 'COMPENSATORIO',
      reasonLabel: 'COMPENSATORIO'
    }
  );
  const text = buildProgrammingSummaryText(report);

  assert.match(text, /Solicitudes: 2/);
  assert.match(text, /Completas: 1/);
  assert.match(text, /Pendientes: 1/);
  assert.match(text, /Auxiliares requeridos: 3/);
  assert.match(text, /Asignados: 3/);
  assert.match(text, /Confirmados: 2/);
  assert.match(text, /Descansando: 4\nCompensatorio: 1\nIncapacitados: 1/);
  assert.doesNotMatch(text, /Descanso no remunerado:/);
  assert.doesNotMatch(text, /Descanso remunerado:/);
  assert.doesNotMatch(text, /COMPENSATORIO:/);
  assert.doesNotMatch(text, /Auxiliar Prueba Descanso/);
  assert.doesNotMatch(text, /Auxiliar Prueba Incapacidad/);
  assert.doesNotMatch(text, /Novedades de descanso/);
  assert.doesNotMatch(text, /Descansos\/incapacidades/);
  assert.doesNotMatch(text, /\n- /);
});

test('Resumen del día agrupa sin motivo, remunerado y no remunerado bajo Descansando', () => {
  const report = reportWithRests();
  report.workerAbsences = report.workerAbsences.filter((absence) => !String(absence.reason || '').startsWith('INCAPACIDAD_'));
  report.workerAbsences.push({
    workerId: 'TEST-WORKER-REST-G',
    workerName: 'Auxiliar Prueba Descanso G',
    reason: 'REMUNERADO',
    reasonLabel: 'Descanso remunerado'
  });
  const text = buildProgrammingSummaryText(report);

  assert.match(text, /Descansando: 3/);
  assert.doesNotMatch(text, /Descanso no remunerado:/);
  assert.doesNotMatch(text, /Descanso remunerado:/);
  assert.doesNotMatch(text, /Incapacitados:/);
  assert.doesNotMatch(text, /Auxiliar Prueba Descanso/);
});

test('Resumen del día muestra Compensatorio sin mezclarlo con Descansando', () => {
  const report = reportWithRests();
  report.workerAbsences = [{
    workerId: 'TEST-WORKER-REST-H',
    workerName: 'Auxiliar Prueba Compensatorio H',
    reason: 'COMPENSATORIO',
    reasonLabel: 'COMPENSATORIO'
  }];
  const text = buildProgrammingSummaryText(report);

  assert.match(text, /Compensatorio: 1/);
  assert.doesNotMatch(text, /Descansando:/);
  assert.doesNotMatch(text, /COMPENSATORIO:/);
  assert.doesNotMatch(text, /Incapacitados:/);
});

test('Resumen del día conserva Vacaciones y muestra SUSPENSION como Suspendidos', () => {
  const report = reportWithRests();
  report.workerAbsences = [
    {
      workerId: 'TEST-WORKER-REST-I',
      workerName: 'Auxiliar Prueba Vacaciones I',
      reason: 'VACACIONES',
      reasonLabel: 'Vacaciones'
    },
    {
      workerId: 'TEST-WORKER-REST-J',
      workerName: 'Auxiliar Prueba Suspendido J',
      reason: 'SUSPENSION',
      reasonLabel: 'Suspensión'
    }
  ];
  const text = buildProgrammingSummaryText(report);

  assert.match(text, /Suspendidos: 1/);
  assert.match(text, /Vacaciones: 1/);
  assert.doesNotMatch(text, /Suspensión:/);
  assert.doesNotMatch(text, /Descansando:/);
  assert.doesNotMatch(text, /Compensatorio:/);
  assert.doesNotMatch(text, /Incapacitados:/);
});

test('Resumen del día no muestra Descansando cuando solo hay incapacidad', () => {
  const report = reportWithRests();
  report.workerAbsences = report.workerAbsences.filter((absence) => String(absence.reason || '').startsWith('INCAPACIDAD_'));
  const text = buildProgrammingSummaryText(report);

  assert.doesNotMatch(text, /Descansando:/);
  assert.match(text, /Incapacitados: 1/);
  assert.doesNotMatch(text, /Compensatorio:/);
  assert.doesNotMatch(text, /Auxiliar Prueba Incapacidad/);
});

test('Resumen del día sin novedades omite Descansando, Compensatorio e Incapacitados', () => {
  const report = reportWithRests();
  report.workerAbsences = [];
  const text = buildProgrammingSummaryText(report);

  assert.doesNotMatch(text, /Descansando:/);
  assert.doesNotMatch(text, /Compensatorio:/);
  assert.doesNotMatch(text, /Incapacitados:/);
  assert.doesNotMatch(text, /Descanso no remunerado:/);
  assert.doesNotMatch(text, /Descanso remunerado:/);
});

test('el envío de Resumen reutiliza loadProgrammingReportData y no crea una lectura paralela de descansos', async () => {
  const source = await readFile(new URL('../src/routes/dispatchWhatsappWebhook.js', import.meta.url), 'utf8');

  assert.match(source, /import \{ loadProgrammingReportData \} from '\.\.\/services\/dispatchProgrammingPdfService\.js'/);
  assert.match(source, /const report = await loadProgrammingReportData\(prisma, \{ selectedDate, includePending: true \}\)/);
  assert.match(source, /const text = buildProgrammingSummaryText\(report\)/);
  assert.match(source, /INCAPACIDAD_EPS/);
  assert.match(source, /INCAPACIDAD_ARL/);
  assert.match(source, /COMPENSATORIO/);
  assert.match(source, /SUSPENSION/);
  assert.match(source, /REMUNERADO/);
  assert.match(source, /NO_REMUNERADA/);
  assert.doesNotMatch(source, /loadWorkerRestAssignments/);
});
