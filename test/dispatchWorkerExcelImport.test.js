import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {
  DISPATCH_WORKER_EXCEL_COLUMNS,
  DispatchWorkerExcelValidationError,
  applyDispatchWorkerImportBatch,
  buildDispatchWorkerFullName,
  buildDispatchWorkerImportReview,
  buildDispatchWorkerImportTemplate,
  parseDispatchWorkerExcelWorksheet,
  prepareDispatchWorkerExcelRows
} from '../src/services/dispatchWorkerExcelImport.js';

const cities = [
  { id: 'branch-bogota', name: 'Bogotá' },
  { id: 'branch-cali', name: 'Cali' }
];

function workbookWithRows(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Auxiliares');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return workbook;
}

function minimalHeaders({ includeBranch = false, includeLegacyVacancy = false } = {}) {
  const headers = ['Nombres', 'Apellidos', 'Teléfono', 'Tipo de documento', 'Número de documento', 'Ciudad de residencia', 'Localidad / barrio', 'Tipo de contrato'];
  if (includeBranch) headers.push('Sucursales operativas');
  if (includeLegacyVacancy) headers.push('Vacantes / perfiles');
  return headers;
}

function minimalRow(overrides = {}, { includeBranch = false, includeLegacyVacancy = false } = {}) {
  const values = {
    firstNames: 'Ana María', lastNames: 'Pérez Gómez', phone: '3000000000', documentType: 'CC',
    documentNumber: '1000000000', residenceCity: 'Bogotá', residenceLocality: 'Suba', contractType: 'DIRECTO',
    branch: 'Bogotá', vacancy: 'Perfil histórico', ...overrides
  };
  const row = [values.firstNames, values.lastNames, values.phone, values.documentType, values.documentNumber, values.residenceCity, values.residenceLocality, values.contractType];
  if (includeBranch) row.push(values.branch);
  if (includeLegacyVacancy) row.push(values.vacancy);
  return row;
}

function existingWorker(overrides = {}) {
  return {
    id: 'worker-1', fullName: 'Ana María Pérez Gómez', phone: '3000000000', documentType: 'CC', documentNumber: '1000000000',
    residenceCity: 'Bogotá', residenceLocality: 'Suba', transportMode: 'Moto', contractType: 'DIRECTO',
    operationalStatus: 'INACTIVE', notes: 'Conservar', updatedAt: new Date('2026-07-25T03:00:00.000Z'),
    cities: [{ city: { id: 'branch-bogota', name: 'Bogotá' } }], ...overrides
  };
}

test('Nombre singular y Apellidos se unen como nombre completo', () => {
  const workbook = workbookWithRows(
    ['Nombre', 'Apellidos', 'Teléfono', 'Tipo de documento', 'Número de documento', 'Ciudad de residencia', 'Localidad / barrio', 'Tipo de contrato'],
    [['Juan Carlos', 'Pérez Gómez', '3000000000', 'CC', '123', 'Bogotá', 'Suba', 'DIRECTO']]
  );
  const prepared = prepareDispatchWorkerExcelRows(parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]), { cities });
  assert.equal(prepared[0].workerData.fullName, 'Juan Carlos Pérez Gómez');
});

test('las columnas separadas tienen prioridad sobre Nombre completo', () => {
  assert.equal(buildDispatchWorkerFullName({ fullName: 'Solo nombres', firstNames: 'Juan', lastNames: 'Pérez' }), 'Juan Pérez');
});

test('Nombre completo continúa funcionando cuando no hay columnas separadas', () => {
  assert.equal(buildDispatchWorkerFullName({ fullName: '  Ana   Pérez  ' }), 'Ana Pérez');
});

test('un auxiliar nuevo requiere al menos una sucursal operativa', async () => {
  const prisma = { dispatchWorker: { findMany: async () => [] } };
  const review = await buildDispatchWorkerImportReview({
    prisma,
    workbook: workbookWithRows(minimalHeaders(), [minimalRow()]),
    cities
  });
  assert.equal(review.items[0].type, 'CONFLICT');
  assert.equal(review.items[0].actionable, false);
  assert.match(review.items[0].reason, /Sucursal operativa/);
});

