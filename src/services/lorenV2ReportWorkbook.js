import ExcelJS from 'exceljs';

const COLORS = {
  navy: '1E2D3D',
  teal: '0D7A6B',
  tealSoft: 'E6F4F1',
  gray: '6B7280',
  light: 'F4F5F7',
  white: 'FFFFFF',
  border: 'D8DEE6',
  danger: 'FEE2E2',
  warning: 'FEF3C7',
  success: 'DCFCE7'
};

function safe(value = '') {
  return value === null || value === undefined ? '' : value;
}

function sheetTitle(sheet, title, subtitle) {
  sheet.mergeCells('A1:H1');
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = { bold: true, size: 18, color: { argb: COLORS.white } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
  sheet.getCell('A1').alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 28;

  sheet.mergeCells('A2:H2');
  sheet.getCell('A2').value = subtitle;
  sheet.getCell('A2').font = { italic: true, color: { argb: COLORS.gray } };
  sheet.getRow(2).height = 22;
}

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLORS.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.teal } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder();
  });
  row.height = 22;
}

function thinBorder() {
  return {
    top: { style: 'thin', color: { argb: COLORS.border } },
    left: { style: 'thin', color: { argb: COLORS.border } },
    bottom: { style: 'thin', color: { argb: COLORS.border } },
    right: { style: 'thin', color: { argb: COLORS.border } }
  };
}

function styleTable(sheet, headerRowNumber, lastRowNumber) {
  styleHeader(sheet.getRow(headerRowNumber));
  for (let rowNumber = headerRowNumber + 1; rowNumber <= lastRowNumber; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.eachCell((cell) => {
      cell.border = thinBorder();
      cell.alignment = { vertical: 'top', wrapText: true };
    });
    if (rowNumber % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FAFBFC' } };
      });
    }
  }
  sheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: headerRowNumber, column: sheet.columnCount } };
}

function setColumns(sheet, columns) {
  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width || 18,
    style: column.style || {}
  }));
}

function addTableSheet(workbook, name, title, subtitle, columns, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4 }] });
  sheetTitle(sheet, title, subtitle);
  setColumns(sheet, columns);
  sheet.getRow(4).values = columns.map((column) => column.header);
  rows.forEach((row) => sheet.addRow(row));
  styleTable(sheet, 4, Math.max(4, sheet.rowCount));
  sheet.eachRow((row) => row.commit?.());
  return sheet;
}

function addKpiCard(sheet, cell, label, value, fill = COLORS.tealSoft) {
  const start = sheet.getCell(cell);
  const col = start.col;
  const row = start.row;
  sheet.mergeCells(row, col, row, col + 1);
  sheet.mergeCells(row + 1, col, row + 1, col + 1);
  sheet.getCell(row, col).value = label;
  sheet.getCell(row, col).font = { bold: true, color: { argb: COLORS.gray }, size: 10 };
  sheet.getCell(row, col).alignment = { horizontal: 'center' };
  sheet.getCell(row + 1, col).value = value;
  sheet.getCell(row + 1, col).font = { bold: true, color: { argb: COLORS.navy }, size: 18 };
  sheet.getCell(row + 1, col).alignment = { horizontal: 'center' };
  for (let r = row; r <= row + 1; r += 1) {
    for (let c = col; c <= col + 1; c += 1) {
      sheet.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      sheet.getCell(r, c).border = thinBorder();
    }
  }
}

function createSummarySheet(workbook, report) {
  const sheet = workbook.addWorksheet('Resumen', { views: [{ state: 'frozen', ySplit: 3 }] });
  sheetTitle(sheet, 'Loren V2 - Reporte ejecutivo', `${report.period === 'month' ? 'Reporte mensual' : 'Reporte semanal'} · ${report.startDay} a ${report.endDay}`);
  sheet.columns = Array.from({ length: 8 }).map(() => ({ width: 18 }));

  addKpiCard(sheet, 'A4', 'Candidatos', report.metrics.newCandidates);
  addKpiCard(sheet, 'C4', 'Con HV', report.metrics.withCv);
  addKpiCard(sheet, 'E4', 'Tasa HV', report.metrics.cvRate, COLORS.success);
  addKpiCard(sheet, 'G4', 'Pendientes HV', report.metrics.pendingCv, COLORS.warning);
  addKpiCard(sheet, 'A7', 'Agendados', report.metrics.scheduled);
  addKpiCard(sheet, 'C7', 'Confirmados', report.metrics.confirmed);
  addKpiCard(sheet, 'E7', 'Asistieron', report.metrics.attended, COLORS.success);
  addKpiCard(sheet, 'G7', 'No show', report.metrics.noShow, COLORS.danger);
  addKpiCard(sheet, 'A10', 'Tasa asistencia', report.metrics.attendanceRate, COLORS.success);
  addKpiCard(sheet, 'C10', 'Tasa no show', report.metrics.noShowRate, COLORS.danger);
  addKpiCard(sheet, 'E10', 'Aprobados', report.metrics.approved);
  addKpiCard(sheet, 'G10', 'Revisión humana', report.metrics.humanReview, COLORS.warning);

  sheet.getCell('A14').value = 'Lectura rápida';
  sheet.getCell('A14').font = { bold: true, size: 14, color: { argb: COLORS.navy } };
  sheet.mergeCells('A15:H18');
  sheet.getCell('A15').value = `Este archivo consolida el desempeño del periodo ${report.startDay} a ${report.endDay}. Incluye desglose diario, resultados por vacante, campañas/orígenes, últimos candidatos y últimas citas. Usa los filtros de cada hoja para revisar detalles.`;
  sheet.getCell('A15').alignment = { wrapText: true, vertical: 'top' };
  sheet.getCell('A15').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.light } };
  sheet.getCell('A15').border = thinBorder();

  return sheet;
}

