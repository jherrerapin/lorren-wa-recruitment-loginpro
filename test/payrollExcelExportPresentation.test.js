import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPayrollExcelWorkbook } from '../src/routes/dispatchPayroll.js';
import { PAYROLL_CONCEPT_CODES } from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function syntheticReport() {
  return {
    period: { from: '2026-08-01', to: '2026-08-15' },
    generatedAt: new Date('2026-08-15T12:00:00.000Z'),
    rows: [{
      documentNumber: 'TEST-DOC-001',
      documentType: 'CC',
      fullName: 'TEST Auxiliar Uno',
      workedDays: 10,
      deductedDays: 1,
      netWorkedDays: 9,
      restAssignments: [{ restDate: '2026-08-10', reason: 'REMUNERADO', originSundayDate: null }],
      ordinaryHours: 70,
      totalHours: 75.5,
      overtimeHours: 5.5,
      status: 'CON_NOVEDADES',
      novelties: [{ dateKey: '2026-08-11', blocking: true, message: 'TEST novedad seudonimizada' }],
      conceptHours: Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, code === 'HEDO' ? 1.25 : 0]))
    }]
  };
}

function headerColumn(sheet, header) {
  const headers = sheet.getRow(4).values.slice(1);
  const index = headers.indexOf(header);
  assert.notEqual(index, -1, `debe existir la columna ${header}`);
  return index + 1;
}

test('Nómina retira el botón CSV pero conserva la descarga Excel', async () => {
  const [view, route] = await Promise.all([
    readFile(new URL('../src/views/operacionesNomina.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/dispatchPayroll.js', import.meta.url), 'utf8')
  ]);

  assert.doesNotMatch(view, /\/export\.csv/);
  assert.match(view, /\/export\.xlsx/);
  assert.match(route, /router\.get\('\/export\.csv'/);
});

test('el Excel de Nómina conserva datos y aplica formato profesional', async () => {
  const workbook = buildPayrollExcelWorkbook(syntheticReport());
  const sheet = workbook.getWorksheet('Nómina');
  assert.ok(sheet);

  assert.equal(sheet.getCell('A1').value, 'Nómina y tiempo trabajado');
  assert.equal(sheet.getCell('A2').value, 'Corte 2026-08-01 a 2026-08-15 · 1 auxiliar(es)');
  assert.equal(sheet.getRow(4).height, 32);
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].xSplit, 3);
  assert.equal(sheet.views[0].ySplit, 4);
  assert.equal(sheet.views[0].showGridLines, false);
  assert.equal(sheet.autoFilter.from, 'A4');

  const documentoColumn = headerColumn(sheet, 'Documento');
  const nombreColumn = headerColumn(sheet, 'Nombre');
  const horasColumn = headerColumn(sheet, 'HorasOrdinarias');
  const novedadesColumn = headerColumn(sheet, 'Novedades');
  const estadoColumn = headerColumn(sheet, 'Estado');

  assert.equal(sheet.getCell(5, documentoColumn).value, 'TEST-DOC-001');
  assert.equal(sheet.getCell(5, nombreColumn).value, 'TEST Auxiliar Uno');
  assert.equal(sheet.getCell(5, horasColumn).value, 70);
  assert.equal(sheet.getColumn(nombreColumn).width, 30);
  assert.equal(sheet.getCell(4, documentoColumn).fill.fgColor.argb, 'FF0D7A6B');
  assert.equal(sheet.getCell(4, documentoColumn).font.color.argb, 'FFFFFFFF');
  assert.equal(sheet.getCell(5, horasColumn).numFmt, '0.0000');
  assert.equal(sheet.getCell(5, novedadesColumn).alignment.wrapText, true);
  assert.equal(sheet.getCell(5, estadoColumn).fill.fgColor.argb, 'FFFEF3C7');

  const buffer = await workbook.xlsx.writeBuffer();
  assert.ok(buffer.byteLength > 1000);
});
