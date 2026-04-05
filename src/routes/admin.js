// Importa Express para crear el router del panel administrativo.
import express from 'express';
import ExcelJS from 'exceljs';
import path from 'node:path';
import multer from 'multer';
import { normalizeCandidateFields } from '../services/candidateData.js';
import { candidateHasCv, exportFilenameByScope, filterCandidatesByScope, normalizeCandidateStatusForUI } from '../services/candidateExport.js';
import { sendTextMessage } from '../services/whatsapp.js';
import { MessageDirection, MessageType } from '@prisma/client';
import { buildTechnicalOutboundCandidateUpdate } from '../services/adminOutboundPolicy.js';
import { describeResumeBehavior } from '../services/botAutomationPolicy.js';

function sessionAuth(req, res, next) {
  const role = req.session?.userRole;
  if (!role) return res.redirect('/login');
  req.userRole = role;
  return next();
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function toSlug(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatDateTimeCO(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function formatTimeCO(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    hour: '2-digit', minute: '2-digit', hour12: true
  }).format(date);
}

function colombiaDayBounds(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const startUTC = new Date(Date.UTC(year, month - 1, day,     5,  0,  0,   0));
  const endUTC   = new Date(Date.UTC(year, month - 1, day + 1, 4, 59, 59, 999));
  return { start: startUTC, end: endUTC };
}

function todayCO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function isValidDateString(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str);
}

const STATUS_LABELS = {
  'NUEVO': 'Nuevo', 'REGISTRADO': 'Registrado', 'VALIDANDO': 'Registrado',
  'APROBADO': 'Registrado', 'RECHAZADO': 'Rechazado', 'CONTACTADO': 'Contactado'
};

const ADMIN_STATUS_SCOPES = new Set(['registered', 'new', 'contacted', 'rejected', 'all']);
const EXPORT_SCOPES = new Set(['registered', 'missing_cv_complete', 'new', 'contacted', 'rejected', 'all']);

const STATUS_SCOPE_SUMMARY_LABELS = {
  registered: 'registrados', new: 'nuevos', contacted: 'contactados',
  rejected: 'rechazados', all: 'totales'
};

const ALLOWED_CV_MIMES = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);
const ALLOWED_CV_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);

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

async function buildDashboardData(prisma, dateStr) {
  const { start, end } = colombiaDayBounds(dateStr);

  const vacancies = await prisma.vacancy.findMany({
    where: { acceptingApplications: true },
    orderBy: [{ city: 'asc' }, { title: 'asc' }],
    include: {
      interviewBookings: {
        where: {
          scheduledAt: { gte: start, lte: end },
          status: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] }
        },
        include: {
          candidate: {
            select: {
              id: true, fullName: true, phone: true,
              documentType: true, documentNumber: true,
              age: true, neighborhood: true, status: true,
              cvData: true, gender: true
            }
          }
        },
        orderBy: { scheduledAt: 'asc' }
      },
      candidates: {
        where: { status: { in: ['NUEVO', 'REGISTRADO', 'VALIDANDO', 'APROBADO', 'CONTACTADO'] } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, fullName: true, phone: true,
          documentType: true, documentNumber: true,
          age: true, neighborhood: true, status: true,
          cvData: true, gender: true, createdAt: true,
          interviewBookings: {
            where: { status: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] } },
            select: { id: true }
          }
        }
      }
    }
  });

  const legacyCandidates = await prisma.candidate.findMany({
    where: {
      vacancyId: null,
      status: { in: ['NUEVO', 'REGISTRADO', 'VALIDANDO', 'APROBADO', 'CONTACTADO'] }
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true, fullName: true, phone: true,
      documentType: true, documentNumber: true,
      age: true, neighborhood: true, status: true,
      cvData: true, createdAt: true
    }
  });

  const citiesMap = new Map();
  const ATTENDED_STATUSES = new Set(['RECHAZADO', 'CONTACTADO']);

  for (const v of vacancies) {
    const city = v.city || 'Sin ciudad';
    if (!citiesMap.has(city)) citiesMap.set(city, []);

    const bookedCandidateIds = new Set(v.candidates
      .filter(c => c.interviewBookings.length > 0)
      .map(c => c.id));

    const enriched = {
      ...v,
      bookingsToday: v.interviewBookings.map(b => ({
        ...b,
        formattedTime: formatTimeCO(b.scheduledAt),
        formattedDateTime: formatDateTimeCO(b.scheduledAt)
      })),
      registeredNoBooking: v.schedulingEnabled
        ? v.candidates.filter(c => !bookedCandidateIds.has(c.id) && !ATTENDED_STATUSES.has(c.status))
        : [],
      cvOnlyPipeline: !v.schedulingEnabled ? v.candidates : []
    };

    citiesMap.get(city).push(enriched);
  }

  const cities = Array.from(citiesMap.entries()).map(([name, vacs]) => ({ name, vacancies: vacs }));
  return { cities, legacyCandidates };
}

