import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAttendanceFilteredWorkbook } from '../src/routes/attendanceFilteredExport.js';

const multiselect = fs.readFileSync(new URL('../src/public/lorren-searchable-multiselect.js', import.meta.url), 'utf8');
const scrollSync = fs.readFileSync(new URL('../src/public/payroll-table-scroll-sync.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../src/routes/dispatchBridge.js', import.meta.url), 'utf8');

function conceptHours(values = {}) {
  return {
    HEDO: 0, HENO: 0, HEDD: 0, HEND: 0, HEDF: 0, HENF: 0,
    RNO: 0, RDD: 0, RND: 0, RDF: 0, RNF: 0, RDDC: 0, RNDC: 0,
    ...values
  };
}

function sampleDaily(dateKey, overrides = {}) {
  return {
    dateKey,
    clientNames: ['Cliente Uno'],
    operationNames: ['Punto Norte'],
    totalHours: 8,
    ordinaryHours: 7,
    overtimeHours: 1,
    conceptHours: conceptHours({ HENO: 0.5, RNO: 1.5 }),
    markings: [{
      clientName: 'Cliente Uno',
      operationName: 'Punto Norte',
      arrivalLabel: `${dateKey} 7:00 a. m.`,
      breakStartLabel: `${dateKey} 12:00 p. m.`,
      breakEndLabel: `${dateKey} 1:00 p. m.`,
      departureLabel: `${dateKey} 4:00 p. m.`,
      corrections: []
    }],
    ...overrides
  };
}

test('Gestión de Tiempo instala una barra horizontal superior sincronizada sin reemplazar la inferior', () => {
  assert.match(multiselect, /PAYROLL_SCROLL_SCRIPT = '\/public\/payroll-table-scroll-sync\.js'/);
  assert.match(multiselect, /ensurePayrollScrollScript\(\)/);
  assert.match(scrollSync, /\.payroll-results-panel \.table-wrap/);
  assert.match(scrollSync, /tableWrap\.parentNode\.insertBefore\(top, tableWrap\)/);
  assert.match(scrollSync, /top\.addEventListener\('scroll'/);
  assert.match(scrollSync, /tableWrap\.addEventListener\('scroll'/);
  assert.match(scrollSync, /ResizeObserver/);
});

test('Asistencia expone descarga del detalle filtrado y conserva la selección múltiple', () => {
  assert.match(multiselect, /Descargar detalle filtrado/);
  assert.match(multiselect, /export-filtrado\.xlsx/);
  assert.match(multiselect, /hidden\.name = 'workerKey'/);
  assert.match(multiselect, /options\.filter\(\(option\) => option\.checked\)/);
  assert.match(bridge, /attendanceFilteredExportRouter/);
  assert.match(bridge, /attendanceFilteredExportRouter\(prisma\)/);
});

test('Asistencia restaura los auxiliares seleccionados después de aplicar filtros del formulario', () => {
  assert.match(multiselect, /function attendanceRequestedWorkerKeys\(\)/);
  assert.match(multiselect, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(multiselect, /params\.getAll\('workerKey'\)/);
  assert.match(multiselect, /option\.checked = requestedWorkerKeys\.has\(fold\(option\.value\)\)/);
  assert.match(multiselect, /hidden\.dataset\.attendanceWorkerFilter = 'true'/);
  assert.match(multiselect, /applySelection\(\);/);
});

test('el Excel filtrado agrupa por auxiliar y no repite identidad en cada día', () => {
  const report = {
    period: { from: '2026-09-28', to: '2026-09-29' },
    rows: [
      {
        fullName: 'Auxiliar Prueba',
        documentType: 'CC',
        documentNumber: '1.003.806.523',
        daily: [sampleDaily('2026-09-28'), sampleDaily('2026-09-29')]
      },
      {
        fullName: 'Segundo Auxiliar',
        documentType: 'CC',
        documentNumber: '8507957',
        daily: [sampleDaily('2026-09-28', { conceptHours: conceptHours({ HEDO: 1 }) })]
      }
    ]
  };
  const boardRows = [
    { workerName: 'Auxiliar Prueba', documentNumber: '1003806523', serviceDateIso: '2026-09-28', statusLabel: 'Marcación validada', cityName: 'Bogotá' },
    { workerName: 'Auxiliar Prueba', documentNumber: '1003806523', serviceDateIso: '2026-09-29', statusLabel: 'Marcación validada', cityName: 'Bogotá' },
    { workerName: 'Segundo Auxiliar', documentNumber: '8507957', serviceDateIso: '2026-09-28', statusLabel: 'Marcación validada', cityName: 'Neiva' }
  ];

  const workbook = buildAttendanceFilteredWorkbook(report, boardRows);
  const sheet = workbook.getWorksheet('Detalle diario');

  assert.match(String(sheet.getCell('A4').value), /Auxiliar Prueba · CC 1\.003\.806\.523/);
  assert.equal(sheet.getCell('A5').value, 'Fecha');
  assert.equal(sheet.getCell('A6').value, '2026-09-28');
  assert.equal(sheet.getCell('A7').value, '2026-09-29');
  assert.equal(sheet.getRow(6).values.includes('Auxiliar Prueba'), false);
  assert.equal(sheet.getRow(7).values.includes('1.003.806.523'), false);

  assert.match(String(sheet.getCell('A9').value), /Segundo Auxiliar · CC 8507957/);
  assert.equal(sheet.getCell('A10').value, 'Fecha');
  assert.equal(sheet.getCell('A11').value, '2026-09-28');
});

test('el bloque diario conserva marcaciones, horas extra y conceptos calculados', () => {
  const report = {
    period: { from: '2026-09-28', to: '2026-09-28' },
    rows: [{
      fullName: 'Auxiliar Prueba',
      documentType: 'CC',
      documentNumber: '1.003.806.523',
      daily: [sampleDaily('2026-09-28')]
    }]
  };
  const boardRows = [{
    workerName: 'Auxiliar Prueba',
    documentNumber: '1003806523',
    serviceDateIso: '2026-09-28',
    statusLabel: 'Marcación validada',
    cityName: 'Bogotá'
  }];

  const workbook = buildAttendanceFilteredWorkbook(report, boardRows);
  const sheet = workbook.getWorksheet('Detalle diario');
  const headers = sheet.getRow(5).values;
  const data = sheet.getRow(6).values;
  const headerIndex = (text) => headers.findIndex((value) => String(value || '').startsWith(text));

  assert.equal(data[headerIndex('Fecha')], '2026-09-28');
  assert.match(String(data[headerIndex('Entrada')]), /7:00/);
  assert.equal(data[headerIndex('Horas extra total')], 1);
  assert.equal(data[headerIndex('HENO')], 0.5);
  assert.equal(data[headerIndex('RNO')], 1.5);
});
