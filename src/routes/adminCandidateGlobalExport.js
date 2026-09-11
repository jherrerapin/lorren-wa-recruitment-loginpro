import express from 'express';
import ExcelJS from 'exceljs';
import {
  buildCandidateAccessWhere,
  getAccessContext
} from '../services/appUsers.js';
import { getCandidateResidenceValue } from '../services/candidateData.js';
import {
  buildWhatsAppLink,
  candidateHasCv,
  exportFilenameByScope,
  filterCandidatesForExport
} from '../services/candidateExport.js';
import { normalizeApplicantDateRange } from '../services/vacancyDashboardSearchExpansion.js';

export const GLOBAL_CANDIDATE_EXPORT_SCOPES = new Set([
  'registered',
  'missing_cv_complete',
  'approved',
  'contacted',
  'contracted',
  'rejected',
  'all'
]);

function compact(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireAdminSession(req, res, next) {
  if (req.userRole || req.session?.userRole) return next();
  return res.status(401).send('Debes iniciar sesión.');
}

function getRequestAccessContext(req = {}) {
  return getAccessContext({
    userRole: req.userRole || req.session?.userRole,
    userId: req.userId || req.session?.userId,
    username: req.username || req.session?.username,
    userAccessScope: req.userAccessScope || req.session?.userAccessScope,
    userAccessCity: req.userAccessCity || req.session?.userAccessCity,
    userAccessVacancyId: req.userAccessVacancyId || req.session?.userAccessVacancyId
  });
}

function formatDateTimeCO(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

export function buildGlobalCandidateExportWhere(accessContext = {}, dateRange = {}) {
  const createdAt = {};
  if (dateRange.start) createdAt.gte = dateRange.start;
  if (dateRange.end) createdAt.lte = dateRange.end;

  return {
    ...buildCandidateAccessWhere(accessContext),
    ...(Object.keys(createdAt).length ? { createdAt } : {})
  };
}

export async function loadGlobalCandidateExportRows(prisma, {
  accessContext,
  scope,
  dateRange
} = {}) {
  const rows = await prisma.candidate.findMany({
    where: buildGlobalCandidateExportWhere(accessContext, dateRange),
    orderBy: { createdAt: 'desc' },
    select: {
      fullName: true,
      phone: true,
      documentType: true,
      documentNumber: true,
      age: true,
      neighborhood: true,
      locality: true,
      zone: true,
      medicalRestrictions: true,
      transportMode: true,
      status: true,
      createdAt: true,
      cvMimeType: true,
      cvOriginalName: true,
      cvStorageKey: true,
      vacancy: {
        select: {
          title: true,
          role: true,
          city: true
        }
      }
    }
  });

  return filterCandidatesForExport(rows, scope, {
    isDev: Boolean(accessContext?.isDev)
  });
}

function applyWorkbookStyle(sheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columns.length }
  };

  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E2D3D' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      right: { style: 'thin', color: { argb: 'FFD1D5DB' } }
    };
  });

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        right: { style: 'thin', color: { argb: 'FFE5E7EB' } }
      };
    });

    const hvCell = row.getCell('hasCV');
    hvCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: hvCell.value === 'Sí' ? 'FFDCFCE7' : 'FFFEE2E2' }
    };
    hvCell.font = {
      bold: true,
      color: { argb: hvCell.value === 'Sí' ? 'FF166534' : 'FF991B1B' }
    };

    const phoneCell = row.getCell('phone');
    if (phoneCell.value?.hyperlink) {
      phoneCell.font = { color: { argb: 'FF1D4ED8' }, underline: true };
    }
  });
}

export function adminCandidateGlobalExportRouter(prisma) {
  const router = express.Router();
  router.use(requireAdminSession);

  router.get('/export-global', async (req, res) => {
    const scope = compact(req.query.scope) || 'all';
    if (!GLOBAL_CANDIDATE_EXPORT_SCOPES.has(scope)) {
      return res.status(400).send('Scope inválido.');
    }

    const dateRange = normalizeApplicantDateRange(req.query);
    if (dateRange.error) return res.status(400).send(dateRange.error);

    const accessContext = getRequestAccessContext(req);
    const candidates = await loadGlobalCandidateExportRows(prisma, {
      accessContext,
      scope,
      dateRange
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Candidatos');
    sheet.columns = [
      { header: 'Fecha registro', key: 'createdAt', width: 20 },
      { header: 'Nombre', key: 'fullName', width: 28 },
      { header: 'Teléfono', key: 'phone', width: 20 },
      { header: 'Doc. Tipo', key: 'documentType', width: 12 },
      { header: 'Doc. Número', key: 'documentNumber', width: 18 },
      { header: 'Edad', key: 'age', width: 8 },
      { header: 'Sucursal', key: 'city', width: 18 },
      { header: 'Vacante', key: 'vacancy', width: 28 },
      { header: 'Barrio / Localidad', key: 'residence', width: 22 },
      { header: 'Restricciones', key: 'medicalRestrictions', width: 22 },
      { header: 'Transporte', key: 'transportMode', width: 16 },
      { header: 'Tiene HV', key: 'hasCV', width: 10 }
    ];

    for (const candidate of candidates) {
      const vacancyLabel = candidate.vacancy?.title || candidate.vacancy?.role || '';
      const residence = getCandidateResidenceValue(candidate, candidate.vacancy)
        || candidate.zone
        || '';
      const whatsappLink = buildWhatsAppLink(candidate.phone);
      const row = sheet.addRow({
        createdAt: formatDateTimeCO(candidate.createdAt),
        fullName: candidate.fullName || '',
        phone: candidate.phone || '',
        documentType: candidate.documentType || '',
        documentNumber: candidate.documentNumber || '',
        age: candidate.age ?? '',
        city: candidate.vacancy?.city || '',
        vacancy: vacancyLabel,
        residence,
        medicalRestrictions: candidate.medicalRestrictions || '',
        transportMode: candidate.transportMode || '',
        hasCV: candidateHasCv(candidate) ? 'Sí' : 'No'
      });
      if (whatsappLink && candidate.phone) {
        row.getCell('phone').value = { text: candidate.phone, hyperlink: whatsappLink };
      }
    }

    applyWorkbookStyle(sheet);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilenameByScope(scope)}"`);
    await workbook.xlsx.write(res);
    return res.end();
  });

  return router;
}
