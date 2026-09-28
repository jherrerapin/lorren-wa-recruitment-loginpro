import ExcelJS from 'exceljs';
import { loadAttendanceAdminBoard } from './adminAttendance.js';
import { loadPayrollReport } from '../../dispatch-payroll/application/payrollReport.js';
import { PAYROLL_CONCEPT_CODES } from '../../dispatch-payroll/domain/payrollConceptEngine.js';

const HEADER_FILL = 'FF1E2D3D';
const HEADER_TEXT = 'FFFFFFFF';
const SUBHEADER_FILL = 'FFE6F4F1';
const BORDER = 'FFE1E4E8';

function normalizeString(value, maxLength = 300) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeStringList(value, maxLength = 300) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source
    .flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
    .map((item) => normalizeString(item, maxLength))
    .filter(Boolean))];
}

function identityDocument(source = {}) {
  return [source.documentType, source.documentNumber].filter(Boolean).join(' ') || 'Sin documento';
}

export function attendanceExportWorkerKey(source = {}) {
  const name = normalizeString(source.workerName || source.fullName, 240) || 'Auxiliar sin nombre';
  return `${name}|${identityDocument(source)}`;
}

function uniqueText(values = []) {
  return [...new Set(values.map((value) => normalizeString(value, 500)).filter(Boolean))].join(' · ');
}

function selectedBoardRows(board, workerKeys = []) {
  const selected = new Set(normalizeStringList(workerKeys, 500));
  const rows = Array.isArray(board?.rows) ? board.rows : [];
  return selected.size ? rows.filter((row) => selected.has(attendanceExportWorkerKey(row))) : rows;
}

function markingText(markings, field) {
  const values = markings.map((marking) => normalizeString(marking?.[field], 300)).filter(Boolean);
  return values.length ? values.join(' | ') : 'Sin registro';
}

function correctionText(markings) {
  const values = markings.flatMap((marking) => (Array.isArray(marking?.corrections) ? marking.corrections : []))
    .map((correction) => {
      const mark = normalizeString(correction?.markTypeLabel, 120) || 'Marcación';
      const previous = normalizeString(correction?.previousLabel, 160) || 'Sin dato';
      const next = normalizeString(correction?.newLabel, 160) || 'Sin dato';
      const reason = normalizeString(correction?.reason, 300) || 'Sin observación';
      return `${mark}: ${previous} → ${next}. ${reason}`;
    });
  return values.length ? values.join(' | ') : '';
}

export function buildAttendanceFilteredDailyRows(boardRows = [], payrollReport = {}) {
  const payrollByWorker = new Map((payrollReport?.rows || []).map((row) => [attendanceExportWorkerKey(row), row]));
  const groups = new Map();

  for (const boardRow of boardRows) {
    const workerKey = attendanceExportWorkerKey(boardRow);
    const dateKey = normalizeString(boardRow?.serviceDateIso, 10);
    if (!dateKey) continue;
    const key = `${workerKey}|${dateKey}`;
    const current = groups.get(key) || { workerKey, dateKey, boardRows: [] };
    current.boardRows.push(boardRow);
    groups.set(key, current);
  }

  return [...groups.values()]
    .map((group) => {
      const boardRow = group.boardRows[0] || {};
      const payrollRow = payrollByWorker.get(group.workerKey) || null;
      const day = payrollRow?.daily?.find((item) => item?.dateKey === group.dateKey) || null;
      const selectedSessionIds = new Set(group.boardRows.map((row) => row?.sessionId).filter(Boolean));
      const markings = (day?.markings || []).filter((marking) => (
        !selectedSessionIds.size || selectedSessionIds.has(marking?.sessionId)
      ));

      return {
        Fecha: group.dateKey,
        Documento: identityDocument(boardRow),
        Auxiliar: boardRow.workerName || payrollRow?.fullName || 'Auxiliar sin nombre',
        Ciudad: uniqueText(group.boardRows.map((row) => row.cityName)),
        Cliente: uniqueText(group.boardRows.map((row) => row.clientName)),
        Operacion: uniqueText(group.boardRows.map((row) => row.operationPointName)),
        EstadoAsistencia: uniqueText(group.boardRows.map((row) => row.statusLabel)),
        Horario: uniqueText(group.boardRows.map((row) => row.scheduleLabel)),
        Entrada: markingText(markings, 'arrivalLabel'),
        InicioAlmuerzo: markingText(markings, 'breakStartLabel'),
        FinAlmuerzo: markingText(markings, 'breakEndLabel'),
        Salida: markingText(markings, 'departureLabel'),
        Correcciones: correctionText(markings),
        TotalTrabajado: Number(day?.totalHours || 0),
        HorasOrdinarias: Number(day?.ordinaryHours || 0),
        HorasExtraTotal: Number(day?.overtimeHours || 0),
        Domingo: day?.isRestDay === true ? 'Sí' : 'No',
        Festivo: day?.isHoliday === true ? 'Sí' : 'No',
        ...Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, Number(day?.conceptHours?.[code] || 0)]))
      };
    })
    .sort((left, right) => left.Fecha.localeCompare(right.Fecha) || left.Auxiliar.localeCompare(right.Auxiliar, 'es'));
}

