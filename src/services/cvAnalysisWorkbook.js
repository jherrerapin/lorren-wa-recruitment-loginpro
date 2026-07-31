import ExcelJS from 'exceljs';

const COLORS = Object.freeze({
  navy: '1E2D3D',
  teal: '0D7A6B',
  tealSoft: 'E6F4F1',
  blue: '175CD3',
  orange: 'B45309',
  red: 'B42318',
  white: 'FFFFFF',
  border: 'D8DEE6',
  muted: '667085',
  light: 'F8FAFC',
  yellowSoft: 'FFF8D6'
});

export const CV_REVIEW_EXPORT_GROUPS = Object.freeze({
  all: { label: 'Todas las secciones', sheet: null, color: COLORS.navy },
  strong: { label: 'Coincidencia alta', sheet: 'Coincidencia alta', color: COLORS.teal },
  possible: { label: 'Pueden encajar', sheet: 'Pueden encajar', color: COLORS.blue },
  low: { label: 'Poca evidencia', sheet: 'Poca evidencia', color: COLORS.orange },
  manual: { label: 'Revisión manual', sheet: 'Revisión manual', color: COLORS.red }
});

const RESULT_COLUMNS = [
  { header: 'Coincidencia', key: 'score', width: 14 },
  { header: 'Nombre completo', key: 'fullName', width: 30 },
  { header: 'Número de celular', key: 'phone', width: 20 },
  { header: 'Tipo de documento', key: 'documentType', width: 18 },
  { header: 'Número de documento', key: 'documentNumber', width: 21 },
  { header: 'Análisis de contenido', key: 'analysis', width: 48 },
  { header: 'Evidencia encontrada', key: 'evidence', width: 48 },
  { header: 'Responsable de revisión', key: 'reviewer', width: 26 },
  { header: 'Observación del responsable', key: 'reviewerObservation', width: 44 }
];

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
  return reasons.length
    ? reasons.join('\n')
    : compact(result.analysis?.summary) || 'Sin análisis descriptivo.';
}

function exportCandidate(candidate = {}) {
  return {
    id: compact(candidate.id),
    fullName: compact(candidate.fullName) || 'Sin nombre',
    phone: compact(candidate.phone),
    documentType: compact(candidate.documentType),
    documentNumber: compact(candidate.documentNumber),
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
      evidence: safeArray(result.match.evidence)
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

function styleTitle(sheet, title, subtitle, color = COLORS.navy, columnCount = RESULT_COLUMNS.length) {
  sheet.mergeCells(1, 1, 1, columnCount);
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = { bold: true, size: 18, color: { argb: COLORS.white } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
  sheet.getCell('A1').alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, columnCount);
  sheet.getCell('A2').value = subtitle;
  sheet.getCell('A2').font = { italic: true, color: { argb: COLORS.muted } };
  sheet.getCell('A2').alignment = { vertical: 'middle', wrapText: true };
  sheet.getRow(2).height = 30;
}

function addSummarySheet(workbook, snapshot) {
  const sheet = workbook.addWorksheet('Resumen', { views: [{ state: 'frozen', ySplit: 3 }] });
  const columnCount = RESULT_COLUMNS.length;
  styleTitle(
    sheet,
    'Criterios del análisis',
    `${snapshot.vacancy.title}${snapshot.vacancy.city ? ` · ${snapshot.vacancy.city}` : ''}`,
    COLORS.navy,
    columnCount
  );
  sheet.columns = Array.from({ length: columnCount }, () => ({ width: 18 }));

  sheet.mergeCells(4, 1, 4, columnCount);
  sheet.getCell('A4').value = 'Perfil solicitado';
  sheet.getCell('A4').font = { bold: true, color: { argb: COLORS.navy } };
  sheet.mergeCells(5, 1, 7, columnCount);
  sheet.getCell('A5').value = snapshot.desiredProfile || 'Sin texto registrado.';
  sheet.getCell('A5').alignment = { vertical: 'top', wrapText: true };
  sheet.getCell('A5').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.light } };
  sheet.getCell('A5').border = thinBorder();

  sheet.mergeCells(9, 1, 9, columnCount);
  sheet.getCell('A9').value = 'Interpretación de Lórren';
  sheet.getCell('A9').font = { bold: true, color: { argb: COLORS.navy } };
  sheet.mergeCells(10, 1, 12, columnCount);
  sheet.getCell('A10').value = snapshot.interpretedProfile.summary || 'Sin resumen interpretado.';
  sheet.getCell('A10').alignment = { vertical: 'top', wrapText: true };
  sheet.getCell('A10').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.tealSoft } };
  sheet.getCell('A10').border = thinBorder();

  const criteriaStart = 14;
  sheet.getCell(criteriaStart, 1).value = 'Prioridad';
  sheet.getCell(criteriaStart, 2).value = 'Criterio';
  sheet.mergeCells(criteriaStart, 3, criteriaStart, 7);
  sheet.getCell(criteriaStart, 3).value = 'Descripción';
  sheet.mergeCells(criteriaStart, 8, criteriaStart, 9);
  sheet.getCell(criteriaStart, 8).value = 'Mínimo meses';
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
    sheet.mergeCells(rowNumber, 3, rowNumber, 7);
    sheet.getCell(rowNumber, 3).value = criterion.description;
    sheet.mergeCells(rowNumber, 8, rowNumber, 9);
    sheet.getCell(rowNumber, 8).value = criterion.minimumMonths ?? '';
    for (let column = 1; column <= columnCount; column += 1) {
      const cell = sheet.getCell(rowNumber, column);
      cell.border = thinBorder();
      cell.alignment = { vertical: 'top', wrapText: true };
    }
  });

  return sheet;
}

function addResultSheet(workbook, snapshot, groupKey) {
  const meta = CV_REVIEW_EXPORT_GROUPS[groupKey];
  const results = snapshot.groups[groupKey] || [];
  const sheet = workbook.addWorksheet(meta.sheet, { views: [{ state: 'frozen', ySplit: 5 }] });
  sheet.columns = RESULT_COLUMNS.map(({ key, width }) => ({ key, width }));
  const generated = new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Bogota'
  }).format(new Date(snapshot.generatedAt));
  styleTitle(sheet, meta.label, `${snapshot.vacancy.title} · generado ${generated}`, meta.color);

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
      score: result.match ? Math.round(result.match.score) : '',
      fullName: candidate.fullName,
      phone: candidate.phone,
      documentType: candidate.documentType,
      documentNumber: candidate.documentNumber,
      analysis: candidateAnalysisText(result),
      evidence: joinList(result.match?.evidence),
      reviewer: '',
      reviewerObservation: ''
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
  sheet.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0
  };
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
