import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  analyzePayrollAttendanceImport,
  buildPayrollAttendanceImportPreview,
  parsePayrollAttendanceImportFile
} from '../src/modules/dispatch-payroll/application/payrollAttendanceImport.js';

function csvFile(text) {
  return { originalname: 'marcaciones.csv', mimetype: 'text/csv', buffer: Buffer.from(text, 'utf8') };
}

test('reconoce encabezados claros de una fila por jornada sin pedir campos de eventos', async () => {
  const file = csvFile([
    'Nombre;Identificador;Fecha;Entrada jornada;Salida almuerzo;Regreso almuerzo;Salida jornada',
    'Auxiliar Prueba;TEST-2001;20/01/2027;07:00;10:00;11:00;15:00'
  ].join('\n'));

  const parsed = await parsePayrollAttendanceImportFile(file);

  assert.equal(parsed.needsMapping, false);
  assert.equal(parsed.mappingMode, 'DAILY');
  assert.deepEqual(parsed.mappingFields, [
    'document', 'name', 'date', 'arrival', 'breakStart', 'breakEnd', 'departure'
  ]);
  assert.deepEqual(parsed.columns, {
    document: 1,
    name: 0,
    date: 2,
    arrival: 3,
    breakStart: 4,
    breakEnd: 5,
    departure: 6
  });
  assert.deepEqual(parsed.workdays[0].marks.map((mark) => [mark.markType, mark.localDateTime]), [
    ['ARRIVAL', '2027-01-20T07:00:00'],
    ['BREAK_START', '2027-01-20T10:00:00'],
    ['BREAK_END', '2027-01-20T11:00:00'],
    ['DEPARTURE', '2027-01-20T15:00:00']
  ]);
});

test('si las marcas no se reconocen, el mapeo diario usa posiciones y distingue encabezados repetidos', async () => {
  const file = csvFile([
    'Nombre;Identificador;Fecha;Golpe;Golpe;Golpe;Golpe',
    'Auxiliar Prueba;TEST-2001;20/01/2027;07:00;10:00;11:00;15:00'
  ].join('\n'));

  const firstPass = await parsePayrollAttendanceImportFile(file);
  assert.equal(firstPass.needsMapping, true);
  assert.equal(firstPass.mappingMode, 'DAILY');
  assert.deepEqual(firstPass.mappingFields, [
    'document', 'name', 'date', 'arrival', 'breakStart', 'breakEnd', 'departure'
  ]);
  assert.doesNotMatch(firstPass.message, /fecha y hora|tipo de evento/i);

  const preview = buildPayrollAttendanceImportPreview(await analyzePayrollAttendanceImport({}, firstPass));
  assert.equal(preview.mappingMode, 'DAILY');
  assert.deepEqual(preview.mappingFields, firstPass.mappingFields);

  const remapped = await parsePayrollAttendanceImportFile(file, {
    mapping: {
      name: '@column:0',
      document: '@column:1',
      date: '@column:2',
      arrival: '@column:3',
      breakStart: '@column:4',
      breakEnd: '@column:5',
      departure: '@column:6'
    }
  });

  assert.equal(remapped.needsMapping, false);
  assert.equal(remapped.columns.arrival, 3);
  assert.equal(remapped.columns.breakStart, 4);
  assert.equal(remapped.columns.breakEnd, 5);
  assert.equal(remapped.columns.departure, 6);
  assert.deepEqual(remapped.workdays[0].marks.map((mark) => mark.markType), [
    'ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'
  ]);
});

test('la interfaz usa los campos del modo detectado y conserva la posición real de cada columna', async () => {
  const view = await readFile(new URL('../src/views/operacionesNomina.ejs', import.meta.url), 'utf8');

  assert.match(view, /const mappingLabels=/);
  assert.match(view, /Array\.isArray\(data\.mappingFields\)/);
  assert.match(view, /option\.value=`@column:\$\{index\}`/);
  assert.match(view, /Entrada de jornada/);
  assert.match(view, /Salida a almuerzo/);
  assert.match(view, /Regreso de almuerzo/);
  assert.match(view, /Salida de jornada/);
  assert.doesNotMatch(view, /const mappingFields=\[/);
});