test('un auxiliar nuevo con sucursal queda pendiente de aprobación y no se crea durante análisis', async () => {
  let created = 0;
  const prisma = { dispatchWorker: { findMany: async () => [], create: async () => { created += 1; } } };
  const review = await buildDispatchWorkerImportReview({
    prisma,
    workbook: workbookWithRows(minimalHeaders({ includeBranch: true }), [minimalRow({}, { includeBranch: true })]),
    cities
  });
  assert.equal(review.items[0].type, 'NEW');
  assert.equal(review.items[0].actionable, true);
  assert.equal(review.items[0].incoming.cityIds[0], 'branch-bogota');
  assert.equal(created, 0);
});

test('auxiliar existente puede omitir sucursales y conservar su asignación', async () => {
  const prisma = { dispatchWorker: { findMany: async () => [existingWorker()] } };
  const review = await buildDispatchWorkerImportReview({
    prisma,
    workbook: workbookWithRows(minimalHeaders(), [minimalRow()]),
    cities
  });
  const item = review.items[0];
  assert.equal(item.incoming.relationsProvided.cities, false);
  assert.equal(item.incoming.cityIds.length, 0);
  assert.doesNotMatch(item.changes.map((change) => change.field).join(','), /cities/);
});

test('columna histórica Vacantes / perfiles se acepta pero se ignora como autoridad', async () => {
  const prisma = { dispatchWorker: { findMany: async () => [] } };
  const workbook = workbookWithRows(
    minimalHeaders({ includeBranch: true, includeLegacyVacancy: true }),
    [minimalRow({}, { includeBranch: true, includeLegacyVacancy: true })]
  );
  const review = await buildDispatchWorkerImportReview({ prisma, workbook, cities });
  const incoming = review.items[0].incoming;
  assert.equal(incoming.legacyVacanciesIgnored, true);
  assert.deepEqual(incoming.vacancyIds, []);
  assert.equal(incoming.relationsProvided.vacancies, false);
  assert.match(review.items[0].reason, /ignoró la columna histórica/);
});

test('aplica ramas seleccionadas sin escribir DispatchWorkerVacancy', async () => {
  let vacancyWrites = 0;
  let cityCreates = 0;
  let deletedBatch = false;
  const item = {
    id: 'row-2', type: 'NEW', actionable: true,
    incoming: {
      workerData: { fullName: 'Persona Ejemplo', phone: '3000000000', documentType: 'CC', documentNumber: '1000000001', residenceCity: 'Bogotá', residenceLocality: 'Suba', transportMode: null, contractType: 'DIRECTO', operationalStatus: 'CONTRATADO', notes: null },
      providedWorkerFields: ['fullName'], relationsProvided: { cities: true, vacancies: false }, cityIds: ['branch-bogota'], vacancyIds: []
    }
  };
  const tx = {
    dispatchWorkerImportBatch: {
      findFirst: async () => ({ id: 'batch-1', status: 'PENDING', expiresAt: new Date('2026-07-25T06:00:00.000Z'), items: [item] }),
      delete: async () => { deletedBatch = true; }
    },
    dispatchWorker: {
      findFirst: async () => null,
      create: async () => ({ id: 'worker-new' })
    },
    dispatchWorkerCity: {
      deleteMany: async () => null,
      createMany: async ({ data }) => { cityCreates += data.length; }
    },
    dispatchWorkerVacancy: {
      deleteMany: async () => { vacancyWrites += 1; },
      createMany: async () => { vacancyWrites += 1; }
    }
  };
  const result = await applyDispatchWorkerImportBatch({ prisma: { $transaction: async (callback) => callback(tx) }, batchId: 'batch-1', ownerKey: 'coord', selectedItemIds: ['row-2'], now: new Date('2026-07-25T04:00:00.000Z') });
  assert.equal(result.created, 1);
  assert.equal(cityCreates, 1);
  assert.equal(vacancyWrites, 0);
  assert.equal(deletedBatch, true);
});

