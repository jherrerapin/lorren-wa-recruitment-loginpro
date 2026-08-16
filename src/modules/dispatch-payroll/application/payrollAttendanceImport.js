import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import {
  registerManualAttendance,
  validateAttendanceTimelineAgainstAssignment
} from '../../dispatch-attendance/application/adminAttendance.js';
import { reviewAttendanceWorkdaySession } from '../../dispatch-attendance/application/attendanceAdminWorkday.js';
import { resolveDispatchAttendanceOperationalWindow } from '../../dispatch-attendance/application/registerArrival.js';
import { dispatchServiceDateKey } from '../../../services/dispatchDate.js';
import { ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } from '../../../services/dispatchOperationalCoverage.js';

const PAYROLL_IMPORT_ENTITY_TYPE = 'DISPATCH_PAYROLL_ATTENDANCE_IMPORT';
const PAYROLL_IMPORT_ACTION = 'PAYROLL_ATTENDANCE_IMPORTED';
const PAYROLL_IMPORT_REVERSE_ACTION = 'PAYROLL_ATTENDANCE_IMPORT_REVERSED';
const PAYROLL_IMPORT_REASON_PREFIX = 'Marcaciones importadas desde GeoVictoria · lote ';
const PAYROLL_IMPORT_COLUMN_MAPPING_PREFIX = '@column:';
export const PAYROLL_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const PAYROLL_IMPORT_MAX_WORKDAYS = 5000;
const PAYROLL_IMPORT_ALLOWED_MARK_TYPES = Object.freeze(['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);
const PAYROLL_IMPORT_HEADER_ALIASES = Object.freeze({
  document: ['documento', 'identificacion', 'identificador', 'cedula', 'numero documento', 'numero de documento', 'num documento', 'id empleado', 'rut', 'codigo empleado', 'codigo colaborador'],
  name: ['nombre', 'nombre completo', 'empleado', 'colaborador', 'trabajador', 'funcionario'],
  date: ['fecha', 'dia', 'fecha marcacion', 'fecha de marcacion', 'fecha turno'],
  datetime: ['fecha hora', 'fecha y hora', 'fecha marcacion hora', 'fecha hora marcacion', 'marcacion', 'timestamp'],
  time: ['hora', 'hora marcacion', 'hora de marcacion'],
  event: ['evento', 'tipo', 'tipo marcacion', 'tipo de marcacion', 'movimiento', 'marca', 'accion'],
  operation: ['operacion', 'punto operacion', 'punto de operacion', 'centro costo', 'centro de costo', 'sucursal', 'lugar'],
  arrival: ['entrada', 'ingreso', 'hora entrada', 'hora de entrada', 'entrada 1', 'primera entrada', 'entrada jornada', 'entrada de jornada', 'inicio jornada', 'entrada turno'],
  breakStart: ['inicio almuerzo', 'inicio de almuerzo', 'salida almuerzo', 'salida a almuerzo', 'inicio colacion', 'salida colacion', 'inicio descanso', 'salida descanso', 'salida a descanso', 'salida 1'],
  breakEnd: ['fin almuerzo', 'fin de almuerzo', 'regreso almuerzo', 'regreso de almuerzo', 'retorno almuerzo', 'retorno de almuerzo', 'entrada almuerzo', 'entrada de almuerzo', 'fin colacion', 'regreso colacion', 'retorno colacion', 'entrada 2'],
  departure: ['salida', 'egreso', 'hora salida', 'hora de salida', 'salida final', 'salida jornada', 'salida de jornada', 'salida turno', 'fin jornada', 'salida 2', 'ultima salida']
});

function normalizeString(value, maxLength = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

const IMPORT_ERROR_MESSAGES = Object.freeze({
  payroll_import_file_required: 'Selecciona un archivo Excel o CSV.',
  payroll_import_file_too_large: 'El archivo supera el límite de 8 MB.',
  payroll_import_file_invalid: 'No fue posible leer el archivo como Excel o CSV.',
  payroll_import_headers_unrecognized: 'No fue posible reconocer las columnas. Ajusta la correspondencia en la previsualización.',
  payroll_import_no_workdays: 'No se encontraron jornadas importables en el archivo.',
  payroll_import_too_many_workdays: 'El archivo contiene demasiadas jornadas para una sola importación.',
  payroll_import_batch_not_found: 'La importación ya no existe.',
  payroll_import_batch_already_reversed: 'La importación ya fue reversada.',
  payroll_import_preview_stale: 'La conciliación cambió desde la previsualización. Analiza el archivo nuevamente antes de importar.'
});

export function payrollAttendanceImportErrorMessage(code) {
  return IMPORT_ERROR_MESSAGES[String(code || '')] || null;
}

function foldImportText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeDocumentKey(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function cellScalar(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (value.result !== undefined) return cellScalar(value.result);
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part?.text || '').join('');
    if (value.hyperlink && value.text) return value.text;
  }
  return String(value);
}

function csvDelimiterScore(text, delimiter) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) count += 1;
  }
  return count;
}

function parseCsvMatrix(text) {
  const sample = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim()).slice(0, 5).join('\n');
  const delimiters = [';', ',', '\t'];
  const delimiter = delimiters
    .map((candidate) => ({ candidate, score: csvDelimiterScore(sample, candidate) }))
    .sort((left, right) => right.score - left.score)[0]?.candidate || ';';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
      continue;
    }
    if (!quoted && char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.some((value) => String(value).trim())) rows.push(row);
  return { rows, delimiter: delimiter === '\t' ? 'tab' : delimiter };
}

function aliasFieldForHeader(header) {
  const folded = foldImportText(header);
  if (!folded) return null;
  for (const [field, aliases] of Object.entries(PAYROLL_IMPORT_HEADER_ALIASES)) {
    if (aliases.some((alias) => foldImportText(alias) === folded)) return field;
  }
  return null;
}

