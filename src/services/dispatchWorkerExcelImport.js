import ExcelJS from 'exceljs';
import { normalizeTransportMode } from './transportMode.js';

const MAX_IMPORT_ROWS = 2000;
const ACTIVE_STATUS = 'CONTRATADO';
const DISABLED_STATUSES = ['DISABLED', 'INACTIVE', 'ELIMINADO'];
const DISPATCH_OWNED_SOURCES = ['MANUAL', 'EXCEL_IMPORT', 'CANDIDATE'];
const ALLOWED_TRANSPORT_MODES = new Set(['Publico', 'Moto', 'Bicicleta', 'Carro']);

export const DISPATCH_WORKER_EXCEL_COLUMNS = [
  {
    field: 'fullName',
    header: 'Nombre completo',
    required: true,
    example: 'Oscar Antonio Montoya Hernández',
    help: 'Nombre y apellidos del auxiliar.',
    aliases: ['nombre', 'auxiliar', 'nombre auxiliar']
  },
  {
    field: 'phone',
    header: 'Teléfono',
    required: true,
    example: '3134645409',
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
    example: '1020304050',
    help: 'Se usa para detectar auxiliares duplicados.',
    aliases: ['numero documento', 'cedula', 'cédula', 'cc', 'documento']
  },
  {
    field: 'residenceCity',
    header: 'Ciudad de residencia',
    required: true,
    example: 'Bogotá',
    help: 'Debe coincidir con una ciudad disponible en Despacho.',
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
    required: true,
    example: 'CONTRATADO',
    help: 'Valores permitidos: CONTRATADO o INACTIVE.',
    aliases: ['estado', 'status', 'estado auxiliar']
  },
  {
    field: 'operationalCities',
    header: 'Ciudades operativas',
    required: true,
    example: 'Bogotá; Siberia',
    help: 'Una o varias ciudades separadas por coma, punto y coma, | o salto de línea.',
    aliases: ['ciudad operativa', 'ciudades de operacion', 'ciudades operación', 'ciudades']
  },
  {
    field: 'vacancies',
    header: 'Vacantes / perfiles',
    required: true,
    example: 'Auxiliar de cargue y descargue — Bogotá',
    help: 'Una o varias vacantes separadas por coma, punto y coma, | o salto de línea.',
    aliases: ['vacantes', 'perfiles', 'cargos', 'vacantes perfiles']
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

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
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
  for (const column of DISPATCH_WORKER_EXCEL_COLUMNS) {
    for (const alias of columnAliases(column)) aliasToField.set(alias, column.field);
  }

  const map = new Map();
  headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const field = aliasToField.get(normalizeExcelLookup(readCellText(cell)));
    if (field && !map.has(field)) map.set(field, columnNumber);
  });

  const missingHeaders = DISPATCH_WORKER_EXCEL_COLUMNS
    .filter((column) => column.required && !map.has(column.field))
    .map((column) => column.header);
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
  if (['contratado', 'contratada', 'disponible', 'activo', 'activa'].includes(key)) return 'CONTRATADO';
  if (['inactive', 'inactivo', 'inactiva'].includes(key)) return 'INACTIVE';
  return null;
}

function vacancyLabel(vacancy) {
  return `${vacancy.title || 'Vacante'} — ${vacancy.city || 'Sin ciudad'}`;
}

function addIndexValue(index, key, value) {
  if (!key) return;
  const current = index.get(key) || [];
  current.push(value);
  index.set(key, current);
}

export function buildDispatchWorkerImportCatalog({ cities = [], vacancies = [] } = {}) {
  const cityIndex = new Map();
  for (const city of cities) addIndexValue(cityIndex, normalizeExcelLookup(city.name), city);

  const vacancyIndex = new Map();
  for (const vacancy of vacancies) {
    addIndexValue(vacancyIndex, normalizeExcelLookup(vacancy.id), vacancy);
    addIndexValue(vacancyIndex, normalizeExcelLookup(vacancy.title), vacancy);
    addIndexValue(vacancyIndex, normalizeExcelLookup(vacancyLabel(vacancy)), vacancy);
    addIndexValue(vacancyIndex, normalizeExcelLookup(`${vacancy.title || ''} ${vacancy.city || ''}`), vacancy);
  }
  return { cities, vacancies, cityIndex, vacancyIndex };
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
    errors.push(`Fila ${rowNumber}: ${fieldLabel} “${value}” es ambiguo; usa el nombre acompañado de la ciudad.`);
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
    for (const column of DISPATCH_WORKER_EXCEL_COLUMNS) {
      values[column.field] = headerMap.has(column.field)
        ? readCellText(row.getCell(headerMap.get(column.field)))
        : null;
    }
    if (!Object.values(values).some(Boolean)) continue;
    rows.push({ rowNumber, ...values });
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
    const missing = DISPATCH_WORKER_EXCEL_COLUMNS
      .filter((column) => column.required && !normalizeString(row[column.field]))
      .map((column) => column.header);
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
      .map((value) => resolveUnique(catalog.cityIndex, value, 'Ciudad operativa', row.rowNumber, errors))
      .filter(Boolean);
    const vacancies = splitList(row.vacancies)
      .map((value) => resolveUnique(catalog.vacancyIndex, value, 'Vacante / perfil', row.rowNumber, errors))
      .filter(Boolean);

    const cityIds = [...new Set(operationalCities.map((city) => city.id))];
    const vacancyIds = [...new Set(vacancies.map((vacancy) => vacancy.id))];
    if (!cityIds.length) errors.push(`Fila ${row.rowNumber}: debes indicar al menos una Ciudad operativa válida.`);
    if (!vacancyIds.length) errors.push(`Fila ${row.rowNumber}: debes indicar al menos una Vacante / perfil válida.`);

    const selectedCityNames = new Set(operationalCities.map((city) => normalizeExcelLookup(city.name)));
    for (const vacancy of vacancies) {
      if (vacancy.city && !selectedCityNames.has(normalizeExcelLookup(vacancy.city))) {
        errors.push(`Fila ${row.rowNumber}: la vacante “${vacancyLabel(vacancy)}” no corresponde a las Ciudades operativas seleccionadas.`);
      }
    }

    const documentNumber = normalizeString(row.documentNumber);
    const documentKey = documentNumber?.toUpperCase();
    if (documentKey && documentNumbers.has(documentKey)) {
      errors.push(`Fila ${row.rowNumber}: el Número de documento ${documentNumber} está repetido dentro del archivo.`);
    }
    if (documentKey) documentNumbers.add(documentKey);

    prepared.push({
      rowNumber: row.rowNumber,
      workerData: {
        fullName: normalizeString(row.fullName),
        phone: normalizeString(row.phone),
        documentType: normalizeString(row.documentType)?.toUpperCase(),
        documentNumber,
        residenceCity: residenceCity?.name || normalizeString(row.residenceCity),
        residenceLocality: normalizeString(row.residenceLocality),
        transportMode,
        contractType,
        operationalStatus,
        notes: normalizeString(row.notes),
        source: 'EXCEL_IMPORT'
      },
      cityIds,
      vacancyIds
    });
  }

  if (errors.length) throw new DispatchWorkerExcelValidationError(errors);
  return prepared;
}

async function replaceWorkerRelations(prisma, workerId, cityIds, vacancyIds) {
  await prisma.dispatchWorkerCity.deleteMany({ where: { workerId } });
  await prisma.dispatchWorkerVacancy.deleteMany({ where: { workerId } });
  if (cityIds.length) {
    await prisma.dispatchWorkerCity.createMany({
      data: cityIds.map((cityId) => ({ workerId, cityId })),
      skipDuplicates: true
    });
  }
  if (vacancyIds.length) {
    await prisma.dispatchWorkerVacancy.createMany({
      data: vacancyIds.map((vacancyId) => ({ workerId, vacancyId })),
      skipDuplicates: true
    });
  }
}

export async function importDispatchWorkerExcelWorkbook({ prisma, workbook, cities = [], vacancies = [] } = {}) {
  const parsedRows = parseDispatchWorkerExcelWorksheet(workbook?.worksheets?.[0]);
  const preparedRows = prepareDispatchWorkerExcelRows(parsedRows, { cities, vacancies });

  return prisma.$transaction(async (tx) => {
    const result = { created: 0, updated: 0, skipped: 0, total: preparedRows.length };
    for (const row of preparedRows) {
      const documentNumber = row.workerData.documentNumber;
      const activeExisting = await tx.dispatchWorker.findFirst({
        where: { documentNumber, operationalStatus: ACTIVE_STATUS },
        select: { id: true }
      });
      if (activeExisting) {
        result.skipped += 1;
        continue;
      }

      const disabledExisting = await tx.dispatchWorker.findFirst({
        where: {
          documentNumber,
          source: { in: DISPATCH_OWNED_SOURCES },
          operationalStatus: { in: DISABLED_STATUSES }
        },
        select: { id: true }
      });

      if (disabledExisting) {
        await tx.dispatchWorker.update({ where: { id: disabledExisting.id }, data: row.workerData });
        await replaceWorkerRelations(tx, disabledExisting.id, row.cityIds, row.vacancyIds);
        result.updated += 1;
        continue;
      }

      const worker = await tx.dispatchWorker.create({ data: row.workerData });
      await replaceWorkerRelations(tx, worker.id, row.cityIds, row.vacancyIds);
      result.created += 1;
    }
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

export function buildDispatchWorkerImportTemplate({ cities = [], vacancies = [] } = {}) {
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
  const matchingVacancy = vacancies.find((vacancy) => normalizeExcelLookup(vacancy.city) === normalizeExcelLookup(firstCity)) || vacancies[0];
  const example = {};
  for (const column of DISPATCH_WORKER_EXCEL_COLUMNS) example[column.field] = column.example;
  example.residenceCity = firstCity;
  example.operationalCities = firstCity;
  example.vacancies = matchingVacancy ? vacancyLabel(matchingVacancy) : 'Nombre exacto de la vacante — Ciudad';
  worksheet.addRow(example);
  worksheet.getRow(2).alignment = { vertical: 'top', wrapText: true };
  worksheet.getRow(2).height = 36;

  for (let rowNumber = 2; rowNumber <= 1000; rowNumber += 1) {
    worksheet.getCell(`G${rowNumber}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"Publico,Moto,Bicicleta,Carro"'],
      showErrorMessage: true,
      errorTitle: 'Medio de transporte inválido',
      error: 'Selecciona Publico, Moto, Bicicleta o Carro.'
    };
    worksheet.getCell(`H${rowNumber}`).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"DIRECTO,CONTRATISTA"'],
      showErrorMessage: true,
      errorTitle: 'Tipo de contrato inválido',
      error: 'Selecciona DIRECTO o CONTRATISTA.'
    };
    worksheet.getCell(`I${rowNumber}`).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"CONTRATADO,INACTIVE"'],
      showErrorMessage: true,
      errorTitle: 'Estado inválido',
      error: 'Selecciona CONTRATADO o INACTIVE.'
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
      required: column.required ? 'Sí' : 'No',
      help: column.help,
      example: column.example
    });
  }
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
  catalogs.columns = [
    { header: 'Ciudades válidas', key: 'city', width: 32 },
    { header: 'Vacantes / perfiles válidos', key: 'vacancy', width: 70 }
  ];
  styleHeader(catalogs.getRow(1));
  const catalogLength = Math.max(cities.length, vacancies.length, 1);
  for (let index = 0; index < catalogLength; index += 1) {
    catalogs.addRow({
      city: cities[index]?.name || '',
      vacancy: vacancies[index] ? vacancyLabel(vacancies[index]) : ''
    });
  }
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
