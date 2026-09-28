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

test('el Excel filtrado conserva marcaciones y conceptos calculados por día', () => {
  const report = {
    period: { from: '2026-09-28', to: '2026-09-28' },
    rows: [{
      fullName: 'Auxiliar Prueba',
      documentType: 'CC',
      documentNumber: '1.003.806.523',
      daily: [{
        dateKey: '2026-09-28',
        clientNames: ['Cliente Uno'],
        operationNames: ['Punto Norte'],
        totalHours: 8,
        ordinaryHours: 7,
        overtimeHours: 1,
        conceptHours: conceptHours({ HENO: 0.5, RNO: 1.5 }),
        markings: [{
          clientName: 'Cliente Uno',
          operationName: 'Punto Norte',
          arrivalLabel: '28 sept 2026, 7:00 a. m.',
          breakStartLabel: '28 sept 2026, 12:00 p. m.',
          breakEndLabel: '28 sept 2026, 1:00 p. m.',
          departureLabel: '28 sept 2026, 4:00 p. m.',
          corrections: []
        }]
      }]
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
  const headers = sheet.getRow(4).values;
  const data = sheet.getRow(5).values;
  const headerIndex = (text) => headers.findIndex((value) => String(value || '').startsWith(text));

  assert.equal(data[headerIndex('Fecha')], '2026-09-28');
  assert.equal(data[headerIndex('Documento')], '1.003.806.523');
  assert.match(String(data[headerIndex('Entrada')]), /7:00/);
  assert.equal(data[headerIndex('Horas extra total')], 1);
  assert.equal(data[headerIndex('HENO')], 0.5);
  assert.equal(data[headerIndex('RNO')], 1.5);
});