test('un cambio concurrente se omite y no sobrescribe el auxiliar', async () => {
  let updateCalls = 0;
  const item = { id: 'row-2', type: 'UPDATE', actionable: true, workerId: 'worker-1', workerUpdatedAt: '2026-07-25T03:00:00.000Z', incoming: { workerData: {}, providedWorkerFields: [], relationsProvided: { cities: false, vacancies: false }, cityIds: [] } };
  const tx = {
    dispatchWorkerImportBatch: { findFirst: async () => ({ id: 'batch', expiresAt: new Date('2026-07-25T06:00:00.000Z'), items: [item] }), delete: async () => null },
    dispatchWorker: { updateMany: async () => { updateCalls += 1; return { count: 0 }; } },
    dispatchWorkerCity: { deleteMany: async () => null, createMany: async () => null }
  };
  const result = await applyDispatchWorkerImportBatch({ prisma: { $transaction: async (callback) => callback(tx) }, batchId: 'batch', ownerKey: 'coord', selectedItemIds: ['row-2'], now: new Date('2026-07-25T04:00:00.000Z') });
  assert.equal(result.conflicts, 1);
  assert.equal(updateCalls, 1);
});

test('la plantilla nueva contiene Sucursales operativas y no Vacantes / perfiles', () => {
  const workbook = buildDispatchWorkerImportTemplate({ cities });
  const sheet = workbook.getWorksheet('Auxiliares');
  const headers = sheet.getRow(1).values.map(String).join('|');
  assert.match(headers, /Nombres/);
  assert.match(headers, /Apellidos/);
  assert.match(headers, /Sucursales operativas/);
  assert.doesNotMatch(headers, /Vacantes \/ perfiles/);

  const catalog = workbook.getWorksheet('Catalogos');
  assert.equal(catalog.getCell('A1').value, 'Sucursales válidas');
  assert.equal(catalog.columnCount, 1);
});

test('la pantalla de importación explica autoridad por sucursal', () => {
  const view = fs.readFileSync('src/views/operacionesPersonalImportar.ejs', 'utf8');
  assert.match(view, /únicamente por Sucursal/);
  assert.match(view, /columna <strong>Vacantes \/ perfiles<\/strong>.*se ignora/s);
  assert.match(view, /Sucursal obligatoria para nuevos/);
  assert.doesNotMatch(view, /Vacantes \/ perfiles válidos/);
});

test('las rutas usan revisión y aprobación en vez de importación inmediata', () => {
  const route = fs.readFileSync('src/routes/dispatchOpsExtras.js', 'utf8');
  const view = fs.readFileSync('src/views/operacionesPersonalImportarRevision.ejs', 'utf8');
  assert.match(route, /buildDispatchWorkerImportReview/);
  assert.match(route, /dispatchWorkerImportBatch\.create/);
  assert.match(route, /importar-excel\/:batchId\/aplicar/);
  assert.doesNotMatch(route, /importDispatchWorkerExcelWorkbook/);
  assert.match(view, /Aplicar seleccionados/);
  assert.match(view, /Aplicar todos/);
});

test('rechaza documentos repetidos dentro del mismo archivo', () => {
  const workbook = workbookWithRows(minimalHeaders(), [minimalRow(), minimalRow({ firstNames: 'Otra', lastNames: 'Persona' })]);
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  assert.throws(() => prepareDispatchWorkerExcelRows(parsed, { cities }), DispatchWorkerExcelValidationError);
});

test('catálogo exportado ya no contiene columna de vacantes', () => {
  assert.equal(DISPATCH_WORKER_EXCEL_COLUMNS.some((column) => column.field === 'vacancies'), false);
  assert.equal(DISPATCH_WORKER_EXCEL_COLUMNS.some((column) => column.field === 'operationalCities'), true);
});