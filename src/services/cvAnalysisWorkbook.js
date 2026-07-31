import ExcelJS from 'exceljs';

const COLORS = Object.freeze({
  navy: '1E2D3D',
  teal: '0D7A6B',
  tealSoft: 'E6F4F1',
  blue: '175CD3',
  blueSoft: 'EFF8FF',
  orange: 'B45309',
  orangeSoft: 'FFF7ED',
  red: 'B42318',
  redSoft: 'FEE4E2',
  yellowSoft: 'FFF8D6',
  white: 'FFFFFF',
  border: 'D8DEE6',
  muted: '667085',
  light: 'F8FAFC'
});

export const CV_REVIEW_EXPORT_GROUPS = Object.freeze({
  all: { label: 'Todas las secciones', sheet: null, color: COLORS.navy },
  strong: { label: 'Coincidencia alta', sheet: 'Coincidencia alta', color: COLORS.teal },
  possible: { label: 'Pueden encajar', sheet: 'Pueden encajar', color: COLORS.blue },
  low: { label: 'Poca evidencia', sheet: 'Poca evidencia', color: COLORS.orange },
  manual: { label: 'Revisión manual', sheet: 'Revisión manual', color: COLORS.red }
});

function compact(value = '') {
  return String(value ?? '').trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value.map(compact).filter(Boolean) : [];
}

function joinList(value) {
  return safeArray(value).join('\n');
}

function normalizePhoneForWhatsapp(value = '') {
  let digits = compact(value).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith('3')) digits = `57${digits}`;
  return digits;
}

export function buildWhatsappWebUrl(phone = '') {
  const digits = normalizePhoneForWhatsapp(phone);
  return digits ? `https://web.whatsapp.com/send?phone=${digits}` : null;
}

function candidateAnalysisText(result = {}) {
  if (compact(result.manualReason)) return compact(result.manualReason);
  const reasons = safeArray(result.match?.reasons);
  return reasons.length ? reasons.join('\n') : compact(result.analysis?.summary) || 'Sin análisis descriptivo.';
}

function exportCandidate(candidate = {}) {
  return {
    id: compact(candidate.id),
    fullName: compact(candidate.fullName) || 'Sin nombre',
    phone: compact(candidate.phone),
    documentType: compact(candidate.documentType),
    documentNumber: compact(candidate.documentNumber),
    cvOriginalName: compact(candidate.cvOriginalName),
    vacancyTitle: compact(candidate.vacancy?.title || candidate.vacancyTitle)
  };
}

function exportResult(result = {}) {
  return {
    candidate: exportCandidate(result.candidate),
    analysis: { summary: compact(result.analysis?.summary) },
    match: result.match ? {
      level: compact(result.match.level),
      score: Math.max(0, Math.min(100, Number(result.match.score || 0))),
      reasons: safeArray(result.match.reasons),
      evidence: safeArray(result.match.evidence),
      gaps: safeArray(result.match.gaps)
    } : null,
    manualReason: compact(result.manualReason)
  };
}

export function createCvReviewExportSnapshot(review = {}) {
  const groups = {};
  for (const key of ['strong', 'possible', 'low', 'manual']) {
    groups[key] = Array.isArray(review.groups?.[key])
      ? review.groups[key].map(exportResult)
      : [];
  }
  return {
    vacancy: {
      id: compact(review.vacancy?.id),
      title: compact(review.vacancy?.title) || 'Vacante sin nombre',
      city: compact(review.vacancy?.city)
    },
    desiredProfile: compact(review.desiredProfile),
    interpretedProfile: {
      summary: compact(review.interpretedProfile?.summary),
      criteria: Array.isArray(review.interpretedProfile?.criteria)
        ? review.interpretedProfile.criteria.map((criterion) => ({
          label: compact(criterion.label),
          description: compact(criterion.description),
          priority: compact(criterion.priority),
          minimumMonths: Number.isFinite(Number(criterion.minimumMonths))
            ? Number(criterion.minimumMonths)
            : null
        }))
        : [],
      warnings: safeArray(review.interpretedProfile?.warnings)
    },
    modelUsed: compact(review.modelUsed),
    warnings: safeArray(review.warnings),
    stats: {
      total: Number(review.stats?.total || 0),
      readable: Number(review.stats?.readable || 0),
      strong: groups.strong.length,
      possible: groups.possible.length,
      low: groups.low.length,
      manual: groups.manual.length
    },
    truncated: Boolean(review.truncated),
    groups,
    generatedAt: new Date().toISOString()
  };
}

function thinBorder() {
  return {
    top: { style: 'thin', color: { argb: COLORS.border } },
    left: { style: 'thin', color: { argb: COLORS.border } },
    bottom: { style: 'thin', color: { argb: COLORS.border } },
    right: { style: 'thin', color: { argb: COLORS.border } }
  };
}

function styleTitle(sheet, title, subtitle, color = COLORS.navy) {
  sheet.mergeCells('A1:L1');
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = { bold: true, size: 18, color: { argb: COLORS.white } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
  sheet.getCell('A1').alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 30;

  sheet.mergeCells('A2:L2');
  sheet.getCell('A2').value = subtitle;
  sheet.getCell('A2').font = { italic: true, color: { argb: COLORS.muted } };
  sheet.getCell('A2').alignment = { vertical: 'middle', wrapText: true };
  sheet.getRow(2).height = 30;
}

function addSummarySheet(workbook, snapshot) {
  const sheet = workbook.addWorksheet('Resumen', { views: [{ state: 'frozen', ySplit: 3 }] });
  styleTitle(
    sheet,
    'Análisis de hojas de vida',
    `${snapshot.vacancy.title}${snapshot.vacancy.city ? ` · ${snapshot.vacancy.city}` : ''}`
  );
  sheet.columns = Array.from({ length: 12 }, () => ({ width: 16 }));

  const metrics = [
    ['A4', 'Total', snapshot.stats.total, COLORS.light],
    ['C4', 'Coincidencia alta', snapshot.stats.strong, COLORS.tealSoft],
    ['E4', 'Pueden encajar', snapshot.stats.possible, COLORS.blueSoft],
    ['G4', 'Poca evidencia', snapshot.stats.low, COLORS.orangeSoft],
    ['I4', 'Revisión manual', snapshot.stats.manual, COLORS.redSoft]
  ];
  for (const [cell, label, value, fill] of metrics) {
    const target = sheet.getCell(cell);
    sheet.mergeCells(target.row, target.col, target.row, target.col + 1);
    sheet.mergeCells(target.row + 1, target.col, target.row + 1, target.col + 1);
    sheet.getCell(target.row, target.col).value = label;
    sheet.getCell(target.row, target.col).font = { bold: true, size: 10, color: { argb: COLORS.muted } };
    sheet.getCell(target.row + 1, target.col).value = value;
    sheet.getCell(target.row + 1, target.col).font = { bold: true, size: 18, color: { argb: COLORS.navy } };
    for (let row = target.row; row <= target.row + 1; row += 1) {
      for (let col = target.col; col <= target.col + 1; col += 1) {
        const metricCell = sheet.getCell(row, col);
        metricCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        metricCell.border = thinBorder();
        metricCell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
    }
  }

  sheet.mergeCells('A8:L8');
  sheet.getCell('A8').value = 'Texto escrito por el coordinador';
  sheet.getCell('A8').font = { bold: true, color: { argb: COLORS.navy } };
  sheet.mergeCells('A9:L11');
  sheet.getCell('A9').value = snapshot.desiredProfile || 'Sin texto registrado.';
  sheet.getCell('A9').alignment = { vertical: 'top', wrapText: true };
  sheet.getCell('A9').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.light } };
  sheet.getCell('A9').border = thinBorder();

  sheet.mergeCells('A13:L13');
  sheet.getCell('A13').value = 'Cómo interpretó Lórren el perfil';
  sheet.getCell('A13').font = { bold: true, color: { argb: COLORS.navy } };
  sheet.mergeCells('A14:L16');
  sheet.getCell('A14').value = snapshot.interpretedProfile.summary || 'Sin resumen interpretado.';
  sheet.getCell('A14').alignment = { vertical: 'top', wrapText: true };
  sheet.getCell('A14').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.tealSoft } };
  sheet.getCell('A14').border = thinBorder();

  const criteriaStart = 18;
  sheet.getCell(criteriaStart, 1).value = 'Prioridad';
  sheet.getCell(criteriaStart, 2).value = 'Criterio';
  sheet.mergeCells(criteriaStart, 3, criteriaStart, 10);
  sheet.getCell(criteriaStart, 3).value = 'Descripción';
  sheet.mergeCells(criteriaStart, 11, criteriaStart, 12);
  sheet.getCell(criteriaStart, 11).value = 'Mínimo meses';
  const header = sheet.getRow(criteriaStart);
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLORS.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.teal } };
    cell.border = thinBorder();
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });

  snapshot.interpretedProfile.criteria.forEach((criterion, index) => {
    const rowNumber = criteriaStart + index + 1;
    sheet.getCell(rowNumber, 1).value = criterion.priority === 'REQUIRED' ? 'Importante' : 'Deseable';
    sheet.getCell(rowNumber, 2).value = criterion.label;
    sheet.mergeCells(rowNumber, 3, rowNumber, 10);
    sheet.getCell(rowNumber, 3).value = criterion.description;
    sheet.mergeCells(rowNumber, 11, rowNumber, 12);
    sheet.getCell(rowNumber, 11).value = criterion.minimumMonths ?? '';
    for (let col = 1; col <= 12; col += 1) {
      const cell = sheet.getCell(rowNumber, col);
      cell.border = thinBorder();
      cell.alignment = { vertical: 'top', wrapText: true };
    }
  });
  return sheet;
}