function workbookProperties(workbook) {
  workbook.creator = 'Loren V2';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
}

export function buildLorenV2ReportWorkbook(report) {
  const workbook = new ExcelJS.Workbook();
  workbookProperties(workbook);
  createSummarySheet(workbook, report);

  addTableSheet(workbook, 'Desglose diario', 'Desglose diario', `${report.startDay} a ${report.endDay}`, [
    { header: 'Día', key: 'day', width: 14 },
    { header: 'Candidatos', key: 'newCandidates', width: 14 },
    { header: 'HV recibidas', key: 'withCv', width: 14 },
    { header: 'Pend. HV', key: 'pendingCv', width: 14 },
    { header: 'Agendados', key: 'scheduled', width: 14 },
    { header: 'Confirmados', key: 'confirmed', width: 14 },
    { header: 'Asistieron', key: 'attended', width: 14 },
    { header: 'No show', key: 'noShow', width: 14 },
    { header: 'Revisión', key: 'humanReview', width: 14 }
  ], report.dailyRows);

  addTableSheet(workbook, 'Vacantes', 'Candidatos por vacante', `${report.startDay} a ${report.endDay}`, [
    { header: 'Vacante', key: 'label', width: 40 },
    { header: 'Candidatos', key: 'count', width: 16 }
  ], report.byVacancy);

  addTableSheet(workbook, 'Campañas y origen', 'Candidatos por campaña / origen', `${report.startDay} a ${report.endDay}`, [
    { header: 'Origen', key: 'label', width: 44 },
    { header: 'Candidatos', key: 'count', width: 16 }
  ], report.byCampaign);

  addTableSheet(workbook, 'Candidatos', 'Últimos candidatos del rango', `${report.startDay} a ${report.endDay}`, [
    { header: 'Registro', key: 'createdAt', width: 18 },
    { header: 'Nombre', key: 'fullName', width: 28 },
    { header: 'Teléfono', key: 'phone', width: 18 },
    { header: 'Vacante', key: 'vacancy', width: 32 },
    { header: 'Estado', key: 'status', width: 18 },
    { header: 'Origen', key: 'origin', width: 32 }
  ], report.latestCandidates.map((candidate) => ({
    createdAt: candidate.createdAt ? new Date(candidate.createdAt) : '',
    fullName: safe(candidate.fullName || 'Sin nombre'),
    phone: safe(candidate.phone),
    vacancy: safe(candidate.vacancy?.title || 'Sin vacante'),
    status: safe(candidate.status),
    origin: safe(candidate.campaign?.name || candidate.referrerName || candidate.sourceType || 'Sin origen')
  })));

  addTableSheet(workbook, 'Citas', 'Últimas citas del rango', `${report.startDay} a ${report.endDay}`, [
    { header: 'Fecha cita', key: 'scheduledAt', width: 20 },
    { header: 'Candidato', key: 'candidate', width: 28 },
    { header: 'Teléfono', key: 'phone', width: 18 },
    { header: 'Vacante', key: 'vacancy', width: 32 },
    { header: 'Estado', key: 'status', width: 18 }
  ], report.latestBookings.map((booking) => ({
    scheduledAt: booking.scheduledAt ? new Date(booking.scheduledAt) : '',
    candidate: safe(booking.candidate?.fullName || 'Sin nombre'),
    phone: safe(booking.candidate?.phone),
    vacancy: safe(booking.vacancy?.title || 'Sin vacante'),
    status: safe(booking.status)
  })));

  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd hh:mm';
      });
    });
  }

  return workbook;
}

export async function sendLorenV2ReportWorkbook(res, report) {
  const workbook = buildLorenV2ReportWorkbook(report);
  const filename = `loren-v2-${report.period}-${report.startDay}-a-${report.endDay}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}
