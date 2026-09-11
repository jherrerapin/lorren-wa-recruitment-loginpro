import express from 'express';
import ExcelJS from 'exceljs';
import { buildCandidateAccessWhere, getAccessContext } from '../services/appUsers.js';
import { getCandidateResidenceValue } from '../services/candidateData.js';
import {
  buildWhatsAppLink,
  candidateHasCv,
  exportFilenameByScope,
  filterCandidatesForExport,
  normalizeCandidateStatusForUI
} from '../services/candidateExport.js';
import { normalizeApplicantDateRange } from '../services/vacancyDashboardSearchExpansion.js';

const GLOBAL_EXPORT_SCOPES = new Set([
  'registered',
  'approved',
  'missing_cv_complete',
  'new',
  'contacted',
  'contracted',
  'rejected',
  'all'
]);

const STATUS_LABELS = Object.freeze({
  NUEVO: 'Nuevo',
  REGISTRADO: 'Registrado',
  APROBADO: 'Aprobado',
  CONTACTADO: 'Contactado',
  CONTRATADO: 'Contratado',
  RECHAZADO: 'Rechazado'
});

function requireAdminSession(req, res, next) {
  if (!req.session?.userRole && !req.userRole) return res.redirect('/login');
  return next();
}

function requestAccessContext(req = {}) {
  return getAccessContext({
    userRole: req.userRole || req.session?.userRole,
    userId: req.userId || req.session?.userId,
    username: req.username || req.session?.username,
    userAccessScope: req.userAccessScope || req.session?.userAccessScope,
    userAccessCity: req.userAccessCity || req.session?.userAccessCity,
    userAccessVacancyId: req.userAccessVacancyId || req.session?.userAccessVacancyId
  });
}

function candidateDateWhere(dateRange = {}) {
  const createdAt = {};
  if (dateRange.start) createdAt.gte = dateRange.start;
  if (dateRange.end) createdAt.lte = dateRange.end;
  return Object.keys(createdAt).length ? { createdAt } : {};
}

function formatDateTimeCO(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function statusLabel(status) {
  const normalized = normalizeCandidateStatusForUI(status);
  return STATUS_LABELS[normalized] || normalized || '';
}

function styleWorksheet(sheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columnCount }
  };
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 24;
  sheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: 'top', wrapText: true };
    if (rowNumber > 1) row.height = 22;
  });
}

export function adminCandidateGlobalExportRouter(prisma) {
  const router = express.Router();

  router.get('/export-global', requireAdminSession, async (req, res) => {
    const scope = String(req.query.scope || 'all').trim();
    if (!GLOBAL_EXPORT_SCOPES.has(scope)) return res.status(400).send('Scope inválido.');

    const dateRange = normalizeApplicantDateRange(req.query || {});
    if (dateRange.error) return res.status(400).send(dateRange.error);

    const accessContext = requestAccessContext(req);
    const where = {
      ...buildCandidateAccessWhere(accessContext),
      ...candidateDateWhere(dateRange)
    };

    const [candidateRows, cvRows] = await Promise.all([
      prisma.candidate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
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
          rejectionReason: true,
          cvOriginalName: true,
          cvMimeType: true,
          cvStorageKey: true,
          createdAt: true,
          vacancy: {
            select: {
              id: true,
              title: true,
              role: true,
              city: true
            }
          }
        }
      }),
      prisma.candidate.findMany({
        where: {
          ...where,
          OR: [
            { cvStorageKey: { not: null } },
            { cvOriginalName: { not: null } },
            { cvMimeType: { not: null } },
            { cvData: { not: null } }
          ]
        },
        select: { id: true }
      })
    ]);

    const candidateIdsWithCv = new Set(cvRows.map((candidate) => candidate.id));
    const candidates = filterCandidatesForExport(
      candidateRows.map((candidate) => ({
        ...candidate,
        cvData: candidateIdsWithCv.has(candidate.id) ? true : null
      })),
      scope,
      { isDev: accessContext.isDev }
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Lórren';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Candidatos');
    sheet.columns = [
      { header: 'Fecha registro', key: 'createdAt', width: 20 },
      { header: 'Nombre', key: 'fullName', width: 30 },
      { header: 'Teléfono', key: 'phone', width: 18 },
      { header: 'Doc. Tipo', key: 'documentType', width: 12 },
      { header: 'Doc. Número', key: 'documentNumber', width: 18 },
      { header: 'Edad', key: 'age', width: 9 },
      { header: 'Barrio / localidad', key: 'residence', width: 24 },
      { header: 'Restricciones médicas', key: 'medicalRestrictions', width: 28 },
      { header: 'Transporte', key: 'transportMode', width: 18 },
      { header: 'Estado', key: 'status', width: 16 },
      { header: 'Vacante', key: 'vacancy', width: 30 },
      { header: 'Ciudad', key: 'city', width: 20 },
      { header: 'HV', key: 'hasCv', width: 10 },
      { header: 'Motivo rechazo', key: 'rejectionReason', width: 28 }
    ];

    for (const candidate of candidates) {
      const vacancy = candidate.vacancy || {};
      const whatsappLink = buildWhatsAppLink(candidate.phone);
      const row = sheet.addRow({
        createdAt: formatDateTimeCO(candidate.createdAt),
        fullName: candidate.fullName || '',
        phone: candidate.phone || '',
        documentType: candidate.documentType || '',
        documentNumber: candidate.documentNumber || '',
        age: candidate.age ?? '',
        residence: getCandidateResidenceValue(candidate, vacancy) || candidate.zone || '',
        medicalRestrictions: candidate.medicalRestrictions || '',
        transportMode: candidate.transportMode || '',
        status: statusLabel(candidate.status),
        vacancy: vacancy.title || vacancy.role || '',
        city: vacancy.city || '',
        hasCv: candidateHasCv(candidate) ? 'Sí' : 'No',
        rejectionReason: candidate.rejectionReason || ''
      });
      if (whatsappLink) {
        row.getCell('phone').value = { text: candidate.phone || '', hyperlink: whatsappLink };
        row.getCell('phone').font = { underline: true };
      }
    }

    styleWorksheet(sheet);

    const filename = exportFilenameByScope(scope);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  });

  return router;
}