const RESULT_COLUMNS = [
  { header: 'Sección', key: 'section', width: 20 },
  { header: 'Coincidencia', key: 'score', width: 14 },
  { header: 'Nombre completo', key: 'fullName', width: 30 },
  { header: 'Número de celular', key: 'phone', width: 20 },
  { header: 'Tipo de documento', key: 'documentType', width: 18 },
  { header: 'Número de documento', key: 'documentNumber', width: 21 },
  { header: 'Análisis de contenido', key: 'analysis', width: 48 },
  { header: 'Evidencia encontrada', key: 'evidence', width: 48 },
  { header: 'Lo que falta confirmar', key: 'gaps', width: 42 },
  { header: 'Responsable de revisión', key: 'reviewer', width: 26 },
  { header: 'Observación del responsable', key: 'reviewerObservation', width: 44 },
  { header: 'Archivo HV', key: 'cvFile', width: 28 }
];

function addResultSheet(workbook, snapshot, groupKey) {
  const meta = CV_REVIEW_EXPORT_GROUPS[groupKey];
  const results = snapshot.groups[groupKey] || [];
  const sheet = workbook.addWorksheet(meta.sheet, { views: [{ state: 'frozen', ySplit: 5 }] });
  sheet.columns = RESULT_COLUMNS.map(({ key, width }) => ({ key, width }));
  styleTitle(
    sheet,
    meta.label,
    `${snapshot.vacancy.title} · ${results.length} registro(s) · generado ${new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' }).format(new Date(snapshot.generatedAt))}`,
    meta.color
  );
  sheet.getRow(4).values = RESULT_COLUMNS.map((column) => column.header);
  const header = sheet.getRow(4);
  header.height = 30;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLORS.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: meta.color } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = thinBorder();
  });

  results.forEach((result) => {
    const candidate = result.candidate || {};
    const phoneUrl = buildWhatsappWebUrl(candidate.phone);
    const row = sheet.addRow({
      section: meta.label,
      score: result.match ? Math.round(result.match.score) : '',
      fullName: candidate.fullName,
      phone: candidate.phone,
      documentType: candidate.documentType,
      documentNumber: candidate.documentNumber,
      analysis: candidateAnalysisText(result),
      evidence: joinList(result.match?.evidence),
      gaps: joinList(result.match?.gaps),
      reviewer: '',
      reviewerObservation: '',
      cvFile: candidate.cvOriginalName
    });
    row.height = 72;
    row.eachCell((cell) => {
      cell.border = thinBorder();
      cell.alignment = { vertical: 'top', wrapText: true };
    });
    if (result.match) row.getCell('score').numFmt = '0"%"';
    if (phoneUrl) {
      row.getCell('phone').value = {
        text: candidate.phone || 'Abrir WhatsApp Web',
        hyperlink: phoneUrl,
        tooltip: `Abrir conversación con ${candidate.fullName || 'el candidato'} en WhatsApp Web`
      };
      row.getCell('phone').font = { color: { argb: COLORS.blue }, underline: true };
    }
    for (const key of ['reviewer', 'reviewerObservation']) {
      row.getCell(key).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.yellowSoft } };
    }
  });

  if (!results.length) {
    const row = sheet.addRow(['Sin registros en esta sección.']);
    sheet.mergeCells(row.number, 1, row.number, RESULT_COLUMNS.length);
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  }

  sheet.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: 4, column: RESULT_COLUMNS.length }
  };
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return sheet;
}

export function buildCvAnalysisWorkbook(snapshot, { group = 'all' } = {}) {
  const normalizedGroup = Object.hasOwn(CV_REVIEW_EXPORT_GROUPS, group) ? group : 'all';
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lórren';
  workbook.created = new Date(snapshot.generatedAt || Date.now());
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  addSummarySheet(workbook, snapshot);
  const groupKeys = normalizedGroup === 'all'
    ? ['strong', 'possible', 'low', 'manual']
    : [normalizedGroup];
  groupKeys.forEach((key) => addResultSheet(workbook, snapshot, key));
  return workbook;
}

function slug(value = '') {
  return compact(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'vacante';
}

export async function sendCvAnalysisWorkbook(res, snapshot, { group = 'all' } = {}) {
  const normalizedGroup = Object.hasOwn(CV_REVIEW_EXPORT_GROUPS, group) ? group : 'all';
  const workbook = buildCvAnalysisWorkbook(snapshot, { group: normalizedGroup });
  const filename = `analisis-hv-${slug(snapshot.vacancy?.title)}-${normalizedGroup}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}
