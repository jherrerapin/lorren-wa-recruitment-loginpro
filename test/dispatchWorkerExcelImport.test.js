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
  { id: 'city-bogota', name: 'Bogotá' },
  { id: 'city-siberia', name: 'Siberia' }
];
const vacancies = [
  { id: 'vac-bogota', title: 'Auxiliar de cargue y descargue', city: 'Bogotá' }
];

function workbookWithRows(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Auxiliares');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return workbook;
}

function minimalHeaders() {
  return ['Nombres', 'Apellidos', 'Teléfono', 'Tipo de documento', 'Número de documento', 'Ciudad de residencia', 'Localidad / barrio', 'Tipo de contrato'];
}

function minimalRow(overrides = {}) {
  const values = {
    firstNames: 'Ana María', lastNames: 'Pérez Gómez', phone: '3001234567', documentType: 'CC',
    documentNumber: '1020304050', residenceCity: 'Bogotá', residenceLocality: 'Suba', contractType: 'DIRECTO',
    ...overrides
  };
  return [values.firstNames, values.lastNames, values.phone, values.documentType, values.documentNumber, values.residenceCity, values.residenceLocality, values.contractType];
}

function existingWorker(overrides = {}) {
  return {
    id: 'worker-1', fullName: 'Ana María', phone: '3001234567', documentType: 'CC', documentNumber: '1020304050',
    residenceCity: 'Bogotá', residenceLocality: 'Suba', transportMode: 'Moto', contractType: 'DIRECTO',
    operationalStatus: 'INACTIVE', notes: 'Conservar', updatedAt: new Date('2026-07-25T03:00:00.000Z'),
    cities: [{ city: { id: 'city-bogota', name: 'Bogotá' } }], vacancies: [], ...overrides
  };
}

test('Nombre singular y Apellidos se unen como nombre completo', () => {
  const workbook = workbookWithRows(
    ['Nombre', 'Apellidos', 'Teléfono', 'Tipo de documento', 'Número de documento', 'Ciudad de residencia', 'Localidad / barrio', 'Tipo de contrato'],
    [['Juan Carlos', 'Pérez Gómez', '3001234567', 'CC', '123', 'Bogotá', 'Suba', 'DIRECTO']]
  );
  const prepared = prepareDispatchWorkerExcelRows(parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]), { cities, vacancies });
  assert.equal(prepared[0].workerData.fullName, 'Juan Carlos Pérez Gómez');
});

test('las columnas separadas tienen prioridad sobre Nombre completo', () => {
  assert.equal(buildDispatchWorkerFullName({ fullName: 'Solo nombres', firstNames: 'Juan', lastNames: 'Pérez' }), 'Juan Pérez');
});

test('Nombre completo continúa funcionando cuando no hay columnas separadas', () => {
  assert.equal(buildDispatchWorkerFullName({ fullName: '  Ana   Pérez  ' }), 'Ana Pérez');
});

test('la revisión clasifica un auxiliar activo con apellido nuevo como UPDATE', async () => {
  const workbook = workbookWithRows(minimalHeaders(), [minimalRow()]);
  const prisma = { dispatchWorker: { findMany: async () => [existingWorker()] } };
  const review = await buildDispatchWorkerImportReview({ prisma, workbook, cities, vacancies });
  assert.equal(review.summary.updateCount, 1);
  assert.equal(review.items[0].type, 'UPDATE');
  assert.equal(review.items[0].changes.find((change) => change.field === 'fullName').incomingValue, 'Ana María Pérez Gómez');
});

test('campos opcionales vacíos conservan valores existentes y no aparecen como cambios', async () => {
  const workbook = workbookWithRows(minimalHeaders(), [minimalRow({ lastNames: '' })]);
  assert.throws(() => parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]) && prepareDispatchWorkerExcelRows(parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]), { cities, vacancies }), /Nombres y Apellidos/);

  const validWorkbook = workbookWithRows(minimalHeaders(), [minimalRow()]);
  const current = existingWorker({ fullName: 'Ana María Pérez Gómez' });
  const prisma = { dispatchWorker: { findMany: async () => [current] } };
  const review = await buildDispatchWorkerImportReview({ prisma, workbook: validWorkbook, cities, vacancies });
  const changedFields = review.items[0].changes.map((change) => change.field);
  assert.doesNotMatch(changedFields.join(','), /transportMode|operationalStatus|notes|cities|vacancies/);
  assert.equal(review.items[0].type, 'UNCHANGED');
});

test('un auxiliar nuevo queda pendiente de aprobación y no se crea durante el análisis', async () => {
  let created = 0;
  const prisma = {
    dispatchWorker: {
      findMany: async () => [],
      create: async () => { created += 1; }
    }
  };
  const review = await buildDispatchWorkerImportReview({ prisma, workbook: workbookWithRows(minimalHeaders(), [minimalRow()]), cities, vacancies });
  assert.equal(review.items[0].type, 'NEW');
  assert.equal(review.items[0].actionable, true);
  assert.equal(created, 0);
});