function normalizedMapping(mapping = {}) {
  const result = {};
  for (const key of Object.keys(PAYROLL_IMPORT_HEADER_ALIASES)) {
    const value = normalizeString(mapping?.[key], 160);
    if (value) result[key] = value;
  }
  return result;
}

function manualMappingColumnIndex(value, foldedHeaders) {
  const text = normalizeString(value, 160);
  const indexMatch = text?.match(/^@column:(\d+)$/);
  if (indexMatch) {
    const index = Number(indexMatch[1]);
    return Number.isInteger(index) && index >= 0 && index < foldedHeaders.length ? index : -1;
  }
  return text ? foldedHeaders.indexOf(foldImportText(text)) : -1;
}

function detectHeaderRow(matrix, mapping = {}) {
  const desiredHeaders = new Set(Object.values(normalizedMapping(mapping))
    .filter((value) => !value.startsWith(PAYROLL_IMPORT_COLUMN_MAPPING_PREFIX))
    .map(foldImportText));
  const candidates = matrix.slice(0, 12).map((row, rowIndex) => {
    const cells = row.map(cellScalar);
    const aliases = cells.filter((cell) => aliasFieldForHeader(cell)).length;
    const mapped = cells.filter((cell) => desiredHeaders.has(foldImportText(cell))).length;
    const nonEmpty = cells.filter((cell) => String(cell ?? '').trim()).length;
    return { rowIndex, cells, score: mapped * 20 + aliases * 5 + Math.min(nonEmpty, 8) };
  });
  return candidates.sort((left, right) => right.score - left.score || left.rowIndex - right.rowIndex)[0] || { rowIndex: 0, cells: [], score: 0 };
}

function repeatedGeoVictoriaPunchColumns(foldedHeaders) {
  const entered = [];
  const exited = [];
  foldedHeaders.forEach((header, index) => {
    if (header === 'entro') entered.push(index);
    if (header === 'salio') exited.push(index);
  });
  if (entered.length !== 2 || exited.length !== 2) return null;
  if (!(entered[0] < exited[0] && exited[0] < entered[1] && entered[1] < exited[1])) return null;
  return {
    arrival: entered[0],
    breakStart: exited[0],
    breakEnd: entered[1],
    departure: exited[1]
  };
}

function buildColumnMap(headers, mapping = {}) {
  const manual = normalizedMapping(mapping);
  const foldedHeaders = headers.map((header) => foldImportText(cellScalar(header)));
  const columns = {};
  for (const field of Object.keys(PAYROLL_IMPORT_HEADER_ALIASES)) {
    if (manual[field]) {
      const manualIndex = manualMappingColumnIndex(manual[field], foldedHeaders);
      if (manualIndex >= 0) columns[field] = manualIndex;
      continue;
    }
    const index = headers.findIndex((header) => aliasFieldForHeader(cellScalar(header)) === field);
    if (index >= 0) columns[field] = index;
  }
  const repeatedPunches = repeatedGeoVictoriaPunchColumns(foldedHeaders);
  if (repeatedPunches) {
    for (const [field, index] of Object.entries(repeatedPunches)) {
      if (!manual[field]) columns[field] = index;
    }
  }
  return columns;
}

function importMappingMode(columns) {
  const dailyFields = ['arrival', 'breakStart', 'breakEnd', 'departure'];
  const eventFields = ['datetime', 'time', 'event'];
  if (dailyFields.some((field) => Number.isInteger(columns[field]))) return 'DAILY';
  if (eventFields.some((field) => Number.isInteger(columns[field]))) return 'EVENT';
  return Number.isInteger(columns.date) ? 'DAILY' : 'EVENT';
}

function importMappingFields(mode, columns = {}) {
  const operation = Number.isInteger(columns.operation) ? ['operation'] : [];
  if (mode === 'DAILY') {
    return ['document', 'name', 'date', 'arrival', 'breakStart', 'breakEnd', 'departure', ...operation];
  }
  if (Number.isInteger(columns.datetime)) {
    return ['document', 'name', 'datetime', 'event', ...operation];
  }
  return ['document', 'name', 'date', 'time', 'event', ...operation];
}

function excelSerialToDate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const milliseconds = Math.round((numeric - 25569) * 86_400_000);
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

function dateKeyFromDate(date) {
  return `${date.getUTCFullYear()}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())}`;
}

function timeKeyFromDate(date) {
  return `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:${twoDigits(date.getUTCSeconds())}`;
}

function validatedDateKey(yearValue, monthValue, dayValue) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return `${year}-${twoDigits(month)}-${twoDigits(day)}`;
}

function parseImportDateKey(value) {
  const scalar = cellScalar(value);
  if (scalar instanceof Date && !Number.isNaN(scalar.getTime())) return dateKeyFromDate(scalar);
  if (typeof scalar === 'number') {
    const date = excelSerialToDate(scalar);
    return date ? dateKeyFromDate(date) : null;
  }
  const text = String(scalar ?? '').trim();
  if (!text) return null;
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
  if (match) return validatedDateKey(match[1], match[2], match[3]);
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\D|$)/);
  if (match) return validatedDateKey(match[3], match[2], match[1]);
  return null;
}

