// Importa Express para crear el router del panel administrativo.
import express from 'express';
import ExcelJS from 'exceljs';
import path from 'node:path';
import multer from 'multer';
import { normalizeCandidateFields } from '../services/candidateData.js';
import { exportFilenameByScope, filterCandidatesByScope, normalizeCandidateStatusForUI } from '../services/candidateExport.js';
import { sendTextMessage } from '../services/whatsapp.js';
import { MessageDirection, MessageType } from '@prisma/client';
import { buildTechnicalOutboundCandidateUpdate } from '../services/adminOutboundPolicy.js';
import { describeResumeBehavior } from '../services/botAutomationPolicy.js';
import { isAllowedAdImageFile, normalizeAdTextHints } from '../services/vacancyAdmin.js';
import {
  getAvailableSlots,
  buildSlotLabel,
  cancelInterview,
  rescheduleInterview
} from '../services/interviewFlow.js';

// Middleware de autenticación por sesión para proteger el dashboard.
function sessionAuth(req, res, next) {
  const role = req.session?.userRole;
  if (!role) return res.redirect('/login');
  req.userRole = role;
  return next();
}

// Normaliza strings de formularios: trim y null si queda vacío.
function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseAliasesInput(value) {
  const normalized = normalizeString(value);
  if (!normalized) return [];
  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim()).filter(Boolean);
  } catch {
    return normalized.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

// Formatea fechas para el dashboard en zona horaria de Colombia (Bogotá).
function formatDateTimeCO(value) {
  if (!value) return '';
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

// Mapeo de estados enum a texto legible.
const STATUS_LABELS = {
  'NUEVO': 'Nuevo',
  'REGISTRADO': 'Registrado',
  'VALIDANDO': 'Registrado',
  'APROBADO': 'Registrado',
  'RECHAZADO': 'Rechazado',
  'CONTACTADO': 'Contactado'
};

const ADMIN_STATUS_SCOPES = new Set(['registered', 'new', 'contacted', 'rejected', 'all']);
const EXPORT_SCOPES = new Set(['registered', 'missing_cv_complete', 'new', 'contacted', 'rejected', 'all']);

const STATUS_SCOPE_SUMMARY_LABELS = {
  registered: 'registrados',
  new: 'nuevos',
  contacted: 'contactados',
  rejected: 'rechazados',
  all: 'totales'
};

const ALLOWED_CV_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const ALLOWED_CV_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);

// Estados de entrevista con etiquetas y colores para la UI.
const INTERVIEW_STATUS_LABELS = {
  PENDING: { label: 'Pendiente', color: 'yellow' },
  CONFIRMED: { label: 'Confirmada', color: 'green' },
  CANCELLED: { label: 'Cancelada', color: 'red' },
  RESCHEDULED: { label: 'Reprogramada', color: 'blue' },
  COMPLETED: { label: 'Completada', color: 'gray' },
  NO_SHOW: { label: 'No se presentó', color: 'orange' }
};

function buildCvStatusQuery(type, message) {
  const params = new URLSearchParams();
  params.set(type, message);
  return params.toString();
}

function isAllowedCvFile(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED_CV_MIMES.has(file.mimetype)) return true;
  const mimeMissingOrGeneric = !file.mimetype || file.mimetype === 'application/octet-stream';
  return mimeMissingOrGeneric && ALLOWED_CV_EXTENSIONS.has(extension);
}

function normalizeBinaryData(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value);
}

function ensureDevRole(req, res, next) {
  if (req.userRole !== 'dev') return res.status(403).send('Acceso restringido a desarrolladores');
  return next();
}

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

async function getOutboundWindowStatus(prisma, candidateId, now = new Date()) {
  const lastInbound = await prisma.message.findFirst({
    where: { candidateId, direction: MessageDirection.INBOUND },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true }
  });
  const lastInboundAt = lastInbound?.createdAt || null;
  const isOpen = Boolean(lastInboundAt) && (now.getTime() - new Date(lastInboundAt).getTime()) <= WHATSAPP_WINDOW_MS;
  return { hasInbound: Boolean(lastInboundAt), lastInboundAt, isOpen };
}

function outboundTemplates(candidate) {
  return {
    request_missing_data: 'Hola 👋 Para continuar con tu postulación, por favor envíame los datos faltantes que aún no has compartido.',
    request_hv: 'Hola 👋 Para continuar tu proceso necesito tu Hoja de vida (HV) en PDF o Word (.doc/.docx).',
    reminder: 'Te recuerdo que tu proceso sigue activo. Si deseas continuar, comparte la información faltante o tu Hoja de vida (HV).'
  };
}

function toHexPreview(buffer, maxBytes = 16) {
  if (!buffer || !buffer.length) return '';
  return buffer.subarray(0, maxBytes).toString('hex');
}