function parseVacancyBody(body) {
  const str = (v) => (typeof v === 'string' ? v.trim() || null : null);
  const int = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
  const bool = (v) => v === 'true' || v === true || v === 'on';
  const time = (v) => {
    const value = str(v);
    return value && /^\d{2}:\d{2}$/.test(value) ? value : null;
  };
  const positiveInt = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const slotDays = Array.isArray(body.slotDays)
    ? body.slotDays
    : (typeof body.slotDays === 'string' ? [body.slotDays] : []);

  return {
    title:                str(body.title),
    operationId:          str(body.operationId),
    role:                 str(body.role),
    roleDescription:      str(body.description),
    requirements:         str(body.requirements),
    conditions:           str(body.conditions),
    operationAddress:     str(body.operationAddress),
    interviewAddress:     str(body.interviewAddress),
    minAge:               int(body.minAge),
    maxAge:               int(body.maxAge),
    experienceRequired:   str(body.experienceRequired) || 'INDIFFERENT',
    isActive:             bool(body.isActive),
    acceptingApplications: bool(body.acceptingApplications),
    schedulingEnabled:    bool(body.schedulingEnabled),
    slotDays:             [...new Set(slotDays
      .map((value) => parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6))].sort((a, b) => a - b),
    slotStartTime:        time(body.slotStartTime),
    slotEndTime:          time(body.slotEndTime),
    slotDurationMinutes:  positiveInt(body.slotDurationMinutes, 20),
    slotMaxCandidates:    positiveInt(body.slotMaxCandidates, 10),
  };
}

function resolveVacancyAddress(data) {
  return data.interviewAddress || data.operationAddress || '';
}

function hasValidInterviewConfig(data) {
  if (!data.schedulingEnabled) return true;
  if (!data.slotDays.length || !data.slotStartTime || !data.slotEndTime) return false;
  return data.slotStartTime < data.slotEndTime;
}

function buildWeeklyInterviewSlots(vacancyId, data) {
  return data.slotDays.map((dayOfWeek) => ({
    vacancyId,
    dayOfWeek,
    startTime: data.slotStartTime,
    endTime: data.slotEndTime,
    slotDurationMinutes: data.slotDurationMinutes,
    maxCandidates: data.slotMaxCandidates,
    isActive: true
  }));
}

async function syncVacancyInterviewSlots(prisma, vacancyId, data) {
  if (!data.schedulingEnabled) return;
  await prisma.interviewSlot.deleteMany({
    where: {
      vacancyId,
      specificDate: null
    }
  });

  const slots = buildWeeklyInterviewSlots(vacancyId, data);
  if (!slots.length) return;

  await prisma.interviewSlot.createMany({ data: slots });
}

async function loadOperation(prisma, operationId) {
  if (!operationId) return null;

  try {
    return await prisma.operation.findUnique({
      where: { id: operationId },
      include: { city: { select: { name: true } } }
    });
  } catch {
    return null;
  }
}