function parseImportTime(value) {
  const scalar = cellScalar(value);
  if (scalar instanceof Date && !Number.isNaN(scalar.getTime())) return timeKeyFromDate(scalar);
  if (typeof scalar === 'number') {
    const fraction = ((scalar % 1) + 1) % 1;
    const totalSeconds = Math.round(fraction * 86_400) % 86_400;
    return `${twoDigits(Math.floor(totalSeconds / 3600))}:${twoDigits(Math.floor((totalSeconds % 3600) / 60))}:${twoDigits(totalSeconds % 60)}`;
  }
  const text = String(scalar ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  const match = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const meridiem = String(match[4] || '').replace(/[^apm]/gi, '').toLowerCase();
  if (minute > 59 || second > 59 || hour > 23) return null;
  if (meridiem.startsWith('p') && hour < 12) hour += 12;
  if (meridiem.startsWith('a') && hour === 12) hour = 0;
  return `${twoDigits(hour)}:${twoDigits(minute)}:${twoDigits(second)}`;
}

function parseImportDateTime(value, fallbackDate = null) {
  const scalar = cellScalar(value);
  if (scalar instanceof Date && !Number.isNaN(scalar.getTime())) return `${dateKeyFromDate(scalar)}T${timeKeyFromDate(scalar)}`;
  if (typeof scalar === 'number' && scalar >= 1) {
    const date = excelSerialToDate(scalar);
    return date ? `${dateKeyFromDate(date)}T${timeKeyFromDate(date)}` : null;
  }
  const dateKey = parseImportDateKey(scalar) || fallbackDate;
  const timeKey = parseImportTime(scalar);
  return dateKey && timeKey ? `${dateKey}T${timeKey}` : null;
}

function importEventKind(value) {
  const folded = foldImportText(value);
  if (!folded) return null;
  if (/(inicio|salida).*(almuerzo|colacion|descanso)|(almuerzo|colacion|descanso).*(inicio|salida)/.test(folded)) return 'BREAK_START';
  if (/(fin|regreso|retorno|entrada).*(almuerzo|colacion|descanso)|(almuerzo|colacion|descanso).*(fin|regreso|retorno|entrada)/.test(folded)) return 'BREAK_END';
  if (/^(entrada|ingreso|check in|inicio jornada)$/.test(folded)) return 'IN';
  if (/^(salida|egreso|check out|fin jornada)$/.test(folded)) return 'OUT';
  if (/entrada|ingreso/.test(folded)) return 'IN';
  if (/salida|egreso/.test(folded)) return 'OUT';
  return null;
}

function importIdentityKey(row) {
  const documentKey = normalizeDocumentKey(row.document);
  if (documentKey) return `D:${documentKey}`;
  const nameKey = foldImportText(row.name);
  return nameKey ? `N:${nameKey}` : null;
}

function importLocalToDate(value) {
  const text = normalizeString(value, 32);
  if (!text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text)) return null;
  const date = new Date(`${text}-05:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function exactMarkSignature(markType, value) {
  const date = value instanceof Date ? value : importLocalToDate(value);
  return date ? `${markType}|${date.getTime()}` : null;
}

function inferMarksForGroup(entries) {
  const sorted = [...entries].sort((left, right) => left.localDateTime.localeCompare(right.localDateTime));
  if (sorted.every((entry) => PAYROLL_IMPORT_ALLOWED_MARK_TYPES.includes(entry.eventKind))) {
    const unique = new Set(sorted.map((entry) => entry.eventKind));
    if (unique.size !== sorted.length) return null;
    return sorted.map((entry) => ({ markType: entry.eventKind, localDateTime: entry.localDateTime }));
  }
  if (sorted.length === 2) {
    if (sorted[0].eventKind === 'OUT' || sorted[1].eventKind === 'IN') return null;
    return [
      { markType: 'ARRIVAL', localDateTime: sorted[0].localDateTime },
      { markType: 'DEPARTURE', localDateTime: sorted[1].localDateTime }
    ];
  }
  if (sorted.length === 4) {
    const kinds = sorted.map((entry) => entry.eventKind);
    const compatible = kinds.every((kind, index) => !kind || kind === (index % 2 === 0 ? 'IN' : 'OUT'));
    if (!compatible) return null;
    return sorted.map((entry, index) => ({
      markType: ['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'][index],
      localDateTime: entry.localDateTime
    }));
  }
  return null;
}

async function matrixFromXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheets = workbook.worksheets.map((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map(cellScalar)));
    return { name: sheet.name, rows };
  }).filter((sheet) => sheet.rows.length);
  if (!sheets.length) throw new Error('payroll_import_file_invalid');
  return sheets;
}

function isZipBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function parseImportMapping(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return normalizedMapping(value);
  try {
    return normalizedMapping(JSON.parse(String(value)));
  } catch {
    return {};
  }
}

function buildImportRowsFromMatrix(matrix, mapping = {}, meta = {}) {
  const detected = detectHeaderRow(matrix, mapping);
  const headers = detected.cells.map((value) => String(cellScalar(value) ?? '').trim());
  const columns = buildColumnMap(headers, mapping);
  const mappingMode = importMappingMode(columns);
  const mappingFields = importMappingFields(mappingMode, columns);
  const hasIdentity = Number.isInteger(columns.document) || Number.isInteger(columns.name);
  const hasDaily = Number.isInteger(columns.date) && (Number.isInteger(columns.arrival) || Number.isInteger(columns.departure));
  const hasEvent = (Number.isInteger(columns.datetime) || (Number.isInteger(columns.date) && Number.isInteger(columns.time)));
  const needsMapping = !hasIdentity || (!hasDaily && !hasEvent);
  if (needsMapping) {
    return {
      ...meta,
      headers,
      headerRow: detected.rowIndex + 1,
      columns,
      mappingMode,
      mappingFields,
      workdays: [],
      needsMapping: true,
      message: mappingMode === 'DAILY'
        ? 'Este archivo tiene una fila por jornada. Asigna únicamente identidad, fecha, entrada, salida a almuerzo, regreso de almuerzo y salida de jornada.'
        : 'Este archivo tiene una fila por marcación. Asigna identidad, fecha/hora y tipo de marcación.'
    };
  }

  const sourceRows = matrix.slice(detected.rowIndex + 1);
  const workdays = [];
  const eventEntries = [];
  sourceRows.forEach((sourceRow, index) => {
    const rowNumber = detected.rowIndex + index + 2;
    const get = (field) => Number.isInteger(columns[field]) ? cellScalar(sourceRow[columns[field]]) : '';
    const base = {
      rowNumber,
      document: String(get('document') ?? '').trim(),
      name: String(get('name') ?? '').trim(),
      operation: String(get('operation') ?? '').trim()
    };
    if (!importIdentityKey(base)) return;

    if (hasDaily) {
      const dateKey = parseImportDateKey(get('date'));
      if (!dateKey) {
        workdays.push({ ...base, dateKey: null, marks: [], parseStatus: 'INVALID', message: 'Fecha no reconocida.' });
        return;
      }
      const marks = [
        ['ARRIVAL', 'arrival'],
        ['BREAK_START', 'breakStart'],
        ['BREAK_END', 'breakEnd'],
        ['DEPARTURE', 'departure']
      ].map(([markType, field]) => {
        const time = parseImportTime(get(field));
        return time ? { markType, localDateTime: `${dateKey}T${time}` } : null;
      }).filter(Boolean);
      if (!marks.length) {
        workdays.push({ ...base, dateKey, marks: [], parseStatus: 'INVALID', message: 'No se reconocieron horas de marcación.' });
        return;
      }
      workdays.push({ ...base, dateKey, marks, parseStatus: 'PARSED', sourceRows: [rowNumber] });
      return;
    }

    const dateKey = Number.isInteger(columns.date) ? parseImportDateKey(get('date')) : null;
    const localDateTime = Number.isInteger(columns.datetime)
      ? parseImportDateTime(get('datetime'), dateKey)
      : (dateKey && parseImportTime(get('time')) ? `${dateKey}T${parseImportTime(get('time'))}` : null);
    if (!localDateTime) {
      workdays.push({ ...base, dateKey, marks: [], parseStatus: 'INVALID', message: 'Fecha u hora no reconocida.' });
      return;
    }
    eventEntries.push({
      ...base,
      dateKey: localDateTime.slice(0, 10),
      localDateTime,
      eventKind: Number.isInteger(columns.event) ? importEventKind(get('event')) : null
    });
  });

  if (hasEvent) {
    const groups = new Map();
    for (const entry of eventEntries) {
      const key = `${importIdentityKey(entry)}|${entry.dateKey}|${foldImportText(entry.operation)}`;
      const current = groups.get(key) || [];
      current.push(entry);
      groups.set(key, current);
    }
    for (const entries of groups.values()) {
      const marks = inferMarksForGroup(entries);
      const base = entries[0];
      workdays.push({
        document: base.document,
        name: base.name,
        operation: base.operation,
        dateKey: base.dateKey,
        marks: marks || [],
        parseStatus: marks ? 'PARSED' : 'AMBIGUOUS',
        message: marks ? null : `Se detectaron ${entries.length} golpes de reloj que no se pueden clasificar con seguridad.`,
        sourceRows: entries.map((entry) => entry.rowNumber)
      });
    }
  }

  return {
    ...meta,
    headers,
    headerRow: detected.rowIndex + 1,
    columns,
    mappingMode,
    mappingFields,
    needsMapping: false,
    workdays: workdays.slice(0, PAYROLL_IMPORT_MAX_WORKDAYS + 1)
  };
}

export async function parsePayrollAttendanceImportFile(file, options = {}) {
  if (!file?.buffer?.length) throw new Error('payroll_import_file_required');
  if (file.buffer.length > PAYROLL_IMPORT_MAX_BYTES) throw new Error('payroll_import_file_too_large');
  const mapping = parseImportMapping(options.mapping);
  try {
    if (isZipBuffer(file.buffer) || /\.xlsx$/i.test(String(file.originalname || ''))) {
      const sheets = await matrixFromXlsx(file.buffer);
      const ranked = sheets.map((sheet) => ({ sheet, detected: detectHeaderRow(sheet.rows, mapping) }))
        .sort((left, right) => right.detected.score - left.detected.score);
      const selected = ranked[0]?.sheet;
      return buildImportRowsFromMatrix(selected.rows, mapping, { format: 'XLSX', sheetName: selected.name, delimiter: null });
    }
    const text = file.buffer.toString('utf8');
    const csv = parseCsvMatrix(text);
    return buildImportRowsFromMatrix(csv.rows, mapping, { format: 'CSV', sheetName: null, delimiter: csv.delimiter });
  } catch (error) {
    if (String(error?.message || '').startsWith('payroll_import_')) throw error;
    throw new Error('payroll_import_file_invalid');
  }
}

function workerMatchesForWorkday(workday, workersByDocument, workersByName) {
  const documentKey = normalizeDocumentKey(workday.document);
  if (documentKey) return workersByDocument.get(documentKey) || [];
  const nameKey = foldImportText(workday.name);
  if (!nameKey) return [];
  return workersByName.get(nameKey) || [];
}

function assignmentOperationKey(assignment) {
  const request = assignment?.serviceRequest || {};
  return [request.operationPointName, request.operationPoint?.name, request.clientName]
    .map(foldImportText)
    .filter(Boolean);
}

function candidateTimeline(workday) {
  const byType = new Map(workday.marks.map((mark) => [mark.markType, importLocalToDate(mark.localDateTime)]));
  return {
    arrivalAt: byType.get('ARRIVAL') || null,
    breakStartAt: byType.get('BREAK_START') || null,
    breakEndAt: byType.get('BREAK_END') || null,
    departureAt: byType.get('DEPARTURE') || null
  };
}

function addImportLocalDays(localDateTime, days) {
  const text = normalizeString(localDateTime, 32);
  const match = text?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})$/);
  if (!match) return localDateTime;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return localDateTime;
  date.setUTCDate(date.getUTCDate() + days);
  return `${dateKeyFromDate(date)}T${match[2]}`;
}

function resolveOvernightWorkdayMarks(workday, assignment) {
  if (!workday?.dateKey || !Array.isArray(workday.marks) || !workday.marks.length) return workday;
  let operational;
  try {
    operational = resolveDispatchAttendanceOperationalWindow(
      assignment?.serviceRequest,
      assignment?.attendanceSession || null
    );
  } catch {
    return workday;
  }
  if (!operational.overnight) return workday;

  let previousMoment = null;
  const marks = workday.marks.map((mark) => {
    let localDateTime = mark.localDateTime;
    let moment = importLocalToDate(localDateTime);
    const usesServiceDate = localDateTime?.slice(0, 10) === workday.dateKey;
    if (mark.markType !== 'ARRIVAL' && usesServiceDate && moment) {
      const shiftedLocalDateTime = addImportLocalDays(localDateTime, 1);
      const shiftedMoment = importLocalToDate(shiftedLocalDateTime);
      const needsRollover = moment.getTime() < operational.recordingOpensAt.getTime()
        || (previousMoment && moment.getTime() < previousMoment.getTime());
      const shiftedFits = shiftedMoment
        && shiftedMoment.getTime() < operational.continuityClosesAt.getTime()
        && (!previousMoment || shiftedMoment.getTime() >= previousMoment.getTime());
      if (needsRollover && shiftedFits) {
        localDateTime = shiftedLocalDateTime;
        moment = shiftedMoment;
      }
    }
    if (moment) previousMoment = moment;
    return { ...mark, localDateTime };
  });
  return { ...workday, marks };
}

function workdayObservedSpan(workday) {
  const moments = (Array.isArray(workday?.marks) ? workday.marks : [])
    .map((mark) => importLocalToDate(mark.localDateTime))
    .filter(Boolean);
  if (!moments.length) return null;
  const timestamps = moments.map((moment) => moment.getTime());
  return {
    startAt: new Date(Math.min(...timestamps)),
    endAt: new Date(Math.max(...timestamps))
  };
}

function workdayOverlapsExpectedSchedule(workday, validation) {
  const span = workdayObservedSpan(workday);
  const expectedStartAt = validation?.expected?.expectedStartAt || null;
  const expectedEndAt = validation?.expected?.expectedEndAt
    || validation?.operational?.operationalEndAt
    || null;
  if (!span || !expectedStartAt || !expectedEndAt) return false;
  return span.startAt.getTime() < expectedEndAt.getTime()
    && span.endAt.getTime() >= expectedStartAt.getTime();
}

function compatibleAssignmentCandidate(workday, assignment) {
  const resolvedWorkday = resolveOvernightWorkdayMarks(workday, assignment);
  try {
    const validation = validateAttendanceTimelineAgainstAssignment(
      assignment.serviceRequest,
      candidateTimeline(resolvedWorkday),
      assignment.attendanceSession || null
    );
    if (!workdayOverlapsExpectedSchedule(resolvedWorkday, validation)) return null;
    return { assignment, resolvedWorkday, validation };
  } catch {
    return null;
  }
}

function existingMarkSignatures(session) {
  return (Array.isArray(session?.marks) ? session.marks : [])
    .map((mark) => {
      const moment = mark?.clientCapturedAt || mark?.serverReceivedAt;
      const date = moment instanceof Date ? moment : new Date(moment || Number.NaN);
      return Number.isNaN(date.getTime()) ? null : exactMarkSignature(mark.markType, date);
    })
    .filter(Boolean)
    .sort();
}

function candidateMarkSignatures(workday) {
  return workday.marks.map((mark) => exactMarkSignature(mark.markType, mark.localDateTime)).filter(Boolean).sort();
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function analyzePayrollAttendanceImport(prisma, parsed, options = {}) {
  if (parsed.needsMapping) {
    return {
      ...parsed,
      summary: { parsedWorkdays: 0, ready: 0, replacements: 0, duplicates: 0, unresolved: 0, invalid: 0 },
      rows: []
    };
  }
  if (parsed.workdays.length > PAYROLL_IMPORT_MAX_WORKDAYS) throw new Error('payroll_import_too_many_workdays');
  const validDates = parsed.workdays.map((workday) => workday.dateKey).filter(Boolean).sort();
  const from = validDates[0] || null;
  const to = validDates.at(-1) || null;
  const includeTest = options.includeTest === true;
  const [workers, assignments] = await Promise.all([
    prisma.dispatchWorker.findMany({
      where: {
        operationalStatus: { not: 'ELIMINADO' },
        ...(includeTest ? {} : { isTestProfile: false })
      },
      select: { id: true, fullName: true, documentNumber: true, isTestProfile: true }
    }),
    from && to ? prisma.dispatchAssignment.findMany({
      where: {
        status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] },
        serviceRequest: {
          serviceDate: {
            gte: new Date(`${from}T00:00:00.000Z`),
            lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000)
          }
        }
      },
      include: {
        serviceRequest: { include: { operationPoint: true } },
        attendanceSession: {
          include: {
            marks: { orderBy: { serverReceivedAt: 'asc' } }
          }
        }
      }
    }) : []
  ]);

  const workersByDocument = new Map();
  const workersByName = new Map();
  for (const worker of workers) {
    const documentKey = normalizeDocumentKey(worker.documentNumber);
    if (documentKey) workersByDocument.set(documentKey, [...(workersByDocument.get(documentKey) || []), worker]);
    const nameKey = foldImportText(worker.fullName);
    if (nameKey) workersByName.set(nameKey, [...(workersByName.get(nameKey) || []), worker]);
  }
  const assignmentsByWorkerDate = new Map();
  for (const assignment of assignments) {
    const dateKey = dispatchServiceDateKey(assignment.serviceRequest?.serviceDate);
    if (!dateKey) continue;
    const key = `${assignment.workerId}|${dateKey}`;
    assignmentsByWorkerDate.set(key, [...(assignmentsByWorkerDate.get(key) || []), assignment]);
  }

  const rows = parsed.workdays.map((workday) => {
    const displayIdentity = normalizeString(workday.name, 120) || (workday.document ? `Documento …${normalizeDocumentKey(workday.document).slice(-4)}` : 'Fila sin identidad');
    if (workday.parseStatus !== 'PARSED' || !workday.dateKey || !workday.marks.length) {
      return { ...workday, displayIdentity, status: 'INVALID', message: workday.message || 'La fila no se pudo interpretar.' };
    }
    const workerMatches = workerMatchesForWorkday(workday, workersByDocument, workersByName);
    if (workerMatches.length !== 1) {
      return {
        ...workday,
        displayIdentity,
        status: 'UNRESOLVED',
        message: workerMatches.length ? 'La identidad coincide con más de un auxiliar.' : 'No se encontró un auxiliar único para esta identidad.'
      };
    }
    const worker = workerMatches[0];
    let candidates = assignmentsByWorkerDate.get(`${worker.id}|${workday.dateKey}`) || [];
    const operationKey = foldImportText(workday.operation);
    if (operationKey && candidates.length > 1) {
      const narrowed = candidates.filter((assignment) => assignmentOperationKey(assignment).includes(operationKey));
      if (narrowed.length) candidates = narrowed;
    }
    if (!candidates.length) {
      return {
        ...workday,
        displayIdentity: worker.fullName,
        workerId: worker.id,
        status: 'UNRESOLVED',
        message: 'No existe una asignación activa para esa fecha.'
      };
    }

    let assignment = candidates[0];
    let resolvedWorkday = null;
    let timelineValidation = null;
    if (candidates.length > 1) {
      const compatible = candidates
        .map((candidateAssignment) => compatibleAssignmentCandidate(workday, candidateAssignment))
        .filter(Boolean);
      if (compatible.length !== 1) {
        return {
          ...workday,
          displayIdentity: worker.fullName,
          workerId: worker.id,
          status: 'UNRESOLVED',
          message: compatible.length
            ? `Lórren encontró ${candidates.length} asignaciones activas para este auxiliar en esa fecha. No son filas duplicadas del archivo: más de una coincide con las horas y no se puede elegir una sola con seguridad.`
            : `Lórren encontró ${candidates.length} asignaciones activas para este auxiliar en esa fecha. No son filas duplicadas del archivo: ninguna coincide de forma segura con las horas detectadas.`
        };
      }
      assignment = compatible[0].assignment;
      resolvedWorkday = compatible[0].resolvedWorkday;
      timelineValidation = compatible[0].validation;
    }

    if (assignment.serviceRequest?.operationPoint?.manualAttendanceAllowed !== true) {
      return {
        ...workday,
        displayIdentity: worker.fullName,
        workerId: worker.id,
        assignmentId: assignment.id,
        status: 'UNRESOLVED',
        message: 'El punto de operación no permite marcación administrativa.'
      };
    }

    if (!resolvedWorkday) resolvedWorkday = resolveOvernightWorkdayMarks(workday, assignment);
    if (!timelineValidation) {
      try {
        timelineValidation = validateAttendanceTimelineAgainstAssignment(
          assignment.serviceRequest,
          candidateTimeline(resolvedWorkday),
          assignment.attendanceSession || null
        );
      } catch {
        return {
          ...resolvedWorkday,
          displayIdentity: worker.fullName,
          workerId: worker.id,
          assignmentId: assignment.id,
          status: 'UNRESOLVED',
          message: 'Las horas detectadas no caben de forma segura en la ventana operacional de esta asignación.'
        };
      }
    }

    const session = assignment.attendanceSession || null;
    const existing = existingMarkSignatures(session);
    const candidate = candidateMarkSignatures(resolvedWorkday);
    if (existing.length && sameStringArray(existing, candidate)) {
      return {
        ...resolvedWorkday,
        displayIdentity: worker.fullName,
        workerId: worker.id,
        assignmentId: assignment.id,
        sessionId: session?.id || null,
        status: 'DUPLICATE',
        message: 'La jornada ya contiene exactamente estas marcaciones.'
      };
    }
    const hasExistingAttendance = existing.length > 0 || Boolean(session?.arrivalReportedAt || session?.departureReportedAt);
    if (hasExistingAttendance) {
      return {
        ...resolvedWorkday,
        displayIdentity: worker.fullName,
        workerId: worker.id,
        assignmentId: assignment.id,
        sessionId: session.id,
        status: 'READY',
        replaceExisting: true,
        message: null
      };
    }
    return {
      ...resolvedWorkday,
      displayIdentity: worker.fullName,
      workerId: worker.id,
      assignmentId: assignment.id,
      status: 'READY',
      replaceExisting: false,
      message: null
    };
  });

  const summary = {
    parsedWorkdays: parsed.workdays.length,
    ready: rows.filter((row) => row.status === 'READY').length,
    replacements: rows.filter((row) => row.status === 'READY' && row.replaceExisting).length,
    duplicates: rows.filter((row) => row.status === 'DUPLICATE').length,
    unresolved: rows.filter((row) => row.status === 'UNRESOLVED').length,
    invalid: rows.filter((row) => row.status === 'INVALID').length,
    marksReady: rows.filter((row) => row.status === 'READY').reduce((sum, row) => sum + row.marks.length, 0)
  };
  return { ...parsed, rows, summary, dateFrom: from, dateTo: to };
}

function payrollImportAnalysisFingerprint(analysis) {
  const rows = (analysis.rows || []).map((row) => ({
    sourceRows: row.sourceRows || [row.rowNumber || null],
    dateKey: row.dateKey || null,
    status: row.status || null,
    workerId: row.workerId || null,
    assignmentId: row.assignmentId || null,
    sessionId: row.sessionId || null,
    replaceExisting: row.replaceExisting === true,
    marks: (row.marks || []).map((mark) => exactMarkSignature(mark.markType, mark.localDateTime)).filter(Boolean)
  }));
  return createHash('sha256').update(JSON.stringify({
    format: analysis.format || null,
    sheetName: analysis.sheetName || null,
    delimiter: analysis.delimiter || null,
    columns: analysis.columns || {},
    rows
  })).digest('hex');
}

function workdayWriterInput(row, auditActor, batchId) {
  const marks = new Map(row.marks.map((mark) => [mark.markType, mark.localDateTime]));
  return {
    assignmentId: row.assignmentId,
    arrivalReportedAt: marks.get('ARRIVAL'),
    breakStartAt: marks.get('BREAK_START'),
    breakEndAt: marks.get('BREAK_END'),
    departureReportedAt: marks.get('DEPARTURE'),
    reason: `${PAYROLL_IMPORT_REASON_PREFIX}${batchId}`,
    notes: null,
    actorUsername: auditActor.actorUsername || 'operaciones',
    actorRole: auditActor.actorRole || null
  };
}

async function importedMarksForRow(prisma, sessionId, row) {
  const session = await prisma.dispatchAttendanceSession.findUnique({
    where: { id: sessionId },
    include: { marks: { orderBy: { serverReceivedAt: 'asc' } } }
  });
  const expected = new Set(candidateMarkSignatures(row));
  return (session?.marks || [])
    .filter((mark) => {
      const moment = mark?.clientCapturedAt || mark?.serverReceivedAt;
      const date = moment instanceof Date ? moment : new Date(moment || Number.NaN);
      return !Number.isNaN(date.getTime()) && expected.has(exactMarkSignature(mark.markType, date));
    })
    .map((mark) => {
      const moment = mark?.clientCapturedAt || mark?.serverReceivedAt;
      const date = moment instanceof Date ? moment : new Date(moment || Number.NaN);
      return { id: mark.id, signature: exactMarkSignature(mark.markType, date) };
    });
}

async function writeImportAudit(prisma, data) {
  const auditActor = data.actor || {};
  return prisma.devAuditEvent.create({
    data: {
      entityType: PAYROLL_IMPORT_ENTITY_TYPE,
      entityId: data.batchId,
      entityLabel: 'Importación de marcaciones GeoVictoria',
      action: data.action,
      actorUserId: auditActor.actorUserId || null,
      actorUsername: auditActor.actorUsername || null,
      actorRole: auditActor.actorRole || null,
      actorSource: 'payroll-geovictoria-import',
      ipAddress: auditActor.ipAddress || null,
      userAgent: auditActor.userAgent || null,
      toValue: data.toValue || null,
      metadata: data.metadata || null
    }
  });
}

export async function commitPayrollAttendanceImport(prisma, file, input = {}, dependencies = {}) {
  const attendanceWriter = dependencies.attendanceWriter || registerManualAttendance;
  const workdayReviewer = dependencies.workdayReviewer || reviewAttendanceWorkdaySession;
  const parsed = await parsePayrollAttendanceImportFile(file, { mapping: input.mapping });
  const analysis = await analyzePayrollAttendanceImport(prisma, parsed, { includeTest: input.includeTest === true });
  if (analysis.needsMapping) throw new Error('payroll_import_headers_unrecognized');
  const currentFingerprint = payrollImportAnalysisFingerprint(analysis);
  if (!input.previewFingerprint || input.previewFingerprint !== currentFingerprint) {
    throw new Error('payroll_import_preview_stale');
  }
  const readyRows = analysis.rows.filter((row) => row.status === 'READY');
  if (!readyRows.length) throw new Error('payroll_import_no_workdays');
  const batchId = randomUUID();
  const importedWorkdays = [];
  const failures = [];
  for (const row of readyRows) {
    try {
      if (row.replaceExisting) {
        await workdayReviewer(prisma, {
          sessionId: row.sessionId,
          action: 'CLEAR',
          actorUsername: input.actor?.actorUsername || 'operaciones',
          actorRole: input.actor?.actorRole || null,
          now: input.now instanceof Date ? input.now : new Date()
        });
      }
      const session = await attendanceWriter(prisma, workdayWriterInput(row, input.actor || {}, batchId));
      const importedMarks = await importedMarksForRow(prisma, session.id, row);
      if (importedMarks.length !== row.marks.length) throw new Error('payroll_import_mark_capture_mismatch');
      importedWorkdays.push({
        sessionId: session.id,
        assignmentId: row.assignmentId,
        marks: importedMarks,
        replaced: row.replaceExisting === true
      });
    } catch (error) {
      failures.push({ rowNumber: row.sourceRows?.[0] || row.rowNumber || null, code: normalizeString(error?.message, 120) || 'payroll_import_write_failed' });
    }
  }
  if (!importedWorkdays.length) throw new Error(failures[0]?.code || 'payroll_import_no_workdays');
  const summary = {
    status: failures.length ? 'PARTIAL' : 'ACTIVE',
    format: analysis.format,
    dateFrom: analysis.dateFrom,
    dateTo: analysis.dateTo,
    parsedWorkdays: analysis.summary.parsedWorkdays,
    importedWorkdays: importedWorkdays.length,
    importedMarks: importedWorkdays.reduce((sum, workday) => sum + workday.marks.length, 0),
    replacedWorkdays: importedWorkdays.filter((workday) => workday.replaced === true).length,
    duplicates: analysis.summary.duplicates,
    unresolved: analysis.summary.unresolved,
    invalid: analysis.summary.invalid,
    failed: failures.length
  };
  await writeImportAudit(prisma, {
    batchId,
    action: PAYROLL_IMPORT_ACTION,
    actor: input.actor,
    toValue: summary,
    metadata: {
      version: 1,
      summary,
      source: 'GEOVICTORIA',
      workdays: importedWorkdays,
      failures: failures.map((failure) => ({ rowNumber: failure.rowNumber, code: failure.code }))
    }
  });
  return { batchId, summary };
}

function batchState(events) {
  const imported = events.find((event) => event.action === PAYROLL_IMPORT_ACTION) || null;
  const reversals = events.filter((event) => event.action === PAYROLL_IMPORT_REVERSE_ACTION);
  const latestReversal = reversals[0] || null;
  return { imported, latestReversal };
}

export async function loadRecentPayrollAttendanceImports(prisma, limit = 20) {
  const events = await prisma.devAuditEvent.findMany({
    where: {
      entityType: PAYROLL_IMPORT_ENTITY_TYPE,
      action: { in: [PAYROLL_IMPORT_ACTION, PAYROLL_IMPORT_REVERSE_ACTION] }
    },
    orderBy: { createdAt: 'desc' },
    take: Math.max(20, Math.min(200, limit * 5))
  });
  const grouped = new Map();
  for (const event of events) {
    if (!event.entityId) continue;
    grouped.set(event.entityId, [...(grouped.get(event.entityId) || []), event]);
  }
  return [...grouped.entries()].map(([batchId, batchEvents]) => {
    const { imported, latestReversal } = batchState(batchEvents);
    if (!imported) return null;
    const summary = imported.metadata?.summary || imported.toValue || {};
    const reverseSummary = latestReversal?.metadata?.summary || latestReversal?.toValue || null;
    return {
      batchId,
      createdAt: imported.createdAt,
      actorUsername: imported.actorUsername || null,
      format: summary.format || '—',
      dateFrom: summary.dateFrom || null,
      dateTo: summary.dateTo || null,
      importedWorkdays: Number(summary.importedWorkdays || 0),
      importedMarks: Number(summary.importedMarks || 0),
      status: reverseSummary?.status || summary.status || 'ACTIVE',
      canReverse: reverseSummary?.status !== 'REVERSED'
    };
  }).filter(Boolean).slice(0, limit);
}

export async function reversePayrollAttendanceImportBatch(prisma, batchId, input = {}, dependencies = {}) {
  const workdayReviewer = dependencies.workdayReviewer || reviewAttendanceWorkdaySession;
  const normalizedBatchId = normalizeString(batchId, 120);
  if (!normalizedBatchId) throw new Error('payroll_import_batch_not_found');
  const events = await prisma.devAuditEvent.findMany({
    where: { entityType: PAYROLL_IMPORT_ENTITY_TYPE, entityId: normalizedBatchId },
    orderBy: { createdAt: 'desc' }
  });
  const { imported, latestReversal } = batchState(events);
  if (!imported) throw new Error('payroll_import_batch_not_found');
  if ((latestReversal?.metadata?.summary?.status || latestReversal?.toValue?.status) === 'REVERSED') {
    throw new Error('payroll_import_batch_already_reversed');
  }
  const workdays = Array.isArray(imported.metadata?.workdays) ? imported.metadata.workdays : [];
  let reversedWorkdays = 0;
  let alreadyMissing = 0;
  let conflicts = 0;
  for (const workday of workdays) {
    const session = await prisma.dispatchAttendanceSession.findUnique({
      where: { id: workday.sessionId },
      include: {
        marks: { orderBy: { serverReceivedAt: 'asc' } },
        reviews: { where: { createdAt: { gt: imported.createdAt } }, select: { id: true }, take: 1 }
      }
    });
    if (!session) {
      alreadyMissing += 1;
      continue;
    }
    const importedMarks = Array.isArray(workday.marks) ? workday.marks : [];
    const expectedById = new Map(importedMarks.map((mark) => [mark.id, mark.signature]));
    const currentById = new Map((session.marks || []).map((mark) => {
      const moment = mark?.clientCapturedAt || mark?.serverReceivedAt;
      const date = moment instanceof Date ? moment : new Date(moment || Number.NaN);
      return [mark.id, exactMarkSignature(mark.markType, date)];
    }));
    const anyImportedLeft = [...expectedById.keys()].some((id) => currentById.has(id));
    if (!anyImportedLeft && currentById.size === 0) {
      alreadyMissing += 1;
      continue;
    }
    if (!anyImportedLeft || (Array.isArray(session.reviews) && session.reviews.length)) {
      conflicts += 1;
      continue;
    }
    const exact = expectedById.size === currentById.size
      && [...expectedById.entries()].every(([id, signature]) => currentById.get(id) === signature);
    if (!exact) {
      conflicts += 1;
      continue;
    }
    await workdayReviewer(prisma, {
      sessionId: session.id,
      action: 'CLEAR',
      actorUsername: input.actor?.actorUsername || 'operaciones',
      actorRole: input.actor?.actorRole || null,
      now: input.now instanceof Date ? input.now : new Date()
    });
    reversedWorkdays += 1;
  }
  const summary = {
    status: conflicts ? 'PARTIAL' : 'REVERSED',
    reversedWorkdays,
    conflicts,
    alreadyMissing,
    totalWorkdays: workdays.length
  };
  await writeImportAudit(prisma, {
    batchId: normalizedBatchId,
    action: PAYROLL_IMPORT_REVERSE_ACTION,
    actor: input.actor,
    toValue: summary,
    metadata: { version: 1, summary }
  });
  return summary;
}

export function buildPayrollAttendanceImportPreview(analysis) {
  return {
    ok: true,
    previewFingerprint: analysis.needsMapping ? null : payrollImportAnalysisFingerprint(analysis),
    format: analysis.format,
    sheetName: analysis.sheetName,
    delimiter: analysis.delimiter,
    headers: analysis.headers,
    columns: analysis.columns,
    mappingMode: analysis.mappingMode || null,
    mappingFields: Array.isArray(analysis.mappingFields) ? analysis.mappingFields : [],
    needsMapping: analysis.needsMapping,
    message: analysis.message || null,
    dateFrom: analysis.dateFrom || null,
    dateTo: analysis.dateTo || null,
    summary: analysis.summary,
    rows: (analysis.rows || [])
      .filter((row) => row.status !== 'READY')
      .slice(0, 50)
      .map((row) => ({
        rowNumber: row.sourceRows?.[0] || row.rowNumber || null,
        identity: row.displayIdentity || 'Fila',
        dateKey: row.dateKey || null,
        status: row.status,
        message: row.message || null
      }))
  };
}
