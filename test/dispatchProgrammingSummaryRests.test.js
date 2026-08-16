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
        workerName: 'Auxiliar Prueba Descanso',
        reasonLabel: 'Descanso'
      },
      {
        workerId: 'TEST-WORKER-REST-B',
        workerName: 'Auxiliar Prueba Incapacidad',
        reasonLabel: 'Incapacidad EPS'
      }
    ]
  };
}

test('Resumen del día incluye conteo y detalle de descansos/incapacidades del dataset de Programación', () => {
  const text = buildProgrammingSummaryText(reportWithRests());

  assert.match(text, /Solicitudes: 2/);
  assert.match(text, /Completas: 1/);
  assert.match(text, /Pendientes: 1/);
  assert.match(text, /Auxiliares requeridos: 3/);
  assert.match(text, /Asignados: 3/);
  assert.match(text, /Confirmados: 2/);
  assert.match(text, /Descansos\/incapacidades: 2/);
  assert.match(text, /Auxiliar Prueba Descanso — Descanso/);
  assert.match(text, /Auxiliar Prueba Incapacidad — Incapacidad EPS/);
});

test('Resumen del día informa cero descansos sin inventar detalle', () => {
  const report = reportWithRests();
  report.workerAbsences = [];
  const text = buildProgrammingSummaryText(report);

  assert.match(text, /Descansos\/incapacidades: 0/);
  assert.doesNotMatch(text, /Auxiliar Prueba Descanso/);
  assert.doesNotMatch(text, /Auxiliar Prueba Incapacidad/);
});

test('el envío de Resumen reutiliza loadProgrammingReportData y no crea una lectura paralela de descansos', async () => {
  const source = await readFile(new URL('../src/routes/dispatchWhatsappWebhook.js', import.meta.url), 'utf8');

  assert.match(source, /import \{ loadProgrammingReportData \} from '\.\.\/services\/dispatchProgrammingPdfService\.js'/);
  assert.match(source, /const report = await loadProgrammingReportData\(prisma, \{ selectedDate, includePending: true \}\)/);
  assert.match(source, /const text = buildProgrammingSummaryText\(report\)/);
  assert.doesNotMatch(source, /loadWorkerRestAssignments/);
});
