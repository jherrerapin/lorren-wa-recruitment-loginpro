import ExcelJS from 'exceljs';

const BRAND = {
  navy: '1E2D3D',
  green: '0D7A6B',
  lightGreen: 'E6F4F1',
  lightGray: 'F4F5F7',
  border: 'D9DEE7',
  white: 'FFFFFF',
  muted: '6B7280'
};

function toBogotaDay(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

function addDays(day, offset) {
  const date = new Date(`${day}T00:00:00-05:00`);
  date.setUTCDate(date.getUTCDate() + offset);
  return toBogotaDay(date);
}

function startOfWeek(day) {
  const date = new Date(`${day}T12:00:00-05:00`);
  const jsDay = date.getUTCDay();
  const diffToMonday = jsDay === 0 ? -6 : 1 - jsDay;
  return addDays(day, diffToMonday);
}

function startOfMonth(day) {
  return `${day.slice(0, 7)}-01`;
}

function endOfMonth(day) {
  const [year, month] = day.split('-').map(Number);
  const end = new Date(Date.UTC(year, month, 0, 17, 0, 0));
  return toBogotaDay(end);
}

function rangeFor(period = 'week', dateValue = new Date()) {
  const day = toBogotaDay(dateValue);
  const safePeriod = period === 'month' ? 'month' : 'week';
  const startDay = safePeriod === 'month' ? startOfMonth(day) : startOfWeek(day);
  const endDay = safePeriod === 'month' ? endOfMonth(day) : addDays(startDay, 6);
  return {
    period: safePeriod,
    baseDay: day,
    startDay,
    endDay,
    start: new Date(`${startDay}T00:00:00-05:00`),
    end: new Date(`${endDay}T23:59:59.999-05:00`)
  };
}

function hasCv(candidate = {}) {
  return Boolean(candidate.cvStorageKey || candidate.cvData || candidate.cvOriginalName);
}

function rate(part, total) {
  if (!total) return '0%';
  return `${Math.round((Number(part || 0) / Number(total || 0)) * 100)}%`;
}

function dayKey(value) {
  return toBogotaDay(value);
}

function groupCount(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item) || 'Sin clasificar';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function buildDailyRows(candidates = [], bookings = []) {
  const days = new Map();
  for (const candidate of candidates) {
    const key = dayKey(candidate.createdAt);
    const row = days.get(key) || { day: key, candidates: 0, cv: 0, pendingCv: 0, review: 0, scheduled: 0, confirmed: 0, attended: 0, noShow: 0 };
    row.candidates += 1;
    if (hasCv(candidate)) row.cv += 1;
    if (candidate.fullName && candidate.documentNumber && !hasCv(candidate)) row.pendingCv += 1;
    if (candidate.potentialDuplicate || candidate.botPaused || candidate.rejectionDetails) row.review += 1;
    days.set(key, row);
  }

  for (const booking of bookings) {
    const key = dayKey(booking.scheduledAt);
    const row = days.get(key) || { day: key, candidates: 0, cv: 0, pendingCv: 0, review: 0, scheduled: 0, confirmed: 0, attended: 0, noShow: 0 };
    if (['SCHEDULED', 'CONFIRMED', 'ATTENDED', 'NO_SHOW'].includes(booking.status)) row.scheduled += 1;
    if (['CONFIRMED', 'ATTENDED'].includes(booking.status)) row.confirmed += 1;
    if (booking.status === 'ATTENDED') row.attended += 1;
    if (booking.status === 'NO_SHOW') row.noShow += 1;
    days.set(key, row);
  }

  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function buildMetrics(candidates = [], bookings = []) {
  const withCv = candidates.filter(hasCv).length;
  const scheduled = bookings.filter((booking) => ['SCHEDULED', 'CONFIRMED', 'ATTENDED', 'NO_SHOW'].includes(booking.status)).length;
  const attended = bookings.filter((booking) => booking.status === 'ATTENDED').length;
  const noShow = bookings.filter((booking) => booking.status === 'NO_SHOW').length;

  return {
    candidates: candidates.length,
    withCv,
    pendingCv: candidates.filter((candidate) => candidate.fullName && candidate.documentNumber && !hasCv(candidate)).length,
    approved: candidates.filter((candidate) => ['APROBADO', 'CONTRATADO'].includes(candidate.status)).length,
    rejected: candidates.filter((candidate) => candidate.status === 'RECHAZADO').length,
    scheduled,
    confirmed: bookings.filter((booking) => ['CONFIRMED', 'ATTENDED'].includes(booking.status)).length,
    attended,
    noShow,
    humanReview: candidates.filter((candidate) => candidate.potentialDuplicate || candidate.botPaused || candidate.rejectionDetails).length,
    cvRate: rate(withCv, candidates.length),
    attendanceRate: rate(attended, scheduled),
    noShowRate: rate(noShow, scheduled)
  };
}

function applySheetBase(sheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.properties.defaultRowHeight = 20;
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: BRAND.border } },
        left: { style: 'thin', color: { argb: BRAND.border } },
        bottom: { style: 'thin', color: { argb: BRAND.border } },
        right: { style: 'thin', color: { argb: BRAND.border } }
      };
    });
  });
}

