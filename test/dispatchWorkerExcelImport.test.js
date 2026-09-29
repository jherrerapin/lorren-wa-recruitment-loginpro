import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { buildDispatchWorkersExportWorkbook } from '../src/routes/dispatchOpsExtras.js';
import {
  DISPATCH_WORKER_EXCEL_COLUMNS,
  DispatchWorkerExcelValidationError,
  applyDispatchWorkerImportBatch,
  buildDispatchWorkerFullName,
  buildDispatchWorkerImportReview,
  buildDispatchWorkerImportTemplate,
  normalizeDispatchWorkerDocumentKey,
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

function sourceBlock(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `No se encontró ${startMarker}`);
  assert.notEqual(end, -1, `No se encontró ${endMarker}`);
  return content.slice(start, end);
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

test('la identidad documental ignora mayúsculas y separadores', () => {
  assert.equal(normalizeDispatchWorkerDocumentKey(' test-12.34 / ab '), 'TEST1234AB');
  assert.equal(normalizeDispatchWorkerDocumentKey('TEST 1234 AB'), 'TEST1234AB');
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

test('Excel reconoce como existente un documento equivalente con otro formato', async () => {
  const prisma = { dispatchWorker: { findMany: async () => [existingWorker({ documentNumber: 'TEST-1000' })] } };
  const review = await buildDispatchWorkerImportReview({
    prisma,
    workbook: workbookWithRows(minimalHeaders(), [minimalRow({ documentNumber: 'test 1000' })]),
    cities
  });
  assert.equal(review.items[0].workerId, 'worker-1');
  assert.notEqual(review.items[0].type, 'NEW');
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
      workerData: { fullName: 'Persona Ejemplo', phone: '3000000000', documentType: 'CC', documentNumber: 'TEST-1001', residenceCity: 'Bogotá', residenceLocality: 'Suba', transportMode: null, contractType: 'DIRECTO', operationalStatus: 'CONTRATADO', notes: null },
      providedWorkerFields: ['fullName'], relationsProvided: { cities: true, vacancies: false }, cityIds: ['branch-bogota'], vacancyIds: []
    }
  };
  const tx = {
    dispatchWorkerImportBatch: {
      findFirst: async () => ({ id: 'batch-1', status: 'PENDING', expiresAt: new Date('2026-07-25T06:00:00.000Z'), items: [item] }),
      delete: async () => { deletedBatch = true; }
    },
    dispatchWorker: {
      findMany: async () => [],
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

test('aplicación final de Excel omite un NEW si el documento equivalente ya existe', async () => {
  let created = 0;
  const item = {
    id: 'row-2', type: 'NEW', actionable: true,
    incoming: {
      workerData: { fullName: 'Persona Prueba', documentNumber: 'test 1000' },
      providedWorkerFields: ['fullName'], relationsProvided: { cities: true, vacancies: false }, cityIds: ['branch-bogota']
    }
  };
  const tx = {
    dispatchWorkerImportBatch: {
      findFirst: async () => ({ id: 'batch-duplicate', status: 'PENDING', expiresAt: new Date('2026-07-25T06:00:00.000Z'), items: [item] }),
      delete: async () => null
    },
    dispatchWorker: {
      findMany: async () => [{ id: 'existing-worker', documentNumber: 'TEST-1000' }],
      create: async () => { created += 1; return { id: 'should-not-create' }; }
    },
    dispatchWorkerCity: { deleteMany: async () => null, createMany: async () => null }
  };
  const result = await applyDispatchWorkerImportBatch({ prisma: { $transaction: async (callback) => callback(tx) }, batchId: 'batch-duplicate', ownerKey: 'coord', selectedItemIds: ['row-2'], now: new Date('2026-07-25T04:00:00.000Z') });
  assert.equal(result.created, 0);
  assert.equal(result.conflicts, 1);
  assert.equal(created, 0);
});

test('un cambio concurrente se omite y no sobrescribe el auxiliar', async () => {
  let updateCalls = 0;
  const item = { id: 'row-2', type: 'UPDATE', actionable: true, workerId: 'worker-1', workerUpdatedAt: '2026-07-25T03:00:00.000Z', incoming: { workerData: {}, providedWorkerFields: [], relationsProvided: { cities: false, vacancies: false }, cityIds: [] } };
  const tx = {
    dispatchWorkerImportBatch: { findFirst: async () => ({ id: 'batch', expiresAt: new Date('2026-07-25T06:00:00.000Z'), items: [item] }), delete: async () => null },
    dispatchWorker: { findMany: async () => [], updateMany: async () => { updateCalls += 1; return { count: 0 }; } },
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

test('la descarga de Personal operativo genera un Excel completo y legible', () => {
  const generatedAt = new Date('2026-09-08T20:00:00.000Z');
  const workbook = buildDispatchWorkersExportWorkbook([{
    fullName: 'Auxiliar Prueba Uno',
    phone: 'TEST-PHONE-1',
    documentType: 'CC',
    documentNumber: 'TEST-1000',
    residenceCity: 'Bogotá',
    residenceLocality: 'Localidad prueba',
    transportMode: 'Moto',
    contractType: 'DIRECTO',
    operationalStatus: 'CONTRATADO',
    source: 'EXCEL_IMPORT',
    notes: 'Registro seudonimizado',
    cvOriginalName: 'hoja-prueba.pdf',
    createdAt: new Date('2026-08-01T12:00:00.000Z'),
    updatedAt: new Date('2026-09-01T12:00:00.000Z'),
    cities: [{ city: { name: 'Bogotá' } }, { city: { name: 'Cali' } }]
  }], generatedAt);
  const sheet = workbook.getWorksheet('Personal operativo');
  assert.equal(sheet.getCell('A1').value, 'Personal operativo — LoginPro');
  assert.match(String(sheet.getCell('A2').value), /Auxiliares registrados: 1/);
  assert.equal(sheet.getCell('A4').value, 'Nombre completo');
  assert.equal(sheet.getCell('O4').value, 'Última actualización');
  assert.equal(sheet.getCell('A5').value, 'Auxiliar Prueba Uno');
  assert.equal(sheet.getCell('I5').value, 'Contratado / disponible');
  assert.equal(sheet.getCell('J5').value, 'Bogotá, Cali');
  assert.equal(sheet.getCell('K5').value, 'Excel masivo');
  assert.equal(sheet.getCell('M5').value, 'hoja-prueba.pdf');
  assert.equal(sheet.views[0].ySplit, 4);
  assert.equal(sheet.getCell('N5').numFmt, 'dd/mm/yyyy hh:mm');
  assert.ok(sheet.getTable('PersonalOperativoRegistrado'));
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

test('rechaza documentos equivalentes repetidos dentro del mismo archivo', () => {
  const workbook = workbookWithRows(minimalHeaders(), [
    minimalRow({ documentNumber: 'TEST-1000' }),
    minimalRow({ firstNames: 'Otra', lastNames: 'Persona', documentNumber: 'test 1000' })
  ]);
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  assert.throws(() => prepareDispatchWorkerExcelRows(parsed, { cities }), DispatchWorkerExcelValidationError);
});

test('altas manuales bloquean identidad repetida, avisan en el formulario y Personal ofrece descarga Excel', () => {
  const publicRoute = fs.readFileSync('src/routes/publicDispatchClient.js', 'utf8');
  const extrasRoute = fs.readFileSync('src/routes/dispatchOpsExtras.js', 'utf8');
  const personalView = fs.readFileSync('src/views/operacionesPersonal.ejs', 'utf8');
  const createView = fs.readFileSync('src/views/operacionesPersonalNuevo.ejs', 'utf8');
  const duplicateCheck = sourceBlock(publicRoute, "router.post('/admin-worker/documento-existe'", "router.post('/admin-clientes'");
  const canonicalCreate = sourceBlock(publicRoute, "router.post('/admin-worker/nuevo'", "router.get('/admin-worker/:workerId/editar'");
  const legacyCreate = sourceBlock(extrasRoute, "router.post('/personal/nuevo'", "router.get('/personal/:workerId/editar'");
  const exportRoute = sourceBlock(extrasRoute, "router.get('/personal/exportar-excel'", "router.get('/personal/importar-excel'");

  assert.match(publicRoute, /findDispatchWorkerByDocumentIdentity/);
  assert.match(duplicateCheck, /findDispatchWorkerByDocumentIdentity\(prisma, documentNumber\)/);
  assert.match(duplicateCheck, /res\.json\(\{ exists: Boolean\(duplicate\) \}\)/);
  assert.doesNotMatch(duplicateCheck, /fullName|phone|documentType/);
  assert.match(canonicalCreate, /DUPLICATE_WORKER_DOCUMENT_MESSAGE/);
  assert.match(canonicalCreate, /\/operaciones\/admin-worker\/nuevo\?error=/);
  assert.match(legacyCreate, /findDispatchWorkerByDocumentIdentity\(prisma, workerData\.documentNumber\)/);
  assert.match(legacyCreate, /if \(duplicate\) return res\.redirect\('\/admin\/operaciones\/personal'\)/);
  assert.match(createView, /id="asyncToast" class="async-toast"/);
  assert.match(createView, /addEventListener\('blur'/);
  assert.match(createView, /addEventListener\('submit'/);
  assert.match(createView, /\/operaciones\/admin-worker\/documento-existe/);
  assert.match(createView, /Este número de documento ya está registrado\./);
  assert.match(createView, /if \(mode === 'create'\)/);
  assert.doesNotMatch(createView, /\b(?:window\.)?alert\s*\(/);
  assert.doesNotMatch(createView, /No se permiten auxiliares duplicados/i);
  assert.match(exportRoute, /dispatchWorker\.findMany\(\{\s*where:\s*buildDispatchEligibilityFilter\(\),\s*select:/);
  assert.match(exportRoute, /buildDispatchWorkersExportWorkbook\(workers\)/);
  assert.match(exportRoute, /Content-Disposition/);
  assert.match(personalView, /href="\/admin\/operaciones\/personal\/exportar-excel"/);
  assert.match(personalView, />&#11015; Descargar Excel<\/a>/);
});

test('catálogo exportado ya no contiene columna de vacantes', () => {
  assert.equal(DISPATCH_WORKER_EXCEL_COLUMNS.some((column) => column.field === 'vacancies'), false);
  assert.equal(DISPATCH_WORKER_EXCEL_COLUMNS.some((column) => column.field === 'operationalCities'), true);
});