import ExcelJS from 'exceljs';
import { normalizeTransportMode } from './transportMode.js';

const MAX_IMPORT_ROWS = 2000;
const ACTIVE_STATUS = 'CONTRATADO';
const ALLOWED_TRANSPORT_MODES = new Set(['Publico', 'Moto', 'Bicicleta', 'Carro']);

const LEGACY_FULL_NAME_COLUMN = {
  field: 'fullName',
  header: 'Nombre completo',
  required: false,
  example: 'Persona Ejemplo',
  help: 'Formato compatible con plantillas anteriores.',
  aliases: ['nombre y apellidos', 'auxiliar', 'nombre auxiliar']
};

const LEGACY_VACANCIES_COLUMN = {
  field: 'vacancies',
  header: 'Vacantes / perfiles',
  required: false,
  example: '',
  help: 'Columna histórica. Se acepta para compatibilidad, pero ya no asigna disponibilidad en Despacho.',
  aliases: ['vacantes', 'vacante', 'perfiles', 'perfil', 'cargos', 'vacantes perfiles']
};

export const DISPATCH_WORKER_EXCEL_COLUMNS = [
  {
    field: 'firstNames',
    header: 'Nombres',
    required: true,
    example: 'Ana María',
    help: 'Uno o varios nombres. Se unirán automáticamente con los apellidos.',
    aliases: ['nombre', 'nombres del auxiliar', 'primer nombre', 'segundo nombre']
  },
  {
    field: 'lastNames',
    header: 'Apellidos',
    required: true,
    example: 'Pérez Gómez',
    help: 'Uno o varios apellidos. Se unirán automáticamente con los nombres.',
    aliases: ['apellido', 'apellidos del auxiliar', 'primer apellido', 'segundo apellido']
  },
  {
    field: 'phone',
    header: 'Teléfono',
    required: true,
    example: '3000000000',
    help: 'Número celular de contacto.',
    aliases: ['telefono', 'celular', 'numero telefono', 'numero de telefono']
  },
  {
    field: 'documentType',
    header: 'Tipo de documento',
    required: true,
    example: 'CC',
    help: 'Ejemplos: CC o PPT.',
    aliases: ['tipo documento', 'documento tipo']
  },
  {
    field: 'documentNumber',
    header: 'Número de documento',
    required: true,
    example: '1000000000',
    help: 'Se usa para detectar auxiliares duplicados.',
    aliases: ['numero documento', 'cedula', 'cédula', 'cc', 'documento']
  },
  {
    field: 'residenceCity',
    header: 'Ciudad de residencia',
    required: true,
    example: 'Bogotá',
    help: 'Ciudad donde reside la persona. Debe existir en el catálogo de Sucursales.',
    aliases: ['ciudad residencia', 'ciudad']
  },
  {
    field: 'residenceLocality',
    header: 'Localidad / barrio',
    required: true,
    example: 'Suba',
    help: 'Localidad, barrio o sector donde reside.',
    aliases: ['localidad', 'barrio', 'localidad barrio', 'sector']
  },
  {
    field: 'transportMode',
    header: 'Medio de transporte',
    required: false,
    example: 'Publico',
    help: 'Opcional: Publico, Moto, Bicicleta o Carro.',
    aliases: ['medio transporte', 'transporte']
  },
  {
    field: 'contractType',
    header: 'Tipo de contrato',
    required: true,
    example: 'DIRECTO',
    help: 'Valores permitidos: DIRECTO o CONTRATISTA.',
    aliases: ['tipo contrato', 'contrato']
  },
  {
    field: 'operationalStatus',
    header: 'Estado operativo',
    required: false,
    example: 'CONTRATADO',
    help: 'Opcional. Si queda vacío, un auxiliar nuevo se guarda como CONTRATADO y uno existente conserva su estado.',
    aliases: ['estado', 'status', 'estado auxiliar']
  },
  {
    field: 'operationalCities',
    header: 'Sucursales operativas',
    required: false,
    example: 'Bogotá',
    help: 'Para auxiliares nuevos indica al menos una sucursal. Puedes separar varias con coma, punto y coma, | o salto de línea.',
    aliases: ['sucursal', 'sucursales', 'sucursal operativa', 'sucursales operativas', 'ciudad operativa', 'ciudades operativas', 'ciudades de operacion', 'ciudades operación', 'ciudades']
  },
  {
    field: 'notes',
    header: 'Notas operativas',
    required: false,
    example: 'Disponible de lunes a sábado',
    help: 'Opcional: disponibilidad, restricciones o comentarios.',
    aliases: ['notas', 'observaciones', 'comentarios']
  }
];

const PARSABLE_EXCEL_COLUMNS = [LEGACY_FULL_NAME_COLUMN, ...DISPATCH_WORKER_EXCEL_COLUMNS, LEGACY_VACANCIES_COLUMN];
const NAME_FIELDS = new Set(['firstNames', 'lastNames']);

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

export function normalizeDispatchWorkerDocumentKey(value) {
  return normalizeString(value)
    ?.normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '') || '';
}

export async function findDispatchWorkerByDocumentIdentity(prismaClient, documentNumber, { excludeWorkerId = null } = {}) {
  const documentKey = normalizeDispatchWorkerDocumentKey(documentNumber);
  if (!documentKey || !prismaClient?.dispatchWorker?.findMany) return null;
  const workers = await prismaClient.dispatchWorker.findMany({
    where: {
      documentNumber: { not: null },
      ...(excludeWorkerId ? { id: { not: excludeWorkerId } } : {})
    },
    select: { id: true, documentNumber: true }
  });
  return workers.find((worker) => normalizeDispatchWorkerDocumentKey(worker.documentNumber) === documentKey) || null;
}

function normalizeNamePart(value) {
  return normalizeString(value)?.replace(/\s+/g, ' ') || null;
}

export function buildDispatchWorkerFullName(row = {}) {
  const firstNames = normalizeNamePart(row.firstNames);
  const lastNames = normalizeNamePart(row.lastNames);
  if (firstNames || lastNames) {
    if (!firstNames || !lastNames) return null;
    return `${firstNames} ${lastNames}`;
  }
  return normalizeNamePart(row.fullName);
}

export function normalizeExcelLookup(value) {
  return normalizeString(value)
    ?.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '';
}

function readCellText(cell) {
  const formatted = normalizeString(cell?.text);
  if (formatted) return formatted;
  const value = cell?.value;
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return normalizeString(value.richText.map((part) => part.text || '').join(''));
    if (value.result !== null && value.result !== undefined) return normalizeString(value.result);
    if (value.text !== null && value.text !== undefined) return normalizeString(value.text);
  }
  return normalizeString(value);
}

function columnAliases(column) {
  return [column.header, ...(column.aliases || [])].map(normalizeExcelLookup).filter(Boolean);
}

export function buildDispatchWorkerExcelHeaderMap(headerRow) {
  const aliasToField = new Map();
  for (const column of PARSABLE_EXCEL_COLUMNS) {
    for (const alias of columnAliases(column)) aliasToField.set(alias, column.field);
  }

  const map = new Map();
  headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const field = aliasToField.get(normalizeExcelLookup(readCellText(cell)));
    if (field && !map.has(field)) map.set(field, columnNumber);
  });

  const hasSupportedNameHeaders = map.has('fullName') || (map.has('firstNames') && map.has('lastNames'));
  const missingHeaders = DISPATCH_WORKER_EXCEL_COLUMNS
    .filter((column) => column.required && !NAME_FIELDS.has(column.field) && !map.has(column.field))
    .map((column) => column.header);
  if (!hasSupportedNameHeaders) missingHeaders.unshift('Nombres + Apellidos (o Nombre completo)');

  if (missingHeaders.length) {
    throw new DispatchWorkerExcelValidationError([
      `Faltan columnas obligatorias en el encabezado: ${missingHeaders.join(', ')}.`
    ]);
  }
  return map;
}

function splitList(value) {
  return String(value || '')
    .split(/[,;|\n\r]+/)
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function normalizeContractType(value) {
  const key = normalizeExcelLookup(value);
  if (['directo', 'directa'].includes(key)) return 'DIRECTO';
  if (key === 'contratista') return 'CONTRATISTA';
  return null;
}

function normalizeOperationalStatus(value) {
  const key = normalizeExcelLookup(value);
  if (!key) return ACTIVE_STATUS;
  if (['contratado', 'contratada', 'disponible', 'activo', 'activa'].includes(key)) return 'CONTRATADO';
  if (['inactive', 'inactivo', 'inactiva'].includes(key)) return 'INACTIVE';
  return null;
}

function addIndexValue(index, key, value) {
  if (!key) return;
  const current = index.get(key) || [];
  current.push(value);
  index.set(key, current);
}

export function buildDispatchWorkerImportCatalog({ cities = [] } = {}) {
  const cityIndex = new Map();
  for (const city of cities) addIndexValue(cityIndex, normalizeExcelLookup(city.name), city);
  return { cities, cityIndex };
}

function resolveUnique(index, rawValue, fieldLabel, rowNumber, errors) {
  const value = normalizeString(rawValue);
  const matches = index.get(normalizeExcelLookup(value)) || [];
  const unique = [...new Map(matches.map((item) => [item.id, item])).values()];
  if (!unique.length) {
    errors.push(`Fila ${rowNumber}: ${fieldLabel} “${value}” no existe.`);
    return null;
  }
  if (unique.length > 1) {
    errors.push(`Fila ${rowNumber}: ${fieldLabel} “${value}” es ambiguo.`);
    return null;
  }
  return unique[0];
}

export function parseDispatchWorkerExcelWorksheet(worksheet) {
  if (!worksheet) throw new DispatchWorkerExcelValidationError(['El archivo no tiene hojas de cálculo.']);
  const headerMap = buildDispatchWorkerExcelHeaderMap(worksheet.getRow(1));
  const rows = [];

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = {};
    const providedFields = [];
    for (const column of PARSABLE_EXCEL_COLUMNS) {
      const value = headerMap.has(column.field)
        ? readCellText(row.getCell(headerMap.get(column.field)))
        : null;
      values[column.field] = value;
      if (headerMap.has(column.field) && normalizeString(value)) providedFields.push(column.field);
    }
    if (!Object.values(values).some(Boolean)) continue;
    rows.push({ rowNumber, providedFields, ...values });
  }

  if (!rows.length) {
    throw new DispatchWorkerExcelValidationError([
      'El archivo no contiene auxiliares. La primera fila debe ser el encabezado y los datos empiezan en la fila 2.'
    ]);
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new DispatchWorkerExcelValidationError([
      `El archivo contiene ${rows.length} filas. El máximo permitido por importación es ${MAX_IMPORT_ROWS}.`
    ]);
  }
  return rows;
}

export function prepareDispatchWorkerExcelRows(rows, references = {}) {
  const catalog = buildDispatchWorkerImportCatalog(references);
  const errors = [];
  const prepared = [];
  const documentNumbers = new Set();

  for (const row of rows) {
    const fullName = buildDispatchWorkerFullName(row);
    const missing = DISPATCH_WORKER_EXCEL_COLUMNS
      .filter((column) => column.required && !NAME_FIELDS.has(column.field) && !normalizeString(row[column.field]))
      .map((column) => column.header);
    if (!fullName) missing.unshift('Nombres y Apellidos (o Nombre completo)');
    if (missing.length) {
      errors.push(`Fila ${row.rowNumber}: faltan ${missing.join(', ')}.`);
      continue;
    }

    const contractType = normalizeContractType(row.contractType);
    if (!contractType) errors.push(`Fila ${row.rowNumber}: Tipo de contrato debe ser DIRECTO o CONTRATISTA.`);

    const operationalStatus = normalizeOperationalStatus(row.operationalStatus);
    if (!operationalStatus) errors.push(`Fila ${row.rowNumber}: Estado operativo debe ser CONTRATADO o INACTIVE.`);

    const transportMode = normalizeString(row.transportMode) ? normalizeTransportMode(row.transportMode) : null;
    if (normalizeString(row.transportMode) && (!transportMode || !ALLOWED_TRANSPORT_MODES.has(transportMode))) {
      errors.push(`Fila ${row.rowNumber}: Medio de transporte no válido. Usa Publico, Moto, Bicicleta o Carro.`);
    }

    const residenceCity = resolveUnique(catalog.cityIndex, row.residenceCity, 'Ciudad de residencia', row.rowNumber, errors);
    const operationalCities = splitList(row.operationalCities)
      .map((value) => resolveUnique(catalog.cityIndex, value, 'Sucursal operativa', row.rowNumber, errors))
      .filter(Boolean);
    const cityIds = [...new Set(operationalCities.map((city) => city.id))];

    const documentNumber = normalizeString(row.documentNumber);
    const documentKey = normalizeDispatchWorkerDocumentKey(documentNumber);
    if (documentKey && documentNumbers.has(documentKey)) {
      errors.push(`Fila ${row.rowNumber}: el Número de documento está repetido dentro del archivo.`);
    }
    if (documentKey) documentNumbers.add(documentKey);

    const providedFields = new Set(row.providedFields || []);
    const providedWorkerFields = new Set([
      'fullName',
      'phone',
      'documentType',
      'documentNumber',
      'residenceCity',
      'residenceLocality',
      'contractType'
    ]);
    for (const field of ['transportMode', 'operationalStatus', 'notes']) {
      if (providedFields.has(field)) providedWorkerFields.add(field);
    }

    prepared.push({
      rowNumber: row.rowNumber,
      workerData: {
        fullName,
        phone: normalizeString(row.phone),
        documentType: normalizeString(row.documentType)?.toUpperCase(),
        documentNumber,
        residenceCity: residenceCity?.name || normalizeString(row.residenceCity),
        residenceLocality: normalizeString(row.residenceLocality),
        transportMode,
        contractType,
        operationalStatus,
        notes: normalizeString(row.notes)
      },
      providedWorkerFields: [...providedWorkerFields],
      relationsProvided: {
        cities: providedFields.has('operationalCities'),
        vacancies: false
      },
      cityIds,
      cityLabels: operationalCities.map((city) => city.name),
      vacancyIds: [],
      vacancyLabels: [],
      legacyVacanciesIgnored: providedFields.has('vacancies')
    });
  }

  if (errors.length) throw new DispatchWorkerExcelValidationError(errors);
  return prepared;
}

export const DISPATCH_WORKER_IMPORT_FIELD_LABELS = {
  fullName: 'Nombre completo',
  phone: 'Teléfono',
  documentType: 'Tipo de documento',
  residenceCity: 'Ciudad de residencia',
  residenceLocality: 'Localidad / barrio',
  transportMode: 'Medio de transporte',
  contractType: 'Tipo de contrato',
  operationalStatus: 'Estado operativo',
  notes: 'Notas operativas',
  cities: 'Sucursales operativas'
};

function comparableScalar(value) {
  return normalizeString(value) || '';
}

function comparableList(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value)).filter(Boolean))].sort();
}

function valuesEqual(currentValue, incomingValue) {
  if (Array.isArray(currentValue) || Array.isArray(incomingValue)) {
    return JSON.stringify(comparableList(currentValue)) === JSON.stringify(comparableList(incomingValue));
  }
  return comparableScalar(currentValue) === comparableScalar(incomingValue);
}

function visibleValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'Sin información';
  return normalizeString(value) || 'Sin información';
}

function existingWorkerSnapshot(worker) {
  return {
    fullName: worker.fullName,
    phone: worker.phone,
    documentType: worker.documentType,
    documentNumber: worker.documentNumber,
    residenceCity: worker.residenceCity,
    residenceLocality: worker.residenceLocality,
    transportMode: worker.transportMode,
    contractType: worker.contractType,
    operationalStatus: worker.operationalStatus,
    notes: worker.notes,
    cities: (worker.cities || []).map((row) => row.city?.name).filter(Boolean)
  };
}

function incomingWorkerSnapshot(row) {
  return {
    ...row.workerData,
    cities: row.cityLabels
  };
}

function buildReviewChanges(row, existing = null) {
  const incoming = incomingWorkerSnapshot(row);
  const current = existing ? existingWorkerSnapshot(existing) : {};
  const changes = [];
  const scalarFields = row.providedWorkerFields.filter((field) => field !== 'documentNumber');
  for (const field of scalarFields) {
    if (existing && valuesEqual(current[field], incoming[field])) continue;
    changes.push({
      field,
      label: DISPATCH_WORKER_IMPORT_FIELD_LABELS[field] || field,
      currentValue: existing ? visibleValue(current[field]) : 'No existe',
      incomingValue: visibleValue(incoming[field])
    });
  }
  if (row.relationsProvided.cities && (!existing || !valuesEqual(current.cities, incoming.cities))) {
    changes.push({
      field: 'cities',
      label: DISPATCH_WORKER_IMPORT_FIELD_LABELS.cities,
      currentValue: existing ? visibleValue(current.cities) : 'No existe',
      incomingValue: visibleValue(incoming.cities)
    });
  }
  return changes;
}

export async function buildDispatchWorkerImportReview({ prisma, workbook, cities = [] } = {}) {
  const parsedRows = parseDispatchWorkerExcelWorksheet(workbook?.worksheets?.[0]);
  const preparedRows = prepareDispatchWorkerExcelRows(parsedRows, { cities });
  const existingWorkers = preparedRows.length
    ? await prisma.dispatchWorker.findMany({
      where: { documentNumber: { not: null } },
      include: { cities: { include: { city: true } } }
    })
    : [];
  const byDocument = new Map();
  for (const worker of existingWorkers) {
    const key = normalizeDispatchWorkerDocumentKey(worker.documentNumber);
    const matches = byDocument.get(key) || [];
    matches.push(worker);
    byDocument.set(key, matches);
  }

  const items = preparedRows.map((row) => {
    const matches = byDocument.get(normalizeDispatchWorkerDocumentKey(row.workerData.documentNumber)) || [];
    if (matches.length > 1) {
      return {
        id: `row-${row.rowNumber}`,
        rowNumber: row.rowNumber,
        type: 'CONFLICT',
        actionable: false,
        displayName: row.workerData.fullName,
        documentNumber: row.workerData.documentNumber,
        reason: 'Existen varios auxiliares con el mismo número de documento. Debe corregirse manualmente antes de importar.',
        changes: [],
        incoming: row
      };
    }

    const existing = matches[0] || null;
    if (!existing && !row.cityIds.length) {
      return {
        id: `row-${row.rowNumber}`,
        rowNumber: row.rowNumber,
        type: 'CONFLICT',
        actionable: false,
        displayName: row.workerData.fullName,
        documentNumber: row.workerData.documentNumber,
        reason: 'Un auxiliar nuevo debe tener al menos una Sucursal operativa.',
        changes: [],
        incoming: row
      };
    }

    const changes = buildReviewChanges(row, existing);
    const type = !existing ? 'NEW' : (changes.length ? 'UPDATE' : 'UNCHANGED');
    return {
      id: `row-${row.rowNumber}`,
      rowNumber: row.rowNumber,
      type,
      actionable: type === 'NEW' || type === 'UPDATE',
      displayName: row.workerData.fullName,
      documentNumber: row.workerData.documentNumber,
      workerId: existing?.id || null,
      workerUpdatedAt: existing?.updatedAt ? new Date(existing.updatedAt).toISOString() : null,
      reason: row.legacyVacanciesIgnored
        ? 'Se ignoró la columna histórica Vacantes / perfiles; Despacho usa únicamente Sucursales.'
        : (type === 'UNCHANGED' ? 'El archivo coincide con la información actual.' : null),
      changes,
      incoming: row
    };
  });

  const summary = {
    total: items.length,
    newCount: items.filter((item) => item.type === 'NEW').length,
    updateCount: items.filter((item) => item.type === 'UPDATE').length,
    unchangedCount: items.filter((item) => item.type === 'UNCHANGED').length,
    conflictCount: items.filter((item) => item.type === 'CONFLICT').length,
    actionableCount: items.filter((item) => item.actionable).length
  };
  return { items, summary };
}

async function replaceWorkerBranches(prisma, workerId, cityIds, relationsProvided = { cities: true }) {
  if (!relationsProvided.cities) return;
  await prisma.dispatchWorkerCity.deleteMany({ where: { workerId } });
  if (cityIds.length) {
    await prisma.dispatchWorkerCity.createMany({
      data: cityIds.map((cityId) => ({ workerId, cityId })),
      skipDuplicates: true
    });
  }
}

function selectedReviewItems(items, selectedItemIds, applyAll) {
  const selected = new Set((selectedItemIds || []).map(String));
  return items.filter((item) => item?.actionable && (applyAll || selected.has(String(item.id))));
}

export async function applyDispatchWorkerImportBatch({
  prisma,
  batchId,
  ownerKey,
  selectedItemIds = [],
  applyAll = false,
  now = new Date()
} = {}) {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.dispatchWorkerImportBatch.findFirst({
      where: { id: batchId, createdByUsername: ownerKey, status: 'PENDING' }
    });
    if (!batch) throw new DispatchWorkerExcelValidationError(['La revisión no existe, ya fue aplicada o pertenece a otro usuario.']);
    if (new Date(batch.expiresAt).getTime() <= now.getTime()) {
      throw new DispatchWorkerExcelValidationError(['La revisión expiró. Vuelve a subir el archivo.']);
    }

    const items = Array.isArray(batch.items) ? batch.items : [];
    const targets = selectedReviewItems(items, selectedItemIds, applyAll);
    if (!targets.length) throw new DispatchWorkerExcelValidationError(['Selecciona al menos un auxiliar nuevo o un cambio para aprobar.']);

    const existingWorkers = await tx.dispatchWorker.findMany({
      where: { documentNumber: { not: null } },
      select: { id: true, documentNumber: true }
    });
    const existingDocumentKeys = new Set(existingWorkers.map((worker) => normalizeDispatchWorkerDocumentKey(worker.documentNumber)).filter(Boolean));
    const result = { created: 0, updated: 0, conflicts: 0, selected: targets.length };
    for (const item of targets) {
      const incoming = item.incoming || {};
      const workerData = incoming.workerData || {};
      if (item.type === 'NEW') {
        const documentKey = normalizeDispatchWorkerDocumentKey(workerData.documentNumber);
        if (!documentKey || existingDocumentKeys.has(documentKey) || !(incoming.cityIds || []).length) {
          result.conflicts += 1;
          continue;
        }
        const worker = await tx.dispatchWorker.create({
          data: { ...workerData, source: 'EXCEL_IMPORT' }
        });
        existingDocumentKeys.add(documentKey);
        await replaceWorkerBranches(tx, worker.id, incoming.cityIds || [], { cities: true });
        result.created += 1;
        continue;
      }

      if (item.type !== 'UPDATE' || !item.workerId) continue;
      const updateData = {};
      for (const field of incoming.providedWorkerFields || []) {
        if (field === 'documentNumber' || field === 'source') continue;
        updateData[field] = workerData[field] ?? null;
      }
      const expectedUpdatedAt = new Date(item.workerUpdatedAt || Number.NaN);
      if (Number.isNaN(expectedUpdatedAt.getTime())) {
        result.conflicts += 1;
        continue;
      }
      const updated = await tx.dispatchWorker.updateMany({
        where: { id: item.workerId, updatedAt: expectedUpdatedAt },
        data: Object.keys(updateData).length ? updateData : { updatedAt: now }
      });
      if (!updated.count) {
        result.conflicts += 1;
        continue;
      }
      await replaceWorkerBranches(tx, item.workerId, incoming.cityIds || [], incoming.relationsProvided || { cities: false });
      result.updated += 1;
    }

    await tx.dispatchWorkerImportBatch.delete({ where: { id: batch.id } });
    return result;
  });
}

function styleHeader(row) {
  row.height = 30;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D7A6B' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
}

function templateColumnNumber(field) {
  const index = DISPATCH_WORKER_EXCEL_COLUMNS.findIndex((column) => column.field === field);
  if (index < 0) throw new Error(`No se encontró la columna ${field} en la plantilla.`);
  return index + 1;
}

