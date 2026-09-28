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
    isHoliday: false,
    isRestDay: false,
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

function sampleWorker(overrides = {}) {
  return {
    fullName: 'Auxiliar Prueba',
    documentType: 'CC',
    documentNumber: '1.003.806.523',
    remuneratedDays: 2,
    unremuneratedDays: 1,
    paidPermissionDays: 1,
    incapacityDays: 0,
    dayShiftCount: 1,
    nightShiftCount: 1,
    sundayCount: 1,
    holidayCount: 0,
    totalHours: 16,
    ordinaryHours: 14,
    overtimeHours: 2,
    conceptHours: conceptHours({ HENO: 1, RNO: 3 }),
    restAssignments: [{ restDate: '2026-09-29', reason: 'REMUNERADO' }],
    daily: [sampleDaily('2026-09-28'), sampleDaily('2026-09-29', { isRestDay: true })],
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
      sampleWorker(),
      sampleWorker({
        fullName: 'Segundo Auxiliar',
        documentNumber: '8507957',
        remuneratedDays: 1,
        unremuneratedDays: 0,
        paidPermissionDays: 0,
        dayShiftCount: 1,
        nightShiftCount: 0,
        sundayCount: 0,
        totalHours: 8,
        ordinaryHours: 7,
        overtimeHours: 1,
        conceptHours: conceptHours({ HEDO: 1 }),
        restAssignments: [],
        daily: [sampleDaily('2026-09-28', { conceptHours: conceptHours({ HEDO: 1 }) })]
      })
    ]
  };
  const boardRows = [
    { workerName: 'Auxiliar Prueba', documentNumber: '1003806523', serviceDateIso: '2026-09-28', cityName: 'Bogotá' },
    { workerName: 'Auxiliar Prueba', documentNumber: '1003806523', serviceDateIso: '2026-09-29', cityName: 'Bogotá' },
    { workerName: 'Segundo Auxiliar', documentNumber: '8507957', serviceDateIso: '2026-09-28', cityName: 'Neiva' }
  ];

  const workbook = buildAttendanceFilteredWorkbook(report, boardRows);
  const sheet = workbook.getWorksheet('Detalle diario');
  const firstHeaders = sheet.getRow(5).values;
  const salidaIndex = firstHeaders.findIndex((value) => String(value || '') === 'Salida');

  assert.match(String(sheet.getCell('A4').value), /Auxiliar Prueba · CC 1\.003\.806\.523/);
  assert.equal(sheet.getCell('A5').value, 'Fecha');
  assert.equal(sheet.getCell('A6').value, '2026-09-28');
  assert.equal(sheet.getCell('A7').value, '2026-09-29');
  assert.equal(sheet.getRow(8).values[salidaIndex], 'TOTAL');
  assert.notEqual(sheet.getCell('A8').value, 'TOTAL');
  assert.equal(sheet.getRow(6).values.includes('Auxiliar Prueba'), false);
  assert.equal(sheet.getRow(7).values.includes('1.003.806.523'), false);

  assert.match(String(sheet.getCell('A10').value), /Segundo Auxiliar · CC 8507957/);
  assert.equal(sheet.getCell('A11').value, 'Fecha');
  assert.equal(sheet.getCell('A12').value, '2026-09-28');
  const secondHeaders = sheet.getRow(11).values;
  const secondSalidaIndex = secondHeaders.findIndex((value) => String(value || '') === 'Salida');
  assert.equal(sheet.getRow(13).values[secondSalidaIndex], 'TOTAL');
});

test('el Excel elimina estado, correcciones y descansos, y conserva columnas resumen de Gestión de Tiempo', () => {
  const report = { period: { from: '2026-09-28', to: '2026-09-29' }, rows: [sampleWorker()] };
  const boardRows = [
    { workerName: 'Auxiliar Prueba', documentNumber: '1003806523', serviceDateIso: '2026-09-28', cityName: 'Bogotá' },
    { workerName: 'Auxiliar Prueba', documentNumber: '1003806523', serviceDateIso: '2026-09-29', cityName: 'Bogotá' }
  ];

  const workbook = buildAttendanceFilteredWorkbook(report, boardRows);
  const sheet = workbook.getWorksheet('Detalle diario');
  const headers = sheet.getRow(5).values.map((value) => String(value || ''));

  assert.equal(headers.some((value) => value.includes('Estado asistencia')), false);
  assert.equal(headers.some((value) => value.includes('Correcciones')), false);
  assert.equal(headers.some((value) => value.includes('Descansos')), false);
  for (const expected of [
    'Días remunerados', 'Días no remunerados', 'Permisos remunerados', 'Incapacidades',
    'Turnos diurnos', 'Turnos nocturnos', 'Domingos', 'Festivos',
    'Total trabajado', 'Horas ordinarias', 'Horas extra total', 'HEDO', 'HENO', 'RNO', 'RNDC'
  ]) {
    assert.equal(headers.some((value) => value.startsWith(expected)), true, `falta columna ${expected}`);
  }
});

test('la fila de cierre de cada auxiliar usa acumulados canónicos y ubica TOTAL bajo Salida', () => {
  const report = { period: { from: '2026-09-28', to: '2026-09-29' }, rows: [sampleWorker()] };
  const boardRows = [
    { workerName: 'Auxiliar Prueba', documentNumber: '1003806523', serviceDateIso: '2026-09-28', cityName: 'Bogotá' },
    { workerName: 'Auxiliar Prueba', documentNumber: '1003806523', serviceDateIso: '2026-09-29', cityName: 'Bogotá' }
  ];

  const workbook = buildAttendanceFilteredWorkbook(report, boardRows);
  const sheet = workbook.getWorksheet('Detalle diario');
  const headers = sheet.getRow(5).values;
  const total = sheet.getRow(8).values;
  const headerIndex = (text) => headers.findIndex((value) => String(value || '').startsWith(text));

  assert.equal(total[headerIndex('Salida')], 'TOTAL');
  assert.equal(total[headerIndex('Días remunerados')], 2);
  assert.equal(total[headerIndex('Días no remunerados')], 1);
  assert.equal(total[headerIndex('Permisos remunerados')], 1);
  assert.equal(total[headerIndex('Turnos diurnos')], 1);
  assert.equal(total[headerIndex('Turnos nocturnos')], 1);
  assert.equal(total[headerIndex('Domingos')], 1);
  assert.equal(total[headerIndex('Total trabajado')], 16);
  assert.equal(total[headerIndex('Horas ordinarias')], 14);
  assert.equal(total[headerIndex('Horas extra total')], 2);
  assert.equal(total[headerIndex('HENO')], 1);
  assert.equal(total[headerIndex('RNO')], 3);
});

test('el bloque diario conserva marcaciones, horas extra y conceptos calculados', () => {
  const report = { period: { from: '2026-09-28', to: '2026-09-28' }, rows: [sampleWorker({ daily: [sampleDaily('2026-09-28')] })] };
  const boardRows = [{
    workerName: 'Auxiliar Prueba',
    documentNumber: '1003806523',
    serviceDateIso: '2026-09-28',
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
