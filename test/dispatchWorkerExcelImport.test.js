import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {
  DISPATCH_WORKER_EXCEL_COLUMNS,
  DispatchWorkerExcelValidationError,
  buildDispatchWorkerFullName,
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
    firstNames: 'Ana María',
    lastNames: 'Pérez Gómez',
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

function minimalHeaders() {
  return [
    'Nombres',
    'Apellidos',
    'Teléfono',
    'Tipo de documento',
    'Número de documento',
    'Ciudad de residencia',
    'Localidad / barrio',
    'Tipo de contrato'
  ];
}

function minimalRow(overrides = {}) {
  const values = {
    firstNames: 'Ana María',
    lastNames: 'Pérez Gómez',
    phone: '3001234567',
    documentType: 'CC',
    documentNumber: '1020304050',
    residenceCity: 'Bogotá',
    residenceLocality: 'Suba',
    contractType: 'DIRECTO',
    ...overrides
  };
  return [
    values.firstNames,
    values.lastNames,
    values.phone,
    values.documentType,
    values.documentNumber,
    values.residenceCity,
    values.residenceLocality,
    values.contractType
  ];
}

test('reconoce nombres y apellidos separados por encabezado aunque cambie el orden', () => {
  const workbook = workbookWithRows(
    ['Celular', 'Apellidos', 'Nombres', 'Cédula', 'Tipo documento', 'Ciudad', 'Barrio', 'Contrato'],
    [['3001234567', 'Pérez Gómez', 'Ana María', '1020304050', 'CC', 'Bogotá', 'Suba', 'DIRECTO']]
  );

  const rows = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firstNames, 'Ana María');
  assert.equal(rows[0].lastNames, 'Pérez Gómez');
  assert.equal(rows[0].documentNumber, '1020304050');
});

test('une nombres y apellidos limpiando espacios sobrantes', () => {
  assert.equal(
    buildDispatchWorkerFullName({ firstNames: '  Juan   Carlos ', lastNames: ' Pérez   Gómez  ' }),
    'Juan Carlos Pérez Gómez'
  );
});

test('mantiene compatibilidad con la columna anterior Nombre completo', () => {
  const workbook = workbookWithRows(
    ['Nombre completo', 'Teléfono', 'Tipo de documento', 'Número de documento', 'Ciudad de residencia', 'Localidad / barrio', 'Tipo de contrato'],
    [['  Ana   María Pérez Gómez  ', '3001234567', 'CC', '1020304050', 'Bogotá', 'Suba', 'DIRECTO']]
  );
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  const prepared = prepareDispatchWorkerExcelRows(parsed, { cities, vacancies });
  assert.equal(prepared[0].workerData.fullName, 'Ana María Pérez Gómez');
});

test('rechaza el archivo cuando no trae una modalidad de nombre compatible', () => {
  const workbook = workbookWithRows(
    ['Teléfono', 'Tipo de documento', 'Número de documento', 'Ciudad de residencia', 'Localidad / barrio', 'Tipo de contrato'],
    [['3001234567', 'CC', '1020304050', 'Bogotá', 'Suba', 'DIRECTO']]
  );
  assert.throws(
    () => parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]),
    (error) => error instanceof DispatchWorkerExcelValidationError
      && error.message.includes('Nombres + Apellidos')
  );
});

test('ciudades operativas, vacantes y estado pueden omitirse', () => {
  const workbook = workbookWithRows(minimalHeaders(), [minimalRow()]);
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  const prepared = prepareDispatchWorkerExcelRows(parsed, { cities, vacancies });

  assert.equal(prepared[0].workerData.fullName, 'Ana María Pérez Gómez');
  assert.equal(prepared[0].workerData.operationalStatus, 'CONTRATADO');
  assert.deepEqual(prepared[0].cityIds, []);
  assert.deepEqual(prepared[0].vacancyIds, []);
});