test('aplica únicamente los cambios seleccionados y elimina el lote', async () => {
  const updates = [];
  let deletedBatch = false;
  const item = {
    id: 'row-2', type: 'UPDATE', actionable: true, workerId: 'worker-1', workerUpdatedAt: '2026-07-25T03:00:00.000Z',
    incoming: {
      workerData: { fullName: 'Ana María Pérez Gómez', phone: '3001234567', documentType: 'CC', documentNumber: '1020304050', residenceCity: 'Bogotá', residenceLocality: 'Suba', transportMode: null, contractType: 'DIRECTO', operationalStatus: 'CONTRATADO', notes: null },
      providedWorkerFields: ['fullName', 'phone', 'documentType', 'documentNumber', 'residenceCity', 'residenceLocality', 'contractType'],
      relationsProvided: { cities: false, vacancies: false }, cityIds: [], vacancyIds: []
    }
  };
  const tx = {
    dispatchWorkerImportBatch: {
      findFirst: async () => ({ id: 'batch-1', status: 'PENDING', expiresAt: new Date('2026-07-25T06:00:00.000Z'), items: [item] }),
      delete: async () => { deletedBatch = true; }
    },
    dispatchWorker: {
      findUnique: async () => ({ id: 'worker-1', updatedAt: new Date('2026-07-25T03:00:00.000Z') }),
      update: async ({ data }) => { updates.push(data); }
    },
    dispatchWorkerCity: { deleteMany: async () => null, createMany: async () => null },
    dispatchWorkerVacancy: { deleteMany: async () => null, createMany: async () => null }
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  const result = await applyDispatchWorkerImportBatch({ prisma, batchId: 'batch-1', ownerKey: 'coord', selectedItemIds: ['row-2'], now: new Date('2026-07-25T04:00:00.000Z') });
  assert.equal(result.updated, 1);
  assert.equal(updates[0].fullName, 'Ana María Pérez Gómez');
  assert.equal('operationalStatus' in updates[0], false);
  assert.equal(deletedBatch, true);
});

test('un cambio concurrente se omite y no sobrescribe el auxiliar', async () => {
  let updateCalls = 0;
  const item = { id: 'row-2', type: 'UPDATE', actionable: true, workerId: 'worker-1', workerUpdatedAt: '2026-07-25T03:00:00.000Z', incoming: { workerData: {}, providedWorkerFields: [], relationsProvided: { cities: false, vacancies: false }, cityIds: [], vacancyIds: [] } };
  const tx = {
    dispatchWorkerImportBatch: { findFirst: async () => ({ id: 'batch', expiresAt: new Date('2026-07-25T06:00:00.000Z'), items: [item] }), delete: async () => null },
    dispatchWorker: { findUnique: async () => ({ id: 'worker-1', updatedAt: new Date('2026-07-25T03:30:00.000Z') }), update: async () => { updateCalls += 1; } },
    dispatchWorkerCity: { deleteMany: async () => null, createMany: async () => null },
    dispatchWorkerVacancy: { deleteMany: async () => null, createMany: async () => null }
  };
  const result = await applyDispatchWorkerImportBatch({ prisma: { $transaction: async (callback) => callback(tx) }, batchId: 'batch', ownerKey: 'coord', selectedItemIds: ['row-2'], now: new Date('2026-07-25T04:00:00.000Z') });
  assert.equal(result.conflicts, 1);
  assert.equal(updateCalls, 0);
});

test('la plantilla conserva Nombres y Apellidos separados', () => {
  const workbook = buildDispatchWorkerImportTemplate({ cities, vacancies });
  const sheet = workbook.getWorksheet('Auxiliares');
  assert.equal(sheet.getCell('A1').value, 'Nombres');
  assert.equal(sheet.getCell('B1').value, 'Apellidos');
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
  assert.match(view, /selectAll/);
});

test('la migración crea almacenamiento temporal de revisión', () => {
  const migration = fs.readFileSync('prisma/migrations/20260725043000_dispatch_worker_import_review/migration.sql', 'utf8');
  assert.match(migration, /CREATE TABLE "DispatchWorkerImportBatch"/);
  assert.match(migration, /"items" JSONB NOT NULL/);
  assert.match(migration, /"expiresAt" TIMESTAMP/);
});

test('rechaza documentos repetidos dentro del mismo archivo', () => {
  const workbook = workbookWithRows(minimalHeaders(), [minimalRow(), minimalRow({ firstNames: 'Otra', lastNames: 'Persona' })]);
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  assert.throws(() => prepareDispatchWorkerExcelRows(parsed, { cities, vacancies }), DispatchWorkerExcelValidationError);
});