function worksheetColumns() {
  return [
    ['Fecha', 13], ['Documento', 18], ['Auxiliar', 32], ['Ciudad', 18], ['Cliente', 24], ['Operacion', 28],
    ['EstadoAsistencia', 22], ['Horario', 20], ['Entrada', 24], ['InicioAlmuerzo', 24], ['FinAlmuerzo', 24], ['Salida', 24],
    ['Correcciones', 42], ['TotalTrabajado', 16], ['HorasOrdinarias', 16], ['HorasExtraTotal', 16], ['Domingo', 11], ['Festivo', 11],
    ...PAYROLL_CONCEPT_CODES.map((code) => [code, 12])
  ].map(([key, width]) => ({ key, header: key, width }));
}

export function buildAttendanceFilteredWorkbook(rows = [], range = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lórren · LoginPro';
  workbook.company = 'LoginPro Service';
  workbook.title = 'Asistencia filtrada por día';

  const sheet = workbook.addWorksheet('Asistencia filtrada');
  sheet.columns = worksheetColumns();
  const lastColumn = sheet.getColumn(sheet.columnCount).letter;
  sheet.spliceRows(1, 0, [], []);
  sheet.mergeCells(`A1:${lastColumn}1`);
  sheet.mergeCells(`A2:${lastColumn}2`);
  sheet.getCell('A1').value = 'Asistencia filtrada · detalle diario';
  sheet.getCell('A2').value = `Periodo ${range.from || '—'} a ${range.to || '—'} · ${rows.length} registro(s) diarios`;

  sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: HEADER_TEXT } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  sheet.getCell('A2').font = { bold: true, color: { argb: 'FF0D7A6B' } };
  sheet.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBHEADER_FILL } };
  sheet.getRow(3).font = { bold: true, color: { argb: HEADER_TEXT } };
  sheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  sheet.views = [{ state: 'frozen', ySplit: 3, xSplit: 3 }];
  sheet.autoFilter = { from: 'A3', to: `${lastColumn}3` };

  for (const row of rows) {
    const excelRow = sheet.addRow(row);
    excelRow.alignment = { vertical: 'top', wrapText: true };
  }

  sheet.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: BORDER } },
        left: { style: 'thin', color: { argb: BORDER } },
        bottom: { style: 'thin', color: { argb: BORDER } },
        right: { style: 'thin', color: { argb: BORDER } }
      };
      if (rowNumber > 3 && rowNumber % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      }
    });
  });

  return workbook;
}

export async function buildAttendanceFilteredExport(prisma, input = {}, options = {}) {
  const board = await loadAttendanceAdminBoard(prisma, {
    from: input.from,
    to: input.to,
    status: input.status,
    client: input.client,
    q: input.q
  });
  const boardRows = selectedBoardRows(board, input.workerKey);
  const payrollReport = await loadPayrollReport(prisma, {
    periodType: 'CUSTOM',
    from: board.range.from,
    to: board.range.to
  }, {
    allowTestData: options.allowTestData === true
  });
  const rows = buildAttendanceFilteredDailyRows(boardRows, payrollReport);
  return {
    workbook: buildAttendanceFilteredWorkbook(rows, board.range),
    range: board.range,
    rows
  };
}