test('un estado informado pero inválido continúa rechazándose', () => {
  const workbook = workbookWithRows(completeHeaders(), [completeRow({ operationalStatus: 'PENDIENTE' })]);
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  assert.throws(
    () => prepareDispatchWorkerExcelRows(parsed, { cities, vacancies }),
    /Estado operativo debe ser CONTRATADO o INACTIVE/
  );
});

test('normaliza contrato, estado, transporte y relaciones múltiples cuando se informan', () => {
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

test('rechaza filas con un nombre sin su apellido', () => {
  const workbook = workbookWithRows(minimalHeaders(), [minimalRow({ lastNames: '' })]);
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  assert.throws(
    () => prepareDispatchWorkerExcelRows(parsed, { cities, vacancies }),
    /Nombres y Apellidos/
  );
});

test('rechaza documentos repetidos dentro del mismo archivo', () => {
  const workbook = workbookWithRows(minimalHeaders(), [minimalRow(), minimalRow({ firstNames: 'Otra', lastNames: 'Persona' })]);
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  assert.throws(
    () => prepareDispatchWorkerExcelRows(parsed, { cities, vacancies }),
    /repetido dentro del archivo/
  );
});

test('la plantilla usa Nombres y Apellidos y deja el estado opcional', () => {
  const workbook = buildDispatchWorkerImportTemplate({ cities, vacancies });
  const sheet = workbook.getWorksheet('Auxiliares');
  const statusColumn = DISPATCH_WORKER_EXCEL_COLUMNS.findIndex((column) => column.field === 'operationalStatus') + 1;

  assert.deepEqual(workbook.worksheets.map((item) => item.name), ['Auxiliares', 'Instrucciones', 'Catalogos']);
  assert.equal(sheet.getCell('A1').value, 'Nombres');
  assert.equal(sheet.getCell('B1').value, 'Apellidos');
  assert.equal(sheet.getRow(2).getCell(statusColumn).dataValidation.allowBlank, true);
  assert.equal(workbook.getWorksheet('Catalogos').getCell('A2').value, 'Bogotá');
});

test('la importación crea un auxiliar contratado sin relaciones opcionales', async () => {
  const workbook = workbookWithRows(minimalHeaders(), [minimalRow({ documentNumber: '222' })]);
  const createdWorkers = [];
  let cityRelationsCreated = 0;
  let vacancyRelationsCreated = 0;
  const prisma = {
    $transaction: async (callback) => callback(prisma),
    dispatchWorker: {
      findFirst: async () => null,
      create: async ({ data }) => {
        createdWorkers.push(data);
        return { id: 'new-worker' };
      },
      update: async () => null
    },
    dispatchWorkerCity: {
      deleteMany: async () => null,
      createMany: async ({ data }) => { cityRelationsCreated += data.length; }
    },
    dispatchWorkerVacancy: {
      deleteMany: async () => null,
      createMany: async ({ data }) => { vacancyRelationsCreated += data.length; }
    }
  };

  const result = await importDispatchWorkerExcelWorkbook({ prisma, workbook, cities, vacancies });
  assert.deepEqual(result, { created: 1, updated: 0, skipped: 0, total: 1 });
  assert.equal(createdWorkers[0].fullName, 'Ana María Pérez Gómez');
  assert.equal(createdWorkers[0].operationalStatus, 'CONTRATADO');
  assert.equal(cityRelationsCreated, 0);
  assert.equal(vacancyRelationsCreated, 0);
});

test('la ruta restringe el archivo y evita registrar el error completo con datos de filas', () => {
  const route = fs.readFileSync('src/routes/dispatchOpsExtras.js', 'utf8');
  assert.match(route, /MAX_EXCEL_SIZE_BYTES = 5 \* 1024 \* 1024/);
  assert.match(route, /originalName\.endsWith\('\.xlsx'\)/);
  assert.match(route, /errorCount: Array\.isArray\(error\?\.errors\)/);
  assert.doesNotMatch(route, /console\.error\('\[Dispatch worker Excel import\]', error\)/);
});
