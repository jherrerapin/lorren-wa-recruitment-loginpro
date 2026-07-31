import ExcelJS from 'exceljs';

const COLORS = Object.freeze({
  navy: '1E2D3D',
  teal: '0D7A6B',
  blue: '175CD3',
  orange: 'B45309',
  red: 'B42318',
  white: 'FFFFFF',
  border: 'D8DEE6',
  yellowSoft: 'FFF8D6'
});

const EXPORT_GROUP_KEYS = Object.freeze(['strong', 'possible', 'low', 'manual']);

const EXPORT_GROUP_META = Object.freeze({
  strong: { label: 'Coincidencia alta', sheet: 'Coincidencia alta', color: COLORS.teal },
  possible: { label: 'Pueden encajar', sheet: 'Pueden encajar', color: COLORS.blue },
  low: { label: 'Poca evidencia', sheet: 'Poca evidencia', color: COLORS.orange },
  manual: { label: 'Revisión manual', sheet: 'Revisión manual', color: COLORS.red }
});

function buildExportGroupOptions() {
  const options = {
    all: { label: 'Todas las secciones', sheet: null, color: COLORS.navy }
  };

  for (let mask = 1; mask < (1 << EXPORT_GROUP_KEYS.length); mask += 1) {
    const keys = EXPORT_GROUP_KEYS.filter((_key, index) => Boolean(mask & (1 << index)));
    const value = keys.join(',');
    options[value] = {
      label: keys.map((key) => EXPORT_GROUP_META[key].label).join(', '),
      sheet: keys.length === 1 ? EXPORT_GROUP_META[keys[0]].sheet : null,
      color: keys.length === 1 ? EXPORT_GROUP_META[keys[0]].color : COLORS.navy
    };
  }

  return Object.freeze(options);
}

export const CV_REVIEW_EXPORT_GROUPS = buildExportGroupOptions();

const RESULT_COLUMNS = [
  { header: 'Coincidencia', key: 'score', width: 14 },
  { header: 'Nombre completo', key: 'fullName', width: 30 },
  { header: 'Número de celular', key: 'phone', width: 20 },
  { header: 'Tipo de documento', key: 'documentType', width: 18 },
  { header: 'Número de documento', key: 'documentNumber', width: 21 },
  { header: 'Experiencia', key: 'experience', width: 52 },
  { header: 'Estudios', key: 'education', width: 44 },
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

function parseObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function extractedCvData(analysis = {}) {
  const evidence = parseObject(analysis.rawResponse ?? analysis.evidence);
  return evidence.extracted && typeof evidence.extracted === 'object'
    ? evidence.extracted
    : {};
}

function formatExperienceItem(item = {}) {
  const heading = [compact(item.role), compact(item.company)].filter(Boolean).join(' · ');
  const duration = compact(item.duration);
  const responsibilities = safeArray(item.responsibilities).join('; ');
  return [heading, duration, responsibilities].filter(Boolean).join(' — ');
}

function formatCvExperience(extracted = {}) {
  const summary = compact(extracted.experienceSummary);
  if (summary) return summary;
  if (!Array.isArray(extracted.experience)) return '';
  return extracted.experience.map(formatExperienceItem).filter(Boolean).join('\n');
}

function exportCandidate(candidate = {}) {
  return {
    id: compact(candidate.id),
    fullName: compact(candidate.fullName) || 'Sin nombre',
    phone: compact(candidate.phone),
    documentType: compact(candidate.documentType),
    documentNumber: compact(candidate.documentNumber)
  };
}

function exportResult(result = {}) {
  const extracted = extractedCvData(result.analysis);
  return {
    candidate: exportCandidate(result.candidate),
    analysis: {
      summary: compact(result.analysis?.summary),
      experience: formatCvExperience(extracted),
      education: compact(extracted.educationSummary)
    },
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
  for (const key of EXPORT_GROUP_KEYS) {
    groups[key] = Array.isArray(review.groups?.[key])
      ? review.groups[key].map(exportResult)
      : [];
  }

  return {
    vacancy: {
      id: compact(review.vacancy?.id),
      title: compact(review.vacancy?.title) || 'Vacante sin nombre'
    },
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

function addResultSheet(workbook, snapshot, groupKey) {
  const meta = EXPORT_GROUP_META[groupKey];
  const results = snapshot.groups[groupKey] || [];
  const sheet = workbook.addWorksheet(meta.sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = RESULT_COLUMNS.map(({ header, key, width }) => ({ header, key, width }));

  const header = sheet.getRow(1);
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
      experience: result.analysis?.experience || '',
      education: result.analysis?.education || '',
      analysis: candidateAnalysisText(result),
      evidence: joinList(result.match?.evidence),
      reviewer: '',
      reviewerObservation: ''
    });
    row.height = 88;
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
    from: { row: 1, column: 1 },
    to: { row: 1, column: RESULT_COLUMNS.length }
  };
  sheet.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0
  };
  return sheet;
}

function normalizeGroupSelection(group = 'all') {
  const requested = compact(group);
  return Object.hasOwn(CV_REVIEW_EXPORT_GROUPS, requested) ? requested : 'all';
}

function selectedGroupKeys(group = 'all') {
  const normalized = normalizeGroupSelection(group);
  return normalized === 'all' ? [...EXPORT_GROUP_KEYS] : normalized.split(',');
}

export function buildCvAnalysisWorkbook(snapshot, { group = 'all' } = {}) {
  const normalizedGroup = normalizeGroupSelection(group);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lórren';
  workbook.created = new Date(snapshot.generatedAt || Date.now());
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  selectedGroupKeys(normalizedGroup).forEach((key) => addResultSheet(workbook, snapshot, key));
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
  const normalizedGroup = normalizeGroupSelection(group);
  const workbook = buildCvAnalysisWorkbook(snapshot, { group: normalizedGroup });
  const selectionSlug = normalizedGroup === 'all' ? 'todos' : normalizedGroup.replace(/,/g, '-');
  const filename = `candidatos-${slug(snapshot.vacancy?.title)}-${selectionSlug}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}
