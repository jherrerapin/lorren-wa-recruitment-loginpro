import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {
  DISPATCH_WORKER_EXCEL_COLUMNS,
  DispatchWorkerExcelValidationError,
  buildDispatchWorkerImportTemplate,
  importDispatchWorkerExcelWorkbook,
  parseDispatchWorkerExcelWorksheet,
  prepareDispatchWorkerExcelRows
} from '../src/services/dispatchWorkerExcelImport.js';

const cities = [
  { id: 'city-bogota', name: 'Bogotá' },
  { id: 'city-siberia', name: 'Siberia' }
];

const vacancies = [
  { id: 'vac-bogota', title: 'Auxiliar de cargue y descargue', city: 'Bogotá' },
  { id: 'vac-siberia', title: 'Auxiliar de cargue y descargue', city: 'Siberia' }
];

function workbookWithRows(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Auxiliares');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return workbook;
}

function completeHeaders() {
  return DISPATCH_WORKER_EXCEL_COLUMNS.map((column) => column.header);
}

function completeRow(overrides = {}) {
  const values = {
    fullName: 'Ana Pérez',
    phone: '3001234567',
    documentType: 'CC',
    documentNumber: '1020304050',
    residenceCity: 'Bogotá',
    residenceLocality: 'Suba',
    transportMode: 'TransMilenio',
    contractType: 'Directo',
    operationalStatus: 'Disponible',
    operationalCities: 'Bogotá; Siberia',
    vacancies: 'Auxiliar de cargue y descargue — Bogotá',
    notes: 'Disponible fines de semana',
    ...overrides
  };
  return DISPATCH_WORKER_EXCEL_COLUMNS.map((column) => values[column.field] ?? '');
}

test('reconoce encabezados por nombre y aliases aunque cambie el orden', () => {
  const workbook = workbookWithRows(
    ['Celular', 'Nombre', 'Cédula', 'Tipo documento', 'Ciudad', 'Barrio', 'Contrato', 'Estado', 'Ciudades', 'Perfiles', 'Transporte', 'Observaciones'],
    [['3001234567', 'Ana Pérez', '1020304050', 'CC', 'Bogotá', 'Suba', 'DIRECTO', 'CONTRATADO', 'Bogotá', 'Auxiliar de cargue y descargue — Bogotá', 'Moto', 'Prueba']]
  );

  const rows = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fullName, 'Ana Pérez');
  assert.equal(rows[0].documentNumber, '1020304050');
  assert.equal(rows[0].operationalCities, 'Bogotá');
});

test('exige los mismos campos obligatorios del formulario manual', () => {
  const workbook = workbookWithRows(['Nombre completo', 'Teléfono'], [['Ana Pérez', '3001234567']]);
  assert.throws(
    () => parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]),
    (error) => error instanceof DispatchWorkerExcelValidationError
      && error.message.includes('Tipo de documento')
      && error.message.includes('Vacantes / perfiles')
  );
});

test('normaliza contrato, estado, transporte y relaciones múltiples', () => {
  const workbook = workbookWithRows(completeHeaders(), [completeRow()]);
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  const prepared = prepareDispatchWorkerExcelRows(parsed, { cities, vacancies });

  assert.equal(prepared.length, 1);
  assert.deepEqual(prepared[0].cityIds, ['city-bogota', 'city-siberia']);
  assert.deepEqual(prepared[0].vacancyIds, ['vac-bogota']);
  assert.equal(prepared[0].workerData.contractType, 'DIRECTO');
  assert.equal(prepared[0].workerData.operationalStatus, 'CONTRATADO');
  assert.equal(prepared[0].workerData.transportMode, 'Publico');
  assert.equal(prepared[0].workerData.residenceCity, 'Bogotá');
});

test('rechaza filas incompletas y referencias inexistentes antes de guardar', () => {
  const workbook = workbookWithRows(completeHeaders(), [completeRow({ residenceCity: 'Ciudad inventada', phone: '' })]);
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  assert.throws(
    () => prepareDispatchWorkerExcelRows(parsed, { cities, vacancies }),
    (error) => error instanceof DispatchWorkerExcelValidationError
      && error.message.includes('Teléfono')
  );
});

test('rechaza documentos repetidos dentro del mismo archivo', () => {
  const workbook = workbookWithRows(completeHeaders(), [completeRow(), completeRow({ fullName: 'Otra persona' })]);
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  assert.throws(
    () => prepareDispatchWorkerExcelRows(parsed, { cities, vacancies }),
    /repetido dentro del archivo/
  );
});

test('la plantilla descargable contiene datos, instrucciones y catálogos', () => {
  const workbook = buildDispatchWorkerImportTemplate({ cities, vacancies });
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Auxiliares', 'Instrucciones', 'Catalogos']);
  assert.equal(workbook.getWorksheet('Auxiliares').getRow(1).cellCount, DISPATCH_WORKER_EXCEL_COLUMNS.length);
  assert.equal(workbook.getWorksheet('Catalogos').getCell('A2').value, 'Bogotá');
  assert.match(String(workbook.getWorksheet('Catalogos').getCell('B2').value), /Bogotá/);
});

test('la importación omite documentos activos y crea auxiliares completos con relaciones', async () => {
  const workbook = workbookWithRows(completeHeaders(), [
    completeRow({ documentNumber: '111', fullName: 'Auxiliar existente' }),
    completeRow({ documentNumber: '222', fullName: 'Auxiliar nuevo' })
  ]);
  const createdWorkers = [];
  const createdCities = [];
  const createdVacancies = [];
  const prisma = {
    $transaction: async (callback) => callback(prisma),
    dispatchWorker: {
      findFirst: async ({ where }) => {
        if (where.documentNumber === '111' && where.operationalStatus === 'CONTRATADO') return { id: 'existing' };
        return null;
      },
      create: async ({ data }) => {
        createdWorkers.push(data);
        return { id: 'new-worker' };
      },
      update: async () => null
    },
    dispatchWorkerCity: {
      deleteMany: async () => null,
      createMany: async ({ data }) => { createdCities.push(...data); }
    },
    dispatchWorkerVacancy: {
      deleteMany: async () => null,
      createMany: async ({ data }) => { createdVacancies.push(...data); }
    }
  };

  const result = await importDispatchWorkerExcelWorkbook({ prisma, workbook, cities, vacancies });
  assert.deepEqual(result, { created: 1, updated: 0, skipped: 1, total: 2 });
  assert.equal(createdWorkers[0].fullName, 'Auxiliar nuevo');
  assert.equal(createdWorkers[0].documentType, 'CC');
  assert.deepEqual(createdCities.map((row) => row.cityId), ['city-bogota', 'city-siberia']);
  assert.deepEqual(createdVacancies.map((row) => row.vacancyId), ['vac-bogota']);
});
