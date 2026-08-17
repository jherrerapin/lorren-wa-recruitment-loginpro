import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  applyPayrollWorkerSelection,
  buildPayrollExcelWorkbook,
  normalizePayrollExcelColumns
} from '../src/routes/dispatchPayroll.js';
import { PAYROLL_CONCEPT_CODES } from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function syntheticRow(overrides = {}) {
  return {
    workerId: 'TEST-WORKER-001',
    documentNumber: 'TEST-DOC-001',
    documentType: 'CC',
    fullName: 'TEST Auxiliar Uno',
    workedDays: 10,
    deductedDays: 1,
    netWorkedDays: 9,
    remuneratedDays: 10,
    unremuneratedDays: 1,
    paidPermissionDays: 1,
    incapacityDays: 0,
    nightShiftCount: 2,
    sundayCount: 1,
    holidayCount: 0,
    restAssignments: [{ restDate: '2026-08-10', reason: 'REMUNERADO', originSundayDate: null }],
    ordinaryHours: 70,
    totalHours: 75.5,
    overtimeHours: 5.5,
    totalMinutes: 4530,
    ordinaryMinutes: 4200,
    overtimeMinutes: 330,
    unrecognizedOvertimeMinutes: 0,
    status: 'CON_NOVEDADES',
    exportable: false,
    novelties: [{ dateKey: '2026-08-11', blocking: true, message: 'TEST novedad seudonimizada' }],
    conceptMinutes: Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, code === 'HEDO' ? 72 : 0])),
    conceptHours: Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, code === 'HEDO' ? 1.2 : 0])),
    ...overrides
  };
}

function syntheticReport(rows = [syntheticRow()]) {
  return {
    period: { from: '2026-08-01', to: '2026-08-15' },
    overtimePeriod: { from: '2026-08-10', to: '2026-08-16' },
    generatedAt: new Date('2026-08-15T12:00:00.000Z'),
    rows
  };
}

function headerColumn(sheet, header) {
  const headers = sheet.getRow(4).values.slice(1);
  const index = headers.indexOf(header);
  assert.notEqual(index, -1, `debe existir la columna ${header}`);
  return index + 1;
}

test('Nómina conserva un solo acceso Excel y la ruta abre el personalizador', async () => {
  const [view, exportView, route] = await Promise.all([
    readFile(new URL('../src/views/operacionesNomina.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/operacionesNominaExport.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/dispatchPayroll.js', import.meta.url), 'utf8')
  ]);

  assert.doesNotMatch(view, /\/export\.csv/);
  assert.match(view, /\/export\.xlsx/);
  assert.match(route, /router\.get\('\/export\.csv'/);
  assert.match(route, /renderPayrollExcelCustomizer/);
  assert.match(exportView, /name="exportWorkerId"/);
  assert.match(exportView, /name="columns"/);
  assert.match(exportView, /name="download" value="1"/);
  assert.doesNotMatch(exportView, /\b(?:alert|confirm|prompt)\s*\(/);
});

test('el Excel de Nómina conserva datos y aplica formato profesional sin exponer Estado ni Novedades', async () => {
  const workbook = buildPayrollExcelWorkbook(syntheticReport());
  const sheet = workbook.getWorksheet('Nómina');
  assert.ok(sheet);

  assert.equal(sheet.getCell('A1').value, 'Nómina y tiempo trabajado');
  assert.equal(sheet.getCell('A2').value, 'Corte 2026-08-01 a 2026-08-15 · Extras 2026-08-10 a 2026-08-16 · 1 auxiliar(es)');
  assert.equal(sheet.getRow(4).height, 32);
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].xSplit, 3);
  assert.equal(sheet.views[0].ySplit, 4);
  assert.equal(sheet.views[0].showGridLines, false);
  assert.match(JSON.stringify(sheet.autoFilter), /A4/);

  const headers = sheet.getRow(4).values.slice(1);
  assert.equal(headers.includes('Novedades'), false);
  assert.equal(headers.includes('Estado'), false);

  const documentoColumn = headerColumn(sheet, 'Documento');
  const nombreColumn = headerColumn(sheet, 'Nombre');
  const horasColumn = headerColumn(sheet, 'HorasOrdinarias');
  const hedoColumn = headerColumn(sheet, 'HEDO');

  assert.equal(sheet.getCell(5, documentoColumn).value, 'TEST-DOC-001');
  assert.equal(sheet.getCell(5, nombreColumn).value, 'TEST Auxiliar Uno');
  assert.equal(sheet.getCell(5, horasColumn).value, 70);
  assert.equal(sheet.getCell(5, hedoColumn).value, 1.2);
  assert.equal(sheet.getColumn(nombreColumn).width, 30);
  assert.equal(sheet.getCell(4, documentoColumn).fill.fgColor.argb, 'FF0D7A6B');
  assert.equal(sheet.getCell(4, documentoColumn).font.color.argb, 'FFFFFFFF');
  assert.equal(sheet.getCell(5, horasColumn).numFmt, '0.0');

  const buffer = await workbook.xlsx.writeBuffer();
  assert.ok(buffer.byteLength > 1000);
});

test('el Excel personalizado incluye únicamente columnas permitidas y conserva el orden canónico', () => {
  assert.deepEqual(
    normalizePayrollExcelColumns(['HEDO', 'Nombre', 'Documento', 'Estado', 'Novedades', 'columna_inyectada']),
    ['Documento', 'Nombre', 'HEDO']
  );

  const workbook = buildPayrollExcelWorkbook(syntheticReport(), {
    columns: ['HEDO', 'Nombre', 'Documento', 'Estado', 'columna_inyectada']
  });
  const sheet = workbook.getWorksheet('Nómina');
  assert.deepEqual(sheet.getRow(4).values.slice(1), ['Documento', 'Nombre', 'HEDO']);
  assert.equal(sheet.getCell('A5').value, 'TEST-DOC-001');
  assert.equal(sheet.getCell('B5').value, 'TEST Auxiliar Uno');
  assert.equal(sheet.getCell('C5').value, 1.2);
  assert.equal(sheet.views[0].xSplit, 2);
});

test('la selección de datos permite descargar solo los auxiliares elegidos dentro del reporte', () => {
  const report = syntheticReport([
    syntheticRow(),
    syntheticRow({
      workerId: 'TEST-WORKER-002',
      documentNumber: 'TEST-DOC-002',
      fullName: 'TEST Auxiliar Dos',
      novelties: [],
      status: 'CALCULADO',
      exportable: true
    })
  ]);

  const selectedReport = applyPayrollWorkerSelection(report, ['TEST-WORKER-002', 'TEST-WORKER-INEXISTENTE']);
  assert.equal(selectedReport.rows.length, 1);
  assert.equal(selectedReport.rows[0].workerId, 'TEST-WORKER-002');

  const workbook = buildPayrollExcelWorkbook(selectedReport, { columns: ['Nombre', 'TotalTrabajado'] });
  const sheet = workbook.getWorksheet('Nómina');
  assert.deepEqual(sheet.getRow(4).values.slice(1), ['Nombre', 'TotalTrabajado']);
  assert.equal(sheet.getCell('A5').value, 'TEST Auxiliar Dos');
  assert.equal(sheet.getCell('B5').value, 75.5);
  assert.equal(sheet.getCell('A6').value, null);
});
