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

test('Resumen del día muestra solo cantidades de descansando e incapacitados, sin nombres', () => {
  const text = buildProgrammingSummaryText(reportWithRests());

  assert.match(text, /Solicitudes: 2/);
  assert.match(text, /Completas: 1/);
  assert.match(text, /Pendientes: 1/);
  assert.match(text, /Auxiliares requeridos: 3/);
  assert.match(text, /Asignados: 3/);
  assert.match(text, /Confirmados: 2/);
  assert.match(text, /Descansando: 2/);
  assert.match(text, /Incapacitados: 1/);
  assert.doesNotMatch(text, /Auxiliar Prueba Descanso/);
  assert.doesNotMatch(text, /Auxiliar Prueba Incapacidad/);
  assert.doesNotMatch(text, /Novedades de descanso/);
  assert.doesNotMatch(text, /Descansos\/incapacidades/);
});

test('Resumen del día omite Incapacitados cuando no hay ninguno', () => {
  const report = reportWithRests();
  report.workerAbsences = report.workerAbsences.filter((absence) => !String(absence.reason || '').startsWith('INCAPACIDAD_'));
  const text = buildProgrammingSummaryText(report);

  assert.match(text, /Descansando: 2/);
  assert.doesNotMatch(text, /Incapacitados:/);
  assert.doesNotMatch(text, /Auxiliar Prueba Descanso/);
});

test('Resumen del día conserva Descansando en cero cuando solo hay incapacidad', () => {
  const report = reportWithRests();
  report.workerAbsences = report.workerAbsences.filter((absence) => String(absence.reason || '').startsWith('INCAPACIDAD_'));
  const text = buildProgrammingSummaryText(report);

  assert.match(text, /Descansando: 0/);
  assert.match(text, /Incapacitados: 1/);
  assert.doesNotMatch(text, /Auxiliar Prueba Incapacidad/);
});

test('Resumen del día sin novedades muestra Descansando en cero y omite Incapacitados', () => {
  const report = reportWithRests();
  report.workerAbsences = [];
  const text = buildProgrammingSummaryText(report);

  assert.match(text, /Descansando: 0/);
  assert.doesNotMatch(text, /Incapacitados:/);
});

test('el envío de Resumen reutiliza loadProgrammingReportData y no crea una lectura paralela de descansos', async () => {
  const source = await readFile(new URL('../src/routes/dispatchWhatsappWebhook.js', import.meta.url), 'utf8');

  assert.match(source, /import \{ loadProgrammingReportData \} from '\.\.\/services\/dispatchProgrammingPdfService\.js'/);
  assert.match(source, /const report = await loadProgrammingReportData\(prisma, \{ selectedDate, includePending: true \}\)/);
  assert.match(source, /const text = buildProgrammingSummaryText\(report\)/);
  assert.match(source, /INCAPACIDAD_EPS/);
  assert.match(source, /INCAPACIDAD_ARL/);
  assert.doesNotMatch(source, /loadWorkerRestAssignments/);
});