export function buildDispatchWorkerImportTemplate({ cities = [] } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lórren Dispatch';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet('Auxiliares', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  worksheet.columns = DISPATCH_WORKER_EXCEL_COLUMNS.map((column) => ({
    header: column.header,
    key: column.field,
    width: Math.max(18, Math.min(42, column.header.length + 8))
  }));
  styleHeader(worksheet.getRow(1));
  worksheet.autoFilter = { from: 'A1', to: `${worksheet.getColumn(DISPATCH_WORKER_EXCEL_COLUMNS.length).letter}1` };

  const firstCity = cities[0]?.name || 'Bogotá';
  const example = {};
  for (const column of DISPATCH_WORKER_EXCEL_COLUMNS) example[column.field] = column.example;
  example.residenceCity = firstCity;
  example.operationalCities = firstCity;
  worksheet.addRow(example);
  worksheet.getRow(2).alignment = { vertical: 'top', wrapText: true };
  worksheet.getRow(2).height = 36;

  const transportColumn = templateColumnNumber('transportMode');
  const contractColumn = templateColumnNumber('contractType');
  const statusColumn = templateColumnNumber('operationalStatus');
  for (let rowNumber = 2; rowNumber <= 1000; rowNumber += 1) {
    worksheet.getRow(rowNumber).getCell(transportColumn).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"Publico,Moto,Bicicleta,Carro"'],
      showErrorMessage: true, errorTitle: 'Medio de transporte inválido', error: 'Selecciona Publico, Moto, Bicicleta o Carro.'
    };
    worksheet.getRow(rowNumber).getCell(contractColumn).dataValidation = {
      type: 'list', allowBlank: false, formulae: ['"DIRECTO,CONTRATISTA"'],
      showErrorMessage: true, errorTitle: 'Tipo de contrato inválido', error: 'Selecciona DIRECTO o CONTRATISTA.'
    };
    worksheet.getRow(rowNumber).getCell(statusColumn).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"CONTRATADO,INACTIVE"'],
      showErrorMessage: true, errorTitle: 'Estado inválido', error: 'Selecciona CONTRATADO o INACTIVE, o déjalo vacío.'
    };
  }

  const instructions = workbook.addWorksheet('Instrucciones');
  instructions.columns = [
    { header: 'Campo', key: 'field', width: 28 },
    { header: 'Obligatorio', key: 'required', width: 14 },
    { header: 'Cómo diligenciarlo', key: 'help', width: 66 },
    { header: 'Ejemplo', key: 'example', width: 45 }
  ];
  styleHeader(instructions.getRow(1));
  for (const column of DISPATCH_WORKER_EXCEL_COLUMNS) {
    instructions.addRow({
      field: column.header,
      required: column.required ? 'Sí' : (column.field === 'operationalCities' ? 'Sí para nuevos' : 'No'),
      help: column.help,
      example: column.example
    });
  }
  instructions.addRow({
    field: 'Nombre completo (compatible)',
    required: 'Alternativa',
    help: 'Las plantillas anteriores con una sola columna Nombre completo siguen siendo válidas. No combines esa columna con Nombres y Apellidos.',
    example: 'Persona Ejemplo'
  });
  instructions.addRow({
    field: 'Vacantes / perfiles (legado)',
    required: 'No',
    help: 'Si una plantilla antigua conserva esta columna, el importador la acepta pero la ignora. La disponibilidad de Despacho se asigna únicamente por Sucursal.',
    example: 'Puede dejarse vacía'
  });
  instructions.addRow({
    field: 'Hoja de vida',
    required: 'No se importa',
    help: 'La hoja de vida es un archivo PDF, DOC o DOCX. Debe agregarse después desde Editar auxiliar.',
    example: 'No escribas rutas ni enlaces locales en el Excel.'
  });
  instructions.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.alignment = { vertical: 'top', wrapText: true };
  });

  const catalogs = workbook.addWorksheet('Catalogos');
  catalogs.columns = [{ header: 'Sucursales válidas', key: 'city', width: 42 }];
  styleHeader(catalogs.getRow(1));
  for (const city of cities) catalogs.addRow({ city: city.name || '' });
  if (!cities.length) catalogs.addRow({ city: '' });
  catalogs.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.alignment = { vertical: 'top', wrapText: true };
  });

  return workbook;
}

export class DispatchWorkerExcelValidationError extends Error {
  constructor(errors = []) {
    const visible = errors.slice(0, 8);
    const remaining = Math.max(0, errors.length - visible.length);
    const suffix = remaining ? ` Se omitieron ${remaining} error${remaining !== 1 ? 'es' : ''} adicional${remaining !== 1 ? 'es' : ''}.` : '';
    super(`Corrige el archivo antes de importarlo: ${visible.join(' | ')}${suffix}`);
    this.name = 'DispatchWorkerExcelValidationError';
    this.errors = errors;
    this.statusCode = 400;
  }
}