function styleHeader(row) {
  row.height = 24;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: BRAND.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.navy } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
}

function addTitle(sheet, title, subtitle, columns) {
  sheet.mergeCells(1, 1, 1, columns);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 16, color: { argb: BRAND.white } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.green } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, columns);
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  subtitleCell.font = { italic: true, color: { argb: BRAND.muted } };
  subtitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.lightGray } };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.addRow([]);
}

function addMetricCards(sheet, metrics = {}) {
  const cards = [
    ['Candidatos', metrics.candidates],
    ['Con HV', metrics.withCv],
    ['Tasa HV', metrics.cvRate],
    ['Agendados', metrics.scheduled],
    ['Asistieron', metrics.attended],
    ['Tasa asistencia', metrics.attendanceRate],
    ['No show', metrics.noShow],
    ['Tasa no show', metrics.noShowRate],
    ['Revisión humana', metrics.humanReview]
  ];
  sheet.addRow(['Indicador', 'Valor']);
  styleHeader(sheet.lastRow);
  for (const [label, value] of cards) {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true, color: { argb: BRAND.navy } };
    row.getCell(2).font = { bold: true, color: { argb: BRAND.green } };
  }
}

function createTableSheet(workbook, name, tabColor, columns, rows) {
  const sheet = workbook.addWorksheet(name, { properties: { tabColor: { argb: tabColor } } });
  sheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: column.width || 18 }));
  styleHeader(sheet.getRow(1));
  rows.forEach((row) => sheet.addRow(row));
  sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + columns.length)}1` };
  applySheetBase(sheet);
  return sheet;
}

async function loadWorkbookData(prisma, query = {}) {
  const range = rangeFor(query.period, query.date || new Date());
  const [candidates, bookings] = await Promise.all([
    prisma.candidate.findMany({
      where: { createdAt: { gte: range.start, lte: range.end } },
      orderBy: { createdAt: 'asc' },
      take: 10000,
      include: {
        vacancy: { select: { id: true, title: true, city: true } },
        campaign: { select: { id: true, name: true, code: true, sourceType: true } }
      }
    }),
    prisma.interviewBooking.findMany({
      where: { scheduledAt: { gte: range.start, lte: range.end } },
      orderBy: { scheduledAt: 'asc' },
      take: 10000,
      include: {
        candidate: { select: { id: true, fullName: true, phone: true } },
        vacancy: { select: { id: true, title: true, city: true } }
      }
    })
  ]);

  return {
    ...range,
    metrics: buildMetrics(candidates, bookings),
    dailyRows: buildDailyRows(candidates, bookings),
    byVacancy: groupCount(candidates, (candidate) => candidate.vacancy?.title || 'Sin vacante'),
    byOrigin: groupCount(candidates, (candidate) => candidate.campaign?.name || candidate.referrerName || candidate.sourceType || 'Sin origen'),
    candidates,
    bookings
  };
}

export async function buildLorenV2ReportsWorkbook(prisma, query = {}) {
  const data = await loadWorkbookData(prisma, query);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Loren V2';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.properties.date1904 = false;

  const subtitle = `${data.period === 'month' ? 'Reporte mensual' : 'Reporte semanal'} · ${data.startDay} a ${data.endDay} · Bogotá`;
  const summary = workbook.addWorksheet('Resumen ejecutivo', { properties: { tabColor: { argb: BRAND.green } } });
  summary.columns = [{ width: 28 }, { width: 20 }, { width: 28 }, { width: 20 }];
  addTitle(summary, 'Loren V2 - Reporte de reclutamiento', subtitle, 4);
  addMetricCards(summary, data.metrics);
  applySheetBase(summary);

  createTableSheet(workbook, 'Desglose por día', BRAND.navy, [
    { header: 'Día', key: 'day', width: 16 },
    { header: 'Candidatos', key: 'candidates', width: 14 },
    { header: 'Con HV', key: 'cv', width: 12 },
    { header: 'Pend. HV', key: 'pendingCv', width: 12 },
    { header: 'Agendados', key: 'scheduled', width: 14 },
    { header: 'Confirmados', key: 'confirmed', width: 14 },
    { header: 'Asistieron', key: 'attended', width: 14 },
    { header: 'No show', key: 'noShow', width: 12 },
    { header: 'Revisión humana', key: 'review', width: 18 }
  ], data.dailyRows);

  createTableSheet(workbook, 'Vacantes', BRAND.green, [
    { header: 'Vacante', key: 'label', width: 42 },
    { header: 'Candidatos', key: 'count', width: 16 }
  ], data.byVacancy);

  createTableSheet(workbook, 'Campañas y origen', BRAND.green, [
    { header: 'Origen', key: 'label', width: 42 },
    { header: 'Candidatos', key: 'count', width: 16 }
  ], data.byOrigin);

  createTableSheet(workbook, 'Candidatos', BRAND.navy, [
    { header: 'Fecha registro', key: 'createdAt', width: 22 },
    { header: 'Nombre', key: 'fullName', width: 32 },
    { header: 'Teléfono', key: 'phone', width: 18 },
    { header: 'Documento', key: 'documentNumber', width: 18 },
    { header: 'Vacante', key: 'vacancy', width: 34 },
    { header: 'Estado', key: 'status', width: 18 },
    { header: 'Origen', key: 'origin', width: 34 },
    { header: 'HV', key: 'cv', width: 12 },
    { header: 'Revisión humana', key: 'review', width: 18 }
  ], data.candidates.map((candidate) => ({
    createdAt: candidate.createdAt,
    fullName: candidate.fullName || 'Sin nombre',
    phone: candidate.phone || '',
    documentNumber: candidate.documentNumber || '',
    vacancy: candidate.vacancy?.title || 'Sin vacante',
    status: candidate.status || '',
    origin: candidate.campaign?.name || candidate.referrerName || candidate.sourceType || 'Sin origen',
    cv: hasCv(candidate) ? 'Sí' : 'No',
    review: candidate.potentialDuplicate || candidate.botPaused || candidate.rejectionDetails ? 'Sí' : 'No'
  })));

  createTableSheet(workbook, 'Citas', BRAND.navy, [
    { header: 'Fecha cita', key: 'scheduledAt', width: 22 },
    { header: 'Candidato', key: 'candidate', width: 32 },
    { header: 'Teléfono', key: 'phone', width: 18 },
    { header: 'Vacante', key: 'vacancy', width: 34 },
    { header: 'Estado', key: 'status', width: 18 },
    { header: 'Notas', key: 'notes', width: 44 }
  ], data.bookings.map((booking) => ({
    scheduledAt: booking.scheduledAt,
    candidate: booking.candidate?.fullName || 'Sin nombre',
    phone: booking.candidate?.phone || '',
    vacancy: booking.vacancy?.title || 'Sin vacante',
    status: booking.status || '',
    notes: booking.notes || ''
  })));

  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1 && rowNumber % 2 === 0) {
        row.eachCell((cell) => {
          if (!cell.fill || cell.fill.fgColor?.argb !== BRAND.navy) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FBFCFD' } };
          }
        });
      }
    });
  }

  return { workbook, data };
}