async function buildUniqueVacancyKey(prisma, title, city, excludeId = null) {
  const baseKey = toSlug(`${title || ''} ${city || ''}`) || 'vacancy';
  let candidateKey = baseKey;
  let suffix = 2;

  while (true) {
    const existing = await prisma.vacancy.findFirst({
      where: {
        key: candidateKey,
        ...(excludeId ? { NOT: { id: excludeId } } : {})
      },
      select: { id: true }
    });

    if (!existing) return candidateKey;
    candidateKey = `${baseKey}-${suffix}`;
    suffix += 1;
  }
}
async function loadOperations(prisma) {
  try {
    return await prisma.operation.findMany({
      orderBy: [{ city: { name: 'asc' } }, { name: 'asc' }],
      include: { city: { select: { name: true } } }
    });
  } catch {
    return [];
  }
}

async function fetchMonitorMessages(prisma) {
  return prisma.message.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { candidate: { select: { phone: true, currentStep: true } } }
  });
}

export function adminRouter(prisma) {
  const router = express.Router();
  const cvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
  }).single('cvFile');

  router.use(sessionAuth);

  // ── Dashboard principal ──────────────────────────────────────
  router.get('/', async (req, res) => {
    const requestedStatus = normalizeString(req.query.status);
    if (requestedStatus && ADMIN_STATUS_SCOPES.has(requestedStatus)) {
      const allCandidates = await prisma.candidate.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
      const candidates = filterCandidatesByScope(allCandidates, requestedStatus);
      return res.render('list', {
        mode: 'legacy', candidates, formatDateTimeCO, role: req.userRole,
        activeStatusScope: requestedStatus,
        summaryLabel: STATUS_SCOPE_SUMMARY_LABELS[requestedStatus] || STATUS_SCOPE_SUMMARY_LABELS.all,
        normalizeCandidateStatusForUI, cities: [], legacyCandidates: [],
        activeCity: null, selectedDate: todayCO(), todayStr: todayCO()
      });
    }

    const rawDate = normalizeString(req.query.date);
    const selectedDate = isValidDateString(rawDate) ? rawDate : todayCO();
    const { cities, legacyCandidates } = await buildDashboardData(prisma, selectedDate);

    const rawCity = normalizeString(req.query.city);
    const availableCities = cities.map(c => c.name);
    const activeCity = (rawCity && availableCities.includes(rawCity))
      ? rawCity : (availableCities[0] || null);

    return res.render('list', {
      mode: 'vacancies', cities, legacyCandidates, activeCity, selectedDate,
      todayStr: todayCO(), formatDateTimeCO, formatTimeCO, role: req.userRole,
      normalizeCandidateStatusForUI, candidates: [], activeStatusScope: null, summaryLabel: ''
    });
  });

  // ── Monitor (solo dev) ───────────────────────────────────────
  router.get('/monitor', ensureDevRole, async (req, res) => {
    try {
      const messages = await fetchMonitorMessages(prisma);
      res.render('monitor', { messages, formatDateTimeCO, role: req.userRole });
    } catch (err) {
      console.error('[monitor]', err);
      res.status(500).json({ error: 'internal_server_error' });
    }
  });

  router.get('/monitor/api', ensureDevRole, async (req, res) => {
    try {
      const messages = await fetchMonitorMessages(prisma);
      const payload = messages.map(m => ({
        id: m.id, direction: m.direction, body: m.body, timestamp: m.createdAt,
        phone: m.candidate?.phone || '', currentStep: m.candidate?.currentStep || '',
        debugTrace: m.rawPayload?.debugTrace || null
      }));
      res.json(payload);
    } catch (err) {
      console.error('[monitor/api]', err);
      res.status(500).json([]);
    }
  });

  // ── Exportar candidatos ──────────────────────────────────────
  router.get('/export', async (req, res) => {
    const scope = normalizeString(req.query.scope) || 'all';
    if (!EXPORT_SCOPES.has(scope)) return res.status(400).send('Scope inválido.');

    const allCandidates = await prisma.candidate.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        fullName: true,
        phone: true,
        documentType: true,
        documentNumber: true,
        age: true,
        neighborhood: true,
        zone: true,
        experienceInfo: true,
        experienceTime: true,
        medicalRestrictions: true,
        transportMode: true,
        status: true,
        rejectionReason: true,
        rejectionDetails: true,
        createdAt: true,
        cvMimeType: true,
        cvOriginalName: true
      }
    });
    const candidates = filterCandidatesByScope(allCandidates, scope);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Candidatos');
    sheet.columns = [
      { header: 'Nombre', key: 'fullName', width: 28 },
      { header: 'Teléfono', key: 'phone', width: 18 },
      { header: 'Doc. Tipo', key: 'documentType', width: 12 },
      { header: 'Doc. Número', key: 'documentNumber', width: 18 },
      { header: 'Edad', key: 'age', width: 8 },
      { header: 'Barrio', key: 'neighborhood', width: 20 },
      { header: 'Experiencia', key: 'experienceInfo', width: 14 },
      { header: 'Tiempo exp.', key: 'experienceTime', width: 16 },
      { header: 'Restricciones', key: 'medicalRestrictions', width: 20 },
      { header: 'Transporte', key: 'transportMode', width: 16 },
      { header: 'Estado', key: 'status', width: 14 },
      { header: 'Tiene HV', key: 'hasCV', width: 10 },
      { header: 'Fecha registro', key: 'createdAt', width: 20 },
    ];
    for (const c of candidates) {
      sheet.addRow({
        ...c,
        hasCV: candidateHasCv(c) ? 'Sí' : 'No',
        createdAt: formatDateTimeCO(c.createdAt)
      });
    }
    const filename = exportFilenameByScope(scope);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  });

  // ── Detalle de candidato ─────────────────────────────────────
  router.get('/candidates/:id', async (req, res) => {
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } }
    });
    if (!candidate) return res.status(404).send('Candidato no encontrado.');

    const cvSizeBytes = candidate.cvData
      ? normalizeBinaryData(candidate.cvData)?.length || 0
      : 0;

    const outboundWindow = req.userRole === 'dev'
      ? await getOutboundWindowStatus(prisma, candidate.id)
      : null;

    const cvSuccess = normalizeString(req.query.cvSuccess);
    const cvError   = normalizeString(req.query.cvError);
    const outboundSuccess = normalizeString(req.query.outboundSuccess);
    const outboundError   = normalizeString(req.query.outboundError);
    const botPauseSuccess = normalizeString(req.query.botPauseSuccess);
    const botPauseError   = normalizeString(req.query.botPauseError);

    res.render('detail', {
      candidate, role: req.userRole, formatDateTimeCO,
      normalizeCandidateStatusForUI, cvSizeBytes,
      outboundWindow, cvSuccess, cvError,
      outboundSuccess, outboundError, botPauseSuccess, botPauseError
    });
  });

  // ── Cambiar estado ───────────────────────────────────────────
  router.post('/candidates/:id/status', express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const status = normalizeString(req.body.status);
    const allowed = ['NUEVO', 'REGISTRADO', 'CONTACTADO', 'RECHAZADO'];
    if (!status || !allowed.includes(status)) return res.redirect(`/admin/candidates/${id}`);
    await prisma.candidate.update({ where: { id }, data: { status } });
    res.redirect(`/admin/candidates/${id}`);
  });

  // ── Edición manual ───────────────────────────────────────────
  router.post('/candidates/:id/edit', express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const raw = req.body;
    const candidateCoreFields = normalizeCandidateFields({
      fullName:            normalizeString(raw.fullName),
      documentType:        normalizeString(raw.documentType),
      documentNumber:      normalizeString(raw.documentNumber),
      age:                 raw.age ? parseInt(raw.age, 10) : null,
      neighborhood:        normalizeString(raw.neighborhood),
      experienceInfo:      normalizeString(raw.experienceInfo),
      experienceTime:      normalizeString(raw.experienceTime),
      medicalRestrictions: normalizeString(raw.medicalRestrictions),
      transportMode:       normalizeString(raw.transportMode),
    });
    const adminStatusFields = {
      rejectionReason:  normalizeString(raw.rejectionReason),
      rejectionDetails: normalizeString(raw.rejectionDetails),
    };
    const status = normalizeString(raw.status);
    if (status) adminStatusFields.status = status;

    const data = { ...candidateCoreFields, ...adminStatusFields };
    await prisma.candidate.update({ where: { id }, data });
    res.redirect(`/admin/candidates/${id}`);
  });

  // ── Pausar / reanudar bot ────────────────────────────────────
  router.post('/candidates/:id/bot-pause', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const reason = normalizeString(req.body.reason) || 'Pausa manual desde admin';
    await prisma.candidate.update({
      where: { id },
      data: {
        botPaused: true,
        botPausedAt: new Date(),
        botPausedBy: req.userRole || 'admin',
        botPauseReason: reason,
        reminderScheduledFor: null,
        reminderState: 'CANCELLED'
      }
    });
    res.redirect(`/admin/candidates/${id}?botPauseSuccess=` + encodeURIComponent('Bot pausado correctamente.'));
  });

  router.post('/candidates/:id/bot-resume', ensureDevRole, async (req, res) => {
    const { id } = req.params;
    await prisma.candidate.update({
      where: { id },
      data: {
        botPaused: false,
        botPausedAt: null,
        botPauseReason: null,
        reminderScheduledFor: null,
        reminderState: 'CANCELLED'
      }
    });
    res.redirect(`/admin/candidates/${id}?botPauseSuccess=` + encodeURIComponent('Bot reanudado correctamente.'));
  });

  // ── CV: descargar ────────────────────────────────────────────
  router.get('/candidates/:id/cv', async (req, res) => {
    const candidate = await prisma.candidate.findUnique({ where: { id: req.params.id } });
    if (!candidate?.cvData) return res.status(404).send('CV no encontrado.');
    const buffer = normalizeBinaryData(candidate.cvData);
    const mime = candidate.cvMimeType || 'application/octet-stream';
    const filename = candidate.cvOriginalName || 'hoja_de_vida';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  });

  // ── CV: subir / reemplazar ───────────────────────────────────
  router.post('/candidates/:id/cv/upload', (req, res, next) => {
    cvUpload(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return res.redirect(`/admin/candidates/${req.params.id}?` +
          buildCvStatusQuery('cvError', err.code === 'LIMIT_FILE_SIZE'
            ? 'El archivo supera el límite de 10 MB.'
            : 'Error al procesar el archivo.'));
      }
      if (err) return next(err);
      next();
    });
  }, async (req, res) => {
    const { id } = req.params;
    const file = req.file;
    if (!file) {
      return res.redirect(`/admin/candidates/${id}?` + buildCvStatusQuery('cvError', 'No se recibió ningún archivo.'));
    }
    if (!isAllowedCvFile(file)) {
      return res.redirect(`/admin/candidates/${id}?` + buildCvStatusQuery('cvError', 'Formato no permitido. Solo PDF, DOC o DOCX.'));
    }
    const buffer = normalizeBinaryData(file.buffer);
    if (!buffer || buffer.length === 0) {
      return res.redirect(`/admin/candidates/${id}?` + buildCvStatusQuery('cvError', 'El archivo está vacío.'));
    }
    if (shouldValidatePdfSignature(file.originalname, file.mimetype) && !hasPdfSignature(buffer)) {
      return res.redirect(`/admin/candidates/${id}?` + buildCvStatusQuery('cvError', 'El archivo PDF parece estar corrupto o no es un PDF válido.'));
    }
    await prisma.candidate.update({
      where: { id },
      data: {
        cvData: buffer,
        cvMimeType: file.mimetype || 'application/octet-stream',
        cvOriginalName: file.originalname || 'hoja_de_vida'
      }
    });
    res.redirect(`/admin/candidates/${id}?` + buildCvStatusQuery('cvSuccess', 'Hoja de vida actualizada correctamente.'));
  });

  // ── CV: eliminar ─────────────────────────────────────────────
  router.post('/candidates/:id/cv/delete', async (req, res) => {
    await prisma.candidate.update({
      where: { id: req.params.id },
      data: { cvData: null, cvMimeType: null, cvOriginalName: null }
    });
    res.redirect(`/admin/candidates/${req.params.id}?` + buildCvStatusQuery('cvSuccess', 'Hoja de vida eliminada.'));
  });

  // ── Mensajes salientes (solo dev) ────────────────────────────
  router.post('/candidates/:id/outbound', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const action = normalizeString(req.body.action);
    const customBody = normalizeString(req.body.customBody);

    const candidate = await prisma.candidate.findUnique({ where: { id } });
    if (!candidate) return res.redirect(`/admin/candidates/${id}?outboundError=Candidato no encontrado.`);

    const window = await getOutboundWindowStatus(prisma, id);
    if (!window.isOpen) {
      return res.redirect(`/admin/candidates/${id}?outboundError=` +
        encodeURIComponent('La ventana de 24h de WhatsApp está vencida. No se puede enviar mensaje.'));
    }

    const templates = {
      request_missing_data: 'Hola 👋 Para continuar con tu postulación, por favor envíame los datos faltantes que aún no has compartido.',
      request_hv: 'Hola 👋 Para continuar tu proceso necesito tu Hoja de vida (HV) en PDF o Word (.doc/.docx).',
      reminder: 'Te recuerdo que tu proceso sigue activo. Si deseas continuar, comparte la información faltante o tu Hoja de vida (HV).'
    };

    let body;
    if (action === 'free_text') {
      if (!customBody) return res.redirect(`/admin/candidates/${id}?outboundError=El mensaje no puede estar vacío.`);
      body = customBody;
    } else {
      body = templates[action];
      if (!body) return res.redirect(`/admin/candidates/${id}?outboundError=Acción desconocida.`);
    }

    try {
      await sendTextMessage(candidate.phone, body);
      const update = buildTechnicalOutboundCandidateUpdate(new Date());
      await prisma.candidate.update({ where: { id }, data: update });
      await prisma.message.create({
        data: {
          candidateId: id,
          direction: MessageDirection.OUTBOUND,
          messageType: MessageType.TEXT,
          body,
          rawPayload: {}
        }
      });
      res.redirect(`/admin/candidates/${id}?outboundSuccess=` + encodeURIComponent('Mensaje enviado correctamente.'));
    } catch (err) {
      console.error('[outbound]', err);
      res.redirect(`/admin/candidates/${id}?outboundError=` + encodeURIComponent('Error al enviar el mensaje.'));
    }
  });

  // ── CRUD de vacantes ─────────────────────────────────────────
  router.get('/vacancies', async (req, res) => {
    const [vacancies, operations] = await Promise.all([
      prisma.vacancy.findMany({
        orderBy: [{ city: 'asc' }, { title: 'asc' }],
        include: {
          interviewSlots: {
            where: { isActive: true, specificDate: null },
            orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }]
          },
          operation: {
            include: { city: { select: { name: true } } }
          }
        }
      }),
      loadOperations(prisma)
    ]);
    const successMsg = normalizeString(req.query.success);
    const errorMsg   = normalizeString(req.query.error);
    res.render('vacancies', { vacancies, operations, role: req.userRole, successMsg, errorMsg });
  });

  router.post('/vacancies/create', express.urlencoded({ extended: true }), async (req, res) => {
    const data = parseVacancyBody(req.body);
    const operation = await loadOperation(prisma, data.operationId);
    if (!data.title || !operation) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Título y operación son obligatorios.'));
    }
    if (!hasValidInterviewConfig(data)) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Debes configurar al menos un día y un rango horario válido para entrevistas.'));
    }
    const city = operation.city.name;
    const key = await buildUniqueVacancyKey(prisma, data.title, city);
    await prisma.$transaction(async (tx) => {
      const vacancy = await tx.vacancy.create({
        data: {
          title: data.title,
          key,
          city,
          operationId: operation.id,
          role: data.role,
          roleDescription: data.roleDescription,
          requirements: data.requirements,
          conditions: data.conditions,
          operationAddress: resolveVacancyAddress(data),
          minAge: data.minAge,
          maxAge: data.maxAge,
          experienceRequired: data.experienceRequired,
          isActive: data.isActive,
          acceptingApplications: data.acceptingApplications,
          schedulingEnabled: data.schedulingEnabled,
        }
      });

      await syncVacancyInterviewSlots(tx, vacancy.id, data);
    });
    res.redirect('/admin/vacancies?success=' + encodeURIComponent('Vacante "' + data.title + '" creada correctamente.'));
  });

  router.post('/vacancies/:id/edit', express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const data = parseVacancyBody(req.body);
    const operation = await loadOperation(prisma, data.operationId);
    if (!data.title || !operation) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Título y operación son obligatorios.'));
    }
    if (!hasValidInterviewConfig(data)) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Debes configurar al menos un día y un rango horario válido para entrevistas.'));
    }
    const city = operation.city.name;
    const key = await buildUniqueVacancyKey(prisma, data.title, city, id);
    await prisma.$transaction(async (tx) => {
      await tx.vacancy.update({
        where: { id },
        data: {
          title: data.title,
          key,
          city,
          operationId: operation.id,
          role: data.role,
          roleDescription: data.roleDescription,
          requirements: data.requirements,
          conditions: data.conditions,
          operationAddress: resolveVacancyAddress(data),
          minAge: data.minAge,
          maxAge: data.maxAge,
          experienceRequired: data.experienceRequired,
          isActive: data.isActive,
          acceptingApplications: data.acceptingApplications,
          schedulingEnabled: data.schedulingEnabled,
        }
      });

      await syncVacancyInterviewSlots(tx, id, data);
    });
    res.redirect('/admin/vacancies?success=' + encodeURIComponent('Vacante "' + data.title + '" actualizada correctamente.'));
  });

  router.post('/vacancies/:id/delete', async (req, res) => {
    const { id } = req.params;
    const vacancy = await prisma.vacancy.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!vacancy) return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Vacante no encontrada.'));

    const [candidateCount, interviewSlotCount, interviewBookingCount] = await Promise.all([
      prisma.candidate.count({ where: { vacancyId: id } }),
      prisma.interviewSlot.count({ where: { vacancyId: id } }),
      prisma.interviewBooking.count({ where: { vacancyId: id } }),
    ]);

    if (candidateCount > 0 || interviewSlotCount > 0 || interviewBookingCount > 0) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('No se puede eliminar la vacante porque tiene candidatos o entrevistas relacionadas.'));
    }

    await prisma.vacancy.delete({ where: { id } });
    res.redirect('/admin/vacancies?success=' + encodeURIComponent('Vacante eliminada correctamente.'));
  });

  router.post('/vacancies/:id/toggle', async (req, res) => {
    const { id } = req.params;
    const vacancy = await prisma.vacancy.findUnique({ where: { id } });
    if (!vacancy) return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Vacante no encontrada.'));
    const isCurrentlyOpen = vacancy.isActive && vacancy.acceptingApplications;
    await prisma.vacancy.update({
      where: { id },
      data: { isActive: true, acceptingApplications: !isCurrentlyOpen }
    });
    const msg = isCurrentlyOpen ? 'Vacante pausada.' : 'Vacante reactivada.';
    res.redirect('/admin/vacancies?success=' + encodeURIComponent(msg));
  });

  return router;
}