function shouldValidatePdfSignature(filename = '', mimeType = '') {
  return mimeType === 'application/pdf' || path.extname(filename || '').toLowerCase() === '.pdf';
}

function hasPdfSignature(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
}

// Expone el router administrativo.
export function adminRouter(prisma) {
  const router = express.Router();
  const cvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
  }).single('cvFile');
  const adImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
  }).single('adImageFile');

  // Protege todas las rutas del dashboard con autenticación por sesión.
  router.use(sessionAuth);

  // ─── VACANTES ─────────────────────────────────────────────────────────────

  router.get('/vacancies', async (req, res) => {
    const vacancies = typeof prisma.vacancy?.findMany === 'function'
      ? await prisma.vacancy.findMany({ orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] })
      : [];
    res.render('vacancies', { vacancies, role: req.userRole });
  });

  router.get('/vacancies/new', async (req, res) => {
    res.render('vacancy-form', { vacancy: null, role: req.userRole, mode: 'create' });
  });

  router.get('/vacancies/:id/edit', async (req, res) => {
    if (typeof prisma.vacancy?.findUnique !== 'function') return res.status(404).send('Vacante no encontrada');
    const vacancy = await prisma.vacancy.findUnique({ where: { id: req.params.id } });
    if (!vacancy) return res.status(404).send('Vacante no encontrada');
    res.render('vacancy-form', {
      vacancy: {
        ...vacancy,
        aliasesText: Array.isArray(vacancy.aliases) ? vacancy.aliases.join(', ') : '',
        hasAdImage: Boolean(vacancy.adImageData)
      },
      role: req.userRole,
      mode: 'edit'
    });
  });

  router.post('/vacancies', express.urlencoded({ extended: true }), async (req, res) => {
    if (typeof prisma.vacancy?.create !== 'function') return res.status(500).send('Módulo de vacantes no disponible');
    await prisma.vacancy.create({
      data: {
        key: normalizeString(req.body.key),
        title: normalizeString(req.body.title),
        city: normalizeString(req.body.city),
        description: normalizeString(req.body.description),
        profile: normalizeString(req.body.profile),
        botIntroText: normalizeString(req.body.botIntroText),
        requirementsSummary: normalizeString(req.body.requirementsSummary),
        adTextHints: normalizeAdTextHints(req.body.adTextHints),
        aliases: parseAliasesInput(req.body.aliases),
        isActive: req.body.isActive === 'on',
        displayOrder: Number.parseInt(req.body.displayOrder || '0', 10) || 0
      }
    });
    res.redirect('/admin/vacancies');
  });

  router.post('/vacancies/:id', express.urlencoded({ extended: true }), async (req, res) => {
    if (typeof prisma.vacancy?.update !== 'function') return res.status(500).send('Módulo de vacantes no disponible');
    await prisma.vacancy.update({
      where: { id: req.params.id },
      data: {
        title: normalizeString(req.body.title),
        city: normalizeString(req.body.city),
        description: normalizeString(req.body.description),
        profile: normalizeString(req.body.profile),
        botIntroText: normalizeString(req.body.botIntroText),
        requirementsSummary: normalizeString(req.body.requirementsSummary),
        adTextHints: normalizeAdTextHints(req.body.adTextHints),
        aliases: parseAliasesInput(req.body.aliases),
        isActive: req.body.isActive === 'on',
        displayOrder: Number.parseInt(req.body.displayOrder || '0', 10) || 0
      }
    });
    res.redirect('/admin/vacancies');
  });

  router.post('/vacancies/:id/toggle', async (req, res) => {
    if (typeof prisma.vacancy?.findUnique !== 'function' || typeof prisma.vacancy?.update !== 'function') {
      return res.status(500).send('Módulo de vacantes no disponible');
    }
    const vacancy = await prisma.vacancy.findUnique({ where: { id: req.params.id }, select: { id: true, isActive: true } });
    if (!vacancy) return res.status(404).send('Vacante no encontrada');
    await prisma.vacancy.update({ where: { id: req.params.id }, data: { isActive: !vacancy.isActive } });
    res.redirect('/admin/vacancies');
  });

  router.get('/vacancies/:id/ad-image', async (req, res) => {
    if (typeof prisma.vacancy?.findUnique !== 'function') return res.status(404).send('Vacante no encontrada');
    const vacancy = await prisma.vacancy.findUnique({
      where: { id: req.params.id },
      select: { adImageData: true, adImageMimeType: true }
    });
    if (!vacancy?.adImageData) return res.status(404).send('Imagen no encontrada');
    const buffer = normalizeBinaryData(vacancy.adImageData);
    res.setHeader('Content-Type', vacancy.adImageMimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  });

  router.post('/vacancies/:id/ad-image/upload', (req, res) => {
    adImageUpload(req, res, async (error) => {
      const vacancyId = req.params.id;
      if (error) return res.status(400).send('No se pudo procesar la imagen publicitaria.');
      if (!req.file || !isAllowedAdImageFile(req.file)) {
        return res.status(400).send('Archivo inválido. Solo se permiten imágenes JPG, PNG o WEBP.');
      }
      if (typeof prisma.vacancy?.update !== 'function') return res.status(500).send('Módulo de vacantes no disponible');
      await prisma.vacancy.update({
        where: { id: vacancyId },
        data: {
          adImageData: normalizeBinaryData(req.file.buffer),
          adImageMimeType: req.file.mimetype || null,
          adImageOriginalName: req.file.originalname || null
        }
      });
      return res.redirect(`/admin/vacancies/${vacancyId}/edit`);
    });
  });

  router.post('/vacancies/:id/ad-image/delete', async (req, res) => {
    if (typeof prisma.vacancy?.update !== 'function') return res.status(500).send('Módulo de vacantes no disponible');
    await prisma.vacancy.update({
      where: { id: req.params.id },
      data: { adImageData: null, adImageMimeType: null, adImageOriginalName: null }
    });
    return res.redirect(`/admin/vacancies/${req.params.id}/edit`);
  });

  // ─── CANDIDATOS ───────────────────────────────────────────────────────────

  router.get('/', async (req, res) => {
    const requestedStatus = normalizeString(req.query.status);
    const statusScope = ADMIN_STATUS_SCOPES.has(requestedStatus) ? requestedStatus : 'registered';
    const allCandidates = await prisma.candidate.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200
    });
    const candidates = filterCandidatesByScope(allCandidates, statusScope);
    res.render('list', {
      candidates,
      formatDateTimeCO,
      role: req.userRole,
      activeStatusScope: statusScope,
      summaryLabel: STATUS_SCOPE_SUMMARY_LABELS[statusScope] || STATUS_SCOPE_SUMMARY_LABELS.all,
      futureFilters: { cityId: null, vacancyId: null },
      normalizeCandidateStatusForUI
    });
  });

  router.get('/candidates/:id', async (req, res) => {
    const includeMessages = req.userRole === 'dev';
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      include: includeMessages
        ? { messages: { orderBy: { createdAt: 'desc' }, take: 50 } }
        : undefined
    });
    if (!candidate) return res.status(404).send('Candidato no encontrado');

    // Entrevista activa (PENDING o CONFIRMED) con slot asociado.
    let activeInterview = null;
    if (typeof prisma.interview?.findFirst === 'function') {
      activeInterview = await prisma.interview.findFirst({
        where: {
          candidateId: candidate.id,
          status: { in: ['PENDING', 'CONFIRMED'] }
        },
        include: { slot: true },
        orderBy: { createdAt: 'desc' }
      });
    }

    const cvBuffer = normalizeBinaryData(candidate.cvData);
    const cvError = normalizeString(req.query.cvError);
    const cvSuccess = normalizeString(req.query.cvSuccess);
    const outboundError = normalizeString(req.query.outboundError);
    const outboundSuccess = normalizeString(req.query.outboundSuccess);
    const botPauseSuccess = normalizeString(req.query.botPauseSuccess);
    const botPauseError = normalizeString(req.query.botPauseError);
    const interviewSuccess = normalizeString(req.query.interviewSuccess);
    const interviewError = normalizeString(req.query.interviewError);
    const outboundWindow = includeMessages
      ? await getOutboundWindowStatus(prisma, candidate.id)
      : null;

    res.render('detail', {
      candidate,
      formatDateTimeCO,
      role: req.userRole,
      cvError,
      cvSuccess,
      outboundError,
      outboundSuccess,
      botPauseSuccess,
      botPauseError,
      interviewSuccess,
      interviewError,
      outboundWindow,
      cvSizeBytes: cvBuffer?.byteLength || 0,
      normalizeCandidateStatusForUI,
      activeInterview,
      buildSlotLabel,
      interviewStatusLabels: INTERVIEW_STATUS_LABELS
    });
  });

  router.post('/candidates/:id/edit', express.urlencoded({ extended: true }), async (req, res) => {
    const fullName = normalizeString(req.body.fullName);
    const documentType = normalizeString(req.body.documentType);
    const documentNumber = normalizeString(req.body.documentNumber);
    const neighborhood = normalizeString(req.body.neighborhood);
    const experienceInfo = normalizeString(req.body.experienceInfo);
    const transportMode = normalizeString(req.body.transportMode);
    const status = normalizeString(req.body.status);
    const rejectionReason = normalizeString(req.body.rejectionReason);
    const rejectionDetails = normalizeString(req.body.rejectionDetails);
    const experienceTime = normalizeString(req.body.experienceTime);
    const medicalRestrictions = normalizeString(req.body.medicalRestrictions);
    const rawAge = typeof req.body.age === 'string' ? req.body.age.trim() : '';
    let age = null;
    if (rawAge !== '') {
      const parsedAge = Number.parseInt(rawAge, 10);
      age = Number.isNaN(parsedAge) ? null : parsedAge;
    }
    const normalizedFields = normalizeCandidateFields({
      fullName, documentType, documentNumber, neighborhood,
      experienceInfo, experienceTime, medicalRestrictions, transportMode
    });
    await prisma.candidate.update({
      where: { id: req.params.id },
      data: {
        fullName: normalizedFields.fullName ?? fullName,
        documentType: normalizedFields.documentType ?? documentType,
        documentNumber: normalizedFields.documentNumber ?? documentNumber,
        age,
        neighborhood: normalizedFields.neighborhood ?? neighborhood,
        experienceInfo: normalizedFields.experienceInfo ?? experienceInfo,
        experienceTime: normalizedFields.experienceTime ?? experienceTime,
        medicalRestrictions: normalizedFields.medicalRestrictions ?? medicalRestrictions,
        transportMode: normalizedFields.transportMode ?? transportMode,
        status,
        rejectionReason,
        rejectionDetails
      }
    });
    res.redirect(`/admin/candidates/${req.params.id}`);
  });

  router.post('/candidates/:id/status', express.urlencoded({ extended: true }), async (req, res) => {
    await prisma.candidate.update({ where: { id: req.params.id }, data: { status: req.body.status } });
    res.redirect(`/admin/candidates/${req.params.id}`);
  });

  router.get('/candidates/:id/cv', async (req, res) => {
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      select: { cvData: true, cvOriginalName: true, cvMimeType: true }
    });
    if (!candidate || !candidate.cvData) return res.status(404).send('Hoja de vida no encontrada');
    const filename = candidate.cvOriginalName || 'hoja_de_vida';
    const mimeType = candidate.cvMimeType || 'application/octet-stream';
    const cvBuffer = normalizeBinaryData(candidate.cvData);
    console.log('[CV_DOWNLOAD_TRACE]', JSON.stringify({
      candidateId: req.params.id, role: req.userRole, filename,
      mime: mimeType, byteLength: cvBuffer.byteLength, hexHead: toHexPreview(cvBuffer)
    }));
    if (shouldValidatePdfSignature(filename, mimeType) && !hasPdfSignature(cvBuffer)) {
      console.warn('[CV_DOWNLOAD_TRACE]', JSON.stringify({
        candidateId: req.params.id, warning: 'pdf_signature_mismatch', filename, mime: mimeType
      }));
    }
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(cvBuffer.byteLength));
    res.setHeader('Cache-Control', 'no-store');
    res.send(cvBuffer);
  });

  router.post('/candidates/:id/cv/upload', (req, res) => {
    cvUpload(req, res, async error => {
      try {
        const candidateId = req.params.id;
        const candidate = await prisma.candidate.findUnique({
          where: { id: candidateId },
          select: { id: true, cvData: true }
        });
        if (!candidate) return res.status(404).send('Candidato no encontrado');
        if (error) {
          if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
            const query = buildCvStatusQuery('cvError', 'El archivo supera el tamaño máximo permitido (10MB).');
            return res.redirect(`/admin/candidates/${candidateId}?${query}`);
          }
          const query = buildCvStatusQuery('cvError', 'No se pudo procesar el archivo adjunto.');
          return res.redirect(`/admin/candidates/${candidateId}?${query}`);
        }
        const file = req.file;
        if (!file) {
          const query = buildCvStatusQuery('cvError', 'Debes seleccionar un archivo PDF, DOC o DOCX.');
          return res.redirect(`/admin/candidates/${candidateId}?${query}`);
        }
        if (!isAllowedCvFile(file)) {
          const query = buildCvStatusQuery('cvError', 'Archivo inválido. Solo se permiten PDF, DOC o DOCX.');
          return res.redirect(`/admin/candidates/${candidateId}?${query}`);
        }
        const uploadBuffer = normalizeBinaryData(req.file.buffer);
        if (shouldValidatePdfSignature(file.originalname, file.mimetype) && !hasPdfSignature(uploadBuffer)) {
          console.warn('[CV_MANUAL_UPLOAD]', JSON.stringify({
            candidateId, warning: 'pdf_signature_mismatch',
            filename: file.originalname, mime: file.mimetype
          }));
        }
        const updatedCandidate = await prisma.candidate.update({
          where: { id: candidateId },
          data: { cvData: uploadBuffer, cvOriginalName: file.originalname, cvMimeType: file.mimetype },
          select: { cvData: true }
        });
        const storedCvBuffer = normalizeBinaryData(updatedCandidate.cvData);
        const action = candidate.cvData ? '[CV_MANUAL_REPLACE]' : '[CV_MANUAL_UPLOAD]';
        console.log(action, JSON.stringify({
          candidateId, role: req.userRole, filename: file.originalname,
          mimeType: file.mimetype, byteLength: storedCvBuffer.byteLength
        }));
        const successMessage = candidate.cvData ? 'Hoja de vida reemplazada correctamente.' : 'Hoja de vida cargada correctamente.';
        const query = buildCvStatusQuery('cvSuccess', successMessage);
        return res.redirect(`/admin/candidates/${candidateId}?${query}`);
      } catch (_unexpectedError) {
        return res.status(500).send('Error interno al procesar la hoja de vida');
      }
    });
  });

  router.post('/candidates/:id/cv/delete', async (req, res) => {
    const candidateId = req.params.id;
    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { id: true, cvData: true }
    });
    if (!candidate) return res.status(404).send('Candidato no encontrado');
    await prisma.candidate.update({
      where: { id: candidateId },
      data: { cvData: null, cvOriginalName: null, cvMimeType: null }
    });
    console.log('[CV_MANUAL_DELETE]', JSON.stringify({ candidateId, role: req.userRole, hadCv: Boolean(candidate.cvData) }));
    const query = buildCvStatusQuery('cvSuccess', 'Hoja de vida eliminada correctamente.');
    return res.redirect(`/admin/candidates/${candidateId}?${query}`);
  });

  // ─── ENTREVISTAS: ACCIONES SOBRE EL CANDIDATO ─────────────────────────────

  // Cancelar entrevista activa de un candidato desde el panel.
  router.post('/candidates/:id/interview/cancel', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const candidateId = req.params.id;
    try {
      const result = await cancelInterview(prisma, candidateId);
      if (!result.ok) {
        const query = buildCvStatusQuery('interviewError', result.reason || 'No se pudo cancelar la entrevista.');
        return res.redirect(`/admin/candidates/${candidateId}?${query}`);
      }
      const query = buildCvStatusQuery('interviewSuccess', 'Entrevista cancelada correctamente.');
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    } catch (_err) {
      const query = buildCvStatusQuery('interviewError', 'Error interno al cancelar la entrevista.');
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    }
  });

  // Reprogramar entrevista activa de un candidato: devuelve al estado SCHEDULING_INTERVIEW.
  router.post('/candidates/:id/interview/reschedule', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const candidateId = req.params.id;
    try {
      const result = await rescheduleInterview(prisma, candidateId);
      if (!result.ok) {
        const query = buildCvStatusQuery('interviewError', result.reason || 'No se pudo reprogramar la entrevista.');
        return res.redirect(`/admin/candidates/${candidateId}?${query}`);
      }
      const query = buildCvStatusQuery('interviewSuccess', 'Entrevista marcada para reprogramación. El candidato recibirá nuevas opciones.');
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    } catch (_err) {
      const query = buildCvStatusQuery('interviewError', 'Error interno al reprogramar la entrevista.');
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    }
  });

  // Marcar entrevista como COMPLETED o NO_SHOW desde el panel.
  router.post('/candidates/:id/interview/outcome', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const candidateId = req.params.id;
    const outcome = normalizeString(req.body.outcome);
    const VALID_OUTCOMES = new Set(['COMPLETED', 'NO_SHOW']);
    if (!outcome || !VALID_OUTCOMES.has(outcome)) {
      const query = buildCvStatusQuery('interviewError', 'Resultado inválido.');
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    }
    try {
      const activeInterview = typeof prisma.interview?.findFirst === 'function'
        ? await prisma.interview.findFirst({
            where: { candidateId, status: { in: ['PENDING', 'CONFIRMED'] } },
            orderBy: { createdAt: 'desc' }
          })
        : null;
      if (!activeInterview) {
        const query = buildCvStatusQuery('interviewError', 'No hay entrevista activa para este candidato.');
        return res.redirect(`/admin/candidates/${candidateId}?${query}`);
      }
      await prisma.interview.update({
        where: { id: activeInterview.id },
        data: { status: outcome }
      });
      const query = buildCvStatusQuery('interviewSuccess', outcome === 'COMPLETED' ? 'Entrevista marcada como completada.' : 'Candidato marcado como no presentado.');
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    } catch (_err) {
      const query = buildCvStatusQuery('interviewError', 'Error interno al registrar resultado.');
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    }
  });

  // ─── AGENDA GLOBAL DE ENTREVISTAS ─────────────────────────────────────────

  // Vista de agenda: todas las entrevistas, filtrable por vacante y estado.
  router.get('/interviews', async (req, res) => {
    const vacancyId = normalizeString(req.query.vacancyId);
    const statusFilter = normalizeString(req.query.status);
    const VALID_STATUSES = new Set(['PENDING', 'CONFIRMED', 'CANCELLED', 'RESCHEDULED', 'COMPLETED', 'NO_SHOW']);

    const whereClause = {};
    if (statusFilter && VALID_STATUSES.has(statusFilter)) whereClause.status = statusFilter;
    if (vacancyId) whereClause.slot = { vacancyId };

    const interviews = typeof prisma.interview?.findMany === 'function'
      ? await prisma.interview.findMany({
          where: whereClause,
          include: {
            candidate: { select: { id: true, fullName: true, phone: true, status: true } },
            slot: { include: { vacancy: { select: { id: true, title: true, key: true } } } }
          },
          orderBy: { createdAt: 'desc' },
          take: 300
        })
      : [];

    const vacancies = typeof prisma.vacancy?.findMany === 'function'
      ? await prisma.vacancy.findMany({ orderBy: [{ displayOrder: 'asc' }, { title: 'asc' }], select: { id: true, title: true, key: true } })
      : [];

    res.render('interviews', {
      interviews,
      vacancies,
      formatDateTimeCO,
      role: req.userRole,
      activeVacancyId: vacancyId || null,
      activeStatus: statusFilter || null,
      interviewStatusLabels: INTERVIEW_STATUS_LABELS,
      buildSlotLabel
    });
  });

  // ─── SLOTS DE ENTREVISTA ───────────────────────────────────────────────────

  // Listado de slots por vacante.
  router.get('/interview-slots', async (req, res) => {
    const vacancyId = normalizeString(req.query.vacancyId);

    const slots = typeof prisma.interviewSlot?.findMany === 'function'
      ? await prisma.interviewSlot.findMany({
          where: vacancyId ? { vacancyId } : undefined,
          include: {
            vacancy: { select: { id: true, title: true, key: true } },
            _count: { select: { interviews: true } }
          },
          orderBy: { scheduledAt: 'asc' }
        })
      : [];

    const vacancies = typeof prisma.vacancy?.findMany === 'function'
      ? await prisma.vacancy.findMany({ orderBy: [{ displayOrder: 'asc' }, { title: 'asc' }], select: { id: true, title: true, key: true } })
      : [];

    res.render('interview-slots', {
      slots,
      vacancies,
      formatDateTimeCO,
      role: req.userRole,
      activeVacancyId: vacancyId || null,
      buildSlotLabel
    });
  });

  // Formulario de creación de slot.
  router.get('/interview-slots/new', ensureDevRole, async (req, res) => {
    const vacancyId = normalizeString(req.query.vacancyId);
    const vacancies = typeof prisma.vacancy?.findMany === 'function'
      ? await prisma.vacancy.findMany({ where: { isActive: true }, orderBy: [{ displayOrder: 'asc' }, { title: 'asc' }], select: { id: true, title: true, key: true } })
      : [];
    res.render('interview-slot-form', {
      role: req.userRole,
      vacancies,
      preselectedVacancyId: vacancyId || null
    });
  });

  // Crear slot.
  router.post('/interview-slots', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    if (typeof prisma.interviewSlot?.create !== 'function') return res.status(500).send('Módulo de slots no disponible');

    const vacancyId = normalizeString(req.body.vacancyId);
    const scheduledAtRaw = normalizeString(req.body.scheduledAt); // datetime-local: "2026-04-10T10:00"
    const capacity = Math.max(1, Number.parseInt(req.body.capacity || '1', 10) || 1);
    const location = normalizeString(req.body.location);
    const notes = normalizeString(req.body.notes);
    const expiresMinutes = Number.parseInt(req.body.expiresMinutes || '60', 10) || 60;

    if (!vacancyId || !scheduledAtRaw) {
      return res.status(400).send('Vacante y fecha/hora son requeridos.');
    }

    // Parsear datetime-local como hora de Bogotá.
    const scheduledAt = new Date(scheduledAtRaw + ':00-05:00');
    if (Number.isNaN(scheduledAt.getTime())) return res.status(400).send('Fecha/hora inválida.');

    const expiresAt = new Date(scheduledAt.getTime() - expiresMinutes * 60 * 1000);

    await prisma.interviewSlot.create({
      data: { vacancyId, scheduledAt, capacity, location, notes, expiresAt }
    });

    return res.redirect(`/admin/interview-slots?vacancyId=${encodeURIComponent(vacancyId)}`);
  });

  // Eliminar slot (solo si no tiene entrevistas activas).
  router.post('/interview-slots/:id/delete', ensureDevRole, async (req, res) => {
    const slotId = req.params.id;
    if (typeof prisma.interviewSlot?.findUnique !== 'function') return res.status(500).send('Módulo de slots no disponible');

    const slot = await prisma.interviewSlot.findUnique({
      where: { id: slotId },
      include: { _count: { select: { interviews: true } }, vacancy: { select: { id: true } } }
    });
    if (!slot) return res.status(404).send('Slot no encontrado');

    if (slot._count.interviews > 0) {
      return res.status(400).send('No se puede eliminar un slot con entrevistas registradas. Cancela las entrevistas primero.');
    }

    await prisma.interviewSlot.delete({ where: { id: slotId } });
    return res.redirect(`/admin/interview-slots?vacancyId=${encodeURIComponent(slot.vacancy.id)}`);
  });

  // ─── EXPORTACIÓN ──────────────────────────────────────────────────────────

  router.get('/export', async (req, res) => {
    const requestedScope = normalizeString(req.query.scope);
    const scope = EXPORT_SCOPES.has(requestedScope) ? requestedScope : 'all';
    const allCandidates = await prisma.candidate.findMany({ orderBy: { createdAt: 'desc' } });
    const candidates = filterCandidatesByScope(allCandidates, scope);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Candidatos');
    sheet.columns = [
      { header: 'Fecha de registro', key: 'createdAt', width: 20 },
      { header: 'Nombre completo', key: 'fullName', width: 30 },
      { header: 'Teléfono', key: 'phone', width: 18 },
      { header: 'Tipo documento', key: 'documentType', width: 15 },
      { header: 'Número documento', key: 'documentNumber', width: 18 },
      { header: 'Edad', key: 'age', width: 8 },
      { header: 'Barrio', key: 'neighborhood', width: 20 },
      { header: 'Experiencia', key: 'experienceInfo', width: 15 },
      { header: 'Tiempo de experiencia', key: 'experienceTime', width: 20 },
      { header: 'Restricciones médicas', key: 'medicalRestrictions', width: 25 },
      { header: 'Medio de transporte', key: 'transportMode', width: 20 },
      { header: 'Hoja de vida adjunta', key: 'cvAttached', width: 18 },
      { header: 'Estado', key: 'status', width: 15 },
      { header: 'Motivo rechazo', key: 'rejectionReason', width: 24 },
      { header: 'Detalle rechazo', key: 'rejectionDetails', width: 32 },
      { header: 'WhatsApp', key: 'whatsapp', width: 15 }
    ];
    sheet.getRow(1).font = { bold: true };
    for (const c of candidates) {
      const row = sheet.addRow({
        createdAt: formatDateTimeCO(c.createdAt),
        fullName: c.fullName || '',
        phone: c.phone,
        documentType: c.documentType || '',
        documentNumber: c.documentNumber || '',
        age: c.age || '',
        neighborhood: c.neighborhood || c.zone || '',
        experienceInfo: c.experienceInfo || '',
        experienceTime: c.experienceTime || '',
        medicalRestrictions: c.medicalRestrictions || '',
        transportMode: c.transportMode || '',
        cvAttached: c.cvData ? 'Sí' : 'No',
        status: STATUS_LABELS[normalizeCandidateStatusForUI(c.status)] || normalizeCandidateStatusForUI(c.status),
        rejectionReason: c.rejectionReason || '',
        rejectionDetails: c.rejectionDetails || '',
        whatsapp: 'Escribir'
      });
      row.getCell('phone').numFmt = '@';
      row.getCell('documentNumber').numFmt = '@';
      row.getCell('whatsapp').value = { text: 'Escribir', hyperlink: `https://wa.me/${c.phone}` };
      row.getCell('whatsapp').font = { color: { argb: 'FF0066CC' }, underline: true };
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilenameByScope(scope)}"`);
    await workbook.xlsx.write(res);
    res.end();
  });

  // ─── MONITOR (solo dev) ───────────────────────────────────────────────────

  router.get('/monitor', async (req, res) => {
    if (req.userRole !== 'dev') return res.status(403).send('Acceso restringido a desarrolladores');
    const messages = await prisma.message.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { candidate: { select: { phone: true, fullName: true, currentStep: true } } }
    });
    res.render('monitor', { messages, formatDateTimeCO, role: req.userRole });
  });

  router.get('/monitor/api', async (req, res) => {
    if (req.userRole !== 'dev') return res.status(403).json({ error: 'Acceso restringido a desarrolladores' });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const messages = await prisma.message.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { candidate: { select: { phone: true, fullName: true, currentStep: true } } }
    });
    const result = messages.map(m => {
      const trace = m.rawPayload?.debugTrace || null;
      return {
        timestamp: m.createdAt,
        phone: m.candidate.phone,
        candidateName: m.candidate.fullName || '',
        direction: m.direction,
        body: m.body || '',
        currentStep: m.candidate.currentStep,
        debugTrace: trace ? {
          openai_status: trace.openai_status,
          openai_intent: trace.openai_intent,
          openai_detected_fields: trace.openai_detected_fields || [],
          persisted_fields: trace.persisted_fields || [],
          rejected_fields: trace.rejected_fields || [],
          cv_detected: Boolean(trace.cv_detected),
          cv_saved: Boolean(trace.cv_saved),
          cv_invalid_mime: Boolean(trace.cv_invalid_mime),
          cv_download_failed: Boolean(trace.cv_download_failed),
          error_summary: trace.error_summary || null
        } : null
      };
    });
    res.json(result);
  });

  // ─── OUTBOUND / PAUSA (solo dev) ──────────────────────────────────────────

  router.post('/candidates/:id/outbound', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const candidateId = req.params.id;
    const action = normalizeString(req.body.action);
    const customBody = normalizeString(req.body.customBody);
    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { id: true, phone: true, status: true }
    });
    if (!candidate) return res.status(404).send('Candidato no encontrado');
    const outboundWindow = await getOutboundWindowStatus(prisma, candidateId);
    if (!outboundWindow.isOpen) {
      const lastInboundLabel = outboundWindow.lastInboundAt ? formatDateTimeCO(outboundWindow.lastInboundAt) : 'sin mensajes inbound del candidato';
      const windowLabel = outboundWindow.hasInbound ? 'vencida' : 'sin iniciar';
      const query = buildCvStatusQuery('outboundError', `No se puede enviar: ventana de WhatsApp ${windowLabel}. Último mensaje: ${lastInboundLabel}.`);
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    }
    const templates = outboundTemplates(candidate);
    let body = templates[action];
    if (action === 'free_text') body = customBody;
    if (!body) {
      const query = buildCvStatusQuery('outboundError', 'No se pudo enviar el mensaje saliente por contenido inválido.');
      return res.redirect(`/admin/candidates/${candidateId}?${query}`);
    }
    await sendTextMessage(candidate.phone, body);
    await prisma.message.create({
      data: {
        candidateId,
        direction: MessageDirection.OUTBOUND,
        messageType: MessageType.TEXT,
        body,
        rawPayload: { source: 'dev_dashboard', action }
      }
    });
    await prisma.candidate.update({ where: { id: candidateId }, data: buildTechnicalOutboundCandidateUpdate(new Date()) });
    const query = buildCvStatusQuery('outboundSuccess', 'Mensaje saliente enviado correctamente.');
    return res.redirect(`/admin/candidates/${candidateId}?${query}`);
  });

  router.post('/candidates/:id/bot-pause', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const candidateId = req.params.id;
    const reason = normalizeString(req.body.reason) || 'Pausa manual desde dashboard';
    const candidate = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { id: true } });
    if (!candidate) return res.status(404).send('Candidato no encontrado');
    await prisma.candidate.update({
      where: { id: candidateId },
      data: { botPaused: true, botPausedAt: new Date(), botPausedBy: req.userRole || 'admin', botPauseReason: reason }
    });
    const query = buildCvStatusQuery('botPauseSuccess', 'Bot pausado manualmente.');
    return res.redirect(`/admin/candidates/${candidateId}?${query}`);
  });

  router.post('/candidates/:id/bot-resume', ensureDevRole, async (req, res) => {
    const candidateId = req.params.id;
    const candidate = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { id: true } });
    if (!candidate) return res.status(404).send('Candidato no encontrado');
    let pendingInboundCount = 0;
    if (typeof prisma.message?.count === 'function') {
      pendingInboundCount = await prisma.message.count({
        where: { candidateId, direction: MessageDirection.INBOUND, messageType: MessageType.TEXT, respondedAt: null }
      });
    } else if (typeof prisma.message?.findMany === 'function') {
      const pending = await prisma.message.findMany({
        where: { candidateId, direction: MessageDirection.INBOUND, messageType: MessageType.TEXT, respondedAt: null }
      });
      pendingInboundCount = pending.length;
    }
    const resumeBehavior = describeResumeBehavior({ pendingInboundCount, supportsImmediateReplay: false });
    await prisma.candidate.update({
      where: { id: candidateId },
      data: { botPaused: false, botResumeMode: resumeBehavior.resumeMode }
    });
    const query = buildCvStatusQuery('botPauseSuccess', 'Bot reanudado manualmente.');
    return res.redirect(`/admin/candidates/${candidateId}?${query}`);
  });

  return router;
}
