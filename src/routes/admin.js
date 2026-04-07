// Importa Express para crear el router del panel administrativo.
import express from 'express';
import ExcelJS from 'exceljs';
import path from 'node:path';
import multer from 'multer';
import { normalizeCandidateFields, normalizeTransportMode } from '../services/candidateData.js';
import {
  buildWhatsAppLink,
  compareCandidatesByRecentInbound,
  candidateHasUnreadInbound,
  candidateHasCv,
  exportFilenameByScope,
  filterCandidatesByScope,
  isOperationallyCompleteWithoutCv,
  isOperationallyRegistered,
  normalizeCandidateStatusForUI
} from '../services/candidateExport.js';
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

function isFemaleHumanReviewCandidate(candidate) {
  if (!candidate || candidate.gender !== 'FEMALE' || !candidate.botPaused) return false;
  return /revision humana|revisión humana|candidata femenina/i.test(candidate.botPauseReason || '');
}

function safeAdminReturnPath(value) {
  const raw = String(value || '').trim();
  return raw.startsWith('/admin') ? raw : '/admin';
}

function withFlashMessage(returnTo, type, message) {
  const safePath = safeAdminReturnPath(returnTo);
  const [pathname, queryString = ''] = safePath.split('?');
  const params = new URLSearchParams(queryString);
  params.delete('success');
  params.delete('error');
  params.set(type, message);
  const suffix = params.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

function buildCandidateDetailPath(candidateId, returnTo = null) {
  const safeReturnTo = returnTo ? safeAdminReturnPath(returnTo) : null;
  const params = new URLSearchParams();
  if (safeReturnTo) params.set('returnTo', safeReturnTo);
  const query = params.toString();
  return query ? `/admin/candidates/${candidateId}?${query}` : `/admin/candidates/${candidateId}`;
}

const STATUS_LABELS = {
  'NUEVO': 'Nuevo', 'REGISTRADO': 'Registrado', 'VALIDANDO': 'Registrado',
  'APROBADO': 'Aprobado', 'RECHAZADO': 'Rechazado', 'CONTACTADO': 'Contactado'
};

const ADMIN_STATUS_SCOPES = new Set(['inbox', 'registered', 'missing_cv_complete', 'new', 'contacted', 'rejected', 'all']);
const EXPORT_SCOPES = new Set(['registered', 'missing_cv_complete', 'approved', 'new', 'contacted', 'rejected', 'all']);

const STATUS_SCOPE_SUMMARY_LABELS = {
  inbox: 'en bandeja', registered: 'registrados', missing_cv_complete: 'completos pendientes de HV',
  approved: 'aprobados', new: 'nuevos', contacted: 'contactados',
  rejected: 'rechazados', all: 'totales'
};
const ACTIVE_BOOKING_STATUSES = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'];
const ALL_BOOKING_STATUSES = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED'];
const BOOKING_ACTION_STATUS = {
  attended: 'CONFIRMED',
  no_show: 'NO_SHOW',
  cancelled: 'CANCELLED',
  rescheduled: 'RESCHEDULED'
};

const ALLOWED_CV_MIMES = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);
const ALLOWED_CV_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);
const OUTREACH_DEFAULT_MESSAGE = 'Hola {nombre}, te escribo por tu proceso para la vacante {vacante} en {ciudad}. ¿Podemos continuar?';

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

function normalizeCandidateListFilters(source = {}) {
  const rawTransportMode = normalizeString(source.transportMode);
  return {
    neighborhood: normalizeString(source.neighborhood) || '',
    locality: normalizeString(source.locality) || '',
    transportMode: normalizeTransportMode(rawTransportMode) || rawTransportMode || '',
  };
}

function normalizeVacancyDashboardFilters(source = {}) {
  const filtersByVacancyId = {};
  for (const [key, value] of Object.entries(source || {})) {
    const match = /^vf_([^_]+)_(transportMode|neighborhood|locality)$/.exec(String(key));
    if (!match) continue;
    const [, vacancyId, field] = match;
    const normalizedValue = field === 'transportMode'
      ? (normalizeTransportMode(value) || normalizeString(value))
      : normalizeString(value);
    if (!normalizedValue) continue;
    if (!filtersByVacancyId[vacancyId]) {
      filtersByVacancyId[vacancyId] = {
        neighborhood: '',
        locality: '',
        transportMode: ''
      };
    }
    filtersByVacancyId[vacancyId][field] = normalizedValue;
  }
  return filtersByVacancyId;
}

function includesCaseInsensitive(value, search) {
  if (!search) return true;
  return String(value || '').toLowerCase().includes(String(search).toLowerCase());
}

function applyRecruiterCandidateFilters(candidates, filters) {
  return candidates.filter((candidate) => (
    includesCaseInsensitive(candidate.neighborhood || candidate.zone, filters.neighborhood)
    && includesCaseInsensitive(candidate.locality || candidate.zone, filters.locality)
    && includesCaseInsensitive(candidate.transportMode, filters.transportMode)
  ));
}

function normalizeOutreachFilters(source = {}) {
  const rawTemplate = typeof source.messageTemplate === 'string' ? source.messageTemplate.trim() : '';
  return {
    city: normalizeString(source.city) || '',
    vacancyId: normalizeString(source.vacancyId) || '',
    messageTemplate: rawTemplate || OUTREACH_DEFAULT_MESSAGE,
  };
}

function sortOutreachCandidates(a, b) {
  const cityA = String(a?.vacancy?.city || '').localeCompare(String(b?.vacancy?.city || ''), 'es', { sensitivity: 'base' });
  if (cityA !== 0) return cityA;
  const vacancyA = String(a?.vacancy?.title || a?.vacancy?.role || '').localeCompare(String(b?.vacancy?.title || b?.vacancy?.role || ''), 'es', { sensitivity: 'base' });
  if (vacancyA !== 0) return vacancyA;
  return String(a?.fullName || '').localeCompare(String(b?.fullName || ''), 'es', { sensitivity: 'base' });
}

function filterOutreachCandidates(candidates, filters) {
  return candidates.filter((candidate) => {
    if (filters.city && candidate?.vacancy?.city !== filters.city) return false;
    if (filters.vacancyId && candidate?.vacancyId !== filters.vacancyId) return false;
    return true;
  });
}

function personalizeOutreachMessage(template, candidate) {
  const fullName = candidate?.fullName || 'candidato';
  const vacancy = candidate?.vacancy?.title || candidate?.vacancy?.role || 'la vacante';
  const city = candidate?.vacancy?.city || 'tu ciudad';
  return String(template || OUTREACH_DEFAULT_MESSAGE)
    .replaceAll('{nombre}', fullName)
    .replaceAll('{vacante}', vacancy)
    .replaceAll('{ciudad}', city);
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

function normalizeCandidateSnapshot(candidate) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const normalizedTransport = normalizeTransportMode(candidate.transportMode);
  return {
    ...candidate,
    transportMode: normalizedTransport || normalizeString(candidate.transportMode),
    experienceInfo: null,
    experienceTime: null
  };
}

function decorateDashboardCandidate(candidate) {
  const normalizedCandidate = normalizeCandidateSnapshot(candidate);
  const outboundWindowOpen = Boolean(normalizedCandidate?.lastInboundAt)
    && (Date.now() - new Date(normalizedCandidate.lastInboundAt).getTime()) <= WHATSAPP_WINDOW_MS;
  return {
    ...normalizedCandidate,
    hasCv: candidateHasCv(normalizedCandidate),
    isFemaleHumanReview: isFemaleHumanReviewCandidate(normalizedCandidate),
    outboundWindowOpen,
    hasNewInbound: candidateHasUnreadInbound(normalizedCandidate)
  };
}

async function sendAdminOutboundMessage(prisma, candidate, body, rawPayload = {}) {
  const update = buildTechnicalOutboundCandidateUpdate(new Date());
  await sendTextMessage(candidate.phone, body);
  await prisma.candidate.update({ where: { id: candidate.id }, data: update });
  await prisma.message.create({
    data: {
      candidateId: candidate.id,
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      body,
      rawPayload
    }
  });
}

async function buildDashboardData(prisma, dateStr, options = {}) {
  const { start, end } = colombiaDayBounds(dateStr);
  const isDev = options.role === 'dev';
  const candidateFilters = options.candidateFilters || null;
  const shouldFilterCandidates = options.role === 'admin'
    && candidateFilters
    && Object.values(candidateFilters).some(Boolean);
  const filterDashboardCandidates = (candidates) => (
    shouldFilterCandidates ? applyRecruiterCandidateFilters(candidates, candidateFilters) : candidates
  );

  const vacancies = await prisma.vacancy.findMany({
    where: {
      OR: [
        { acceptingApplications: true },
        {
          interviewBookings: {
            some: {
              scheduledAt: { gte: start, lte: end },
              status: { in: ALL_BOOKING_STATUSES }
            }
          }
        }
      ]
    },
    orderBy: [{ city: 'asc' }, { title: 'asc' }],
    include: {
      interviewBookings: {
        where: {
          scheduledAt: { gte: start, lte: end },
          status: { in: ALL_BOOKING_STATUSES }
        },
        include: {
          candidate: {
            select: {
              id: true, fullName: true, phone: true,
              documentType: true, documentNumber: true,
              age: true, neighborhood: true, locality: true, zone: true, status: true,
              medicalRestrictions: true, transportMode: true,
              cvOriginalName: true, cvMimeType: true, gender: true,
              botPaused: true, botPauseReason: true,
              currentStep: true,
              lastInboundAt: true,
              lastOutboundAt: true,
              devLastSeenAt: true
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
          age: true, neighborhood: true, locality: true, zone: true, status: true,
          medicalRestrictions: true, transportMode: true,
          cvOriginalName: true, cvMimeType: true,
          gender: true, createdAt: true,
          botPaused: true, botPauseReason: true,
          currentStep: true,
          lastInboundAt: true,
          lastOutboundAt: true,
          devLastSeenAt: true,
          interviewBookings: {
            where: { status: { in: ACTIVE_BOOKING_STATUSES } },
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
      age: true, neighborhood: true, locality: true, zone: true, status: true,
      medicalRestrictions: true, transportMode: true,
      cvOriginalName: true, cvMimeType: true, createdAt: true,
      gender: true, botPaused: true, botPauseReason: true,
      currentStep: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      devLastSeenAt: true
    }
  });

  const citiesMap = new Map();

  for (const v of vacancies) {
    const city = v.city || 'Sin ciudad';
    if (!citiesMap.has(city)) citiesMap.set(city, []);

    const candidatesWithFlags = v.candidates.map(decorateDashboardCandidate);
    const bookedCandidateIds = new Set(candidatesWithFlags
      .filter((candidate) => candidate.interviewBookings.length > 0)
      .map((candidate) => candidate.id));
    const operationallyRegisteredCandidates = candidatesWithFlags
      .filter((candidate) => isOperationallyRegistered(candidate));
    const operationallyCompleteWithoutCvCandidates = candidatesWithFlags
      .filter((candidate) => isOperationallyCompleteWithoutCv(candidate));

    const registeredNoBookingBase = v.schedulingEnabled
      ? operationallyRegisteredCandidates
        .filter((candidate) => !bookedCandidateIds.has(candidate.id))
      : [];
    const registeredCompleteBase = !v.schedulingEnabled
      ? operationallyRegisteredCandidates
      : [];
    const completeWithoutCvBase = operationallyCompleteWithoutCvCandidates;
    const registeredNoBooking = filterDashboardCandidates(registeredNoBookingBase);
    const registeredComplete = filterDashboardCandidates(registeredCompleteBase);
    const completeWithoutCv = filterDashboardCandidates(completeWithoutCvBase);
    const filteredBookingsToday = v.interviewBookings
      .map(b => ({
        ...b,
        candidate: decorateDashboardCandidate(b.candidate),
        formattedTime: formatTimeCO(b.scheduledAt),
        formattedDateTime: formatDateTimeCO(b.scheduledAt),
        isFemaleHumanReview: isFemaleHumanReviewCandidate(b.candidate)
      }))
      .filter((booking) => !shouldFilterCandidates
        || applyRecruiterCandidateFilters([booking.candidate], candidateFilters).length > 0);

    if (isDev) {
      registeredNoBooking.sort(compareCandidatesByRecentInbound);
      registeredComplete.sort(compareCandidatesByRecentInbound);
      completeWithoutCv.sort(compareCandidatesByRecentInbound);
    }

    const enriched = {
      ...v,
      bookingsToday: filteredBookingsToday,
      registeredNoBooking,
      registeredComplete,
      completeWithoutCv
    };

    citiesMap.get(city).push(enriched);
  }

  const cities = Array.from(citiesMap.entries()).map(([name, vacs]) => ({ name, vacancies: vacs }));
  const decoratedLegacyCandidates = filterDashboardCandidates(legacyCandidates.map(decorateDashboardCandidate));
  if (isDev) decoratedLegacyCandidates.sort(compareCandidatesByRecentInbound);
  return {
    cities,
    legacyCandidates: decoratedLegacyCandidates
  };
}

async function loadApprovedOutreachCandidates(prisma) {
  const candidates = await prisma.candidate.findMany({
    where: { status: 'APROBADO' },
    select: {
      id: true,
      fullName: true,
      phone: true,
      vacancyId: true,
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
  });
  return candidates.sort(sortOutreachCandidates);
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
    include: {
      candidate: {
        select: {
          id: true,
          phone: true,
          currentStep: true,
          gender: true,
          botPaused: true,
          botPauseReason: true
        }
      }
    }
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
    const adminFilters = normalizeCandidateListFilters(req.query);
    const vacancyFiltersById = normalizeVacancyDashboardFilters(req.query);
    const canUseLegacyScope = requestedStatus
      && ADMIN_STATUS_SCOPES.has(requestedStatus)
      && (req.userRole === 'dev' || requestedStatus !== 'inbox');

    if (canUseLegacyScope) {
      const legacyQuery = {
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
          rejectionDetails: true,
          createdAt: true,
          cvMimeType: true,
          cvOriginalName: true,
          gender: true,
          botPaused: true,
          botPauseReason: true,
          lastInboundAt: true,
          lastOutboundAt: true,
          devLastSeenAt: true
        }
      };
      if (requestedStatus === 'inbox' && req.userRole === 'dev') {
        legacyQuery.where = { lastInboundAt: { not: null } };
        legacyQuery.orderBy = [{ lastInboundAt: 'desc' }, { createdAt: 'desc' }];
      }
      if (req.userRole !== 'dev' && !['registered', 'missing_cv_complete'].includes(requestedStatus)) {
        legacyQuery.take = 200;
      }

      const allCandidates = (await prisma.candidate.findMany(legacyQuery))
        .map(decorateDashboardCandidate);
      let candidates = filterCandidatesByScope(allCandidates, requestedStatus);
      if (req.userRole === 'admin' && ['registered', 'missing_cv_complete'].includes(requestedStatus)) {
        candidates = applyRecruiterCandidateFilters(candidates, adminFilters);
      }
      if (req.userRole === 'dev') {
        candidates.sort(compareCandidatesByRecentInbound);
      }
      return res.render('list', {
        mode: 'legacy', candidates, formatDateTimeCO, role: req.userRole,
        activeStatusScope: requestedStatus,
        summaryLabel: STATUS_SCOPE_SUMMARY_LABELS[requestedStatus] || STATUS_SCOPE_SUMMARY_LABELS.all,
        normalizeCandidateStatusForUI, cities: [], legacyCandidates: [],
        activeCity: null, selectedDate: todayCO(), todayStr: todayCO(),
        successMsg: normalizeString(req.query.success),
        errorMsg: normalizeString(req.query.error),
        isFemaleHumanReviewCandidate,
        adminFilters,
        vacancyFiltersById: {}
      });
    }

    const rawDate = normalizeString(req.query.date);
    const selectedDate = isValidDateString(rawDate) ? rawDate : todayCO();
    const { cities, legacyCandidates } = await buildDashboardData(prisma, selectedDate, {
      role: req.userRole
    });

    const rawCity = normalizeString(req.query.city);
    const availableCities = cities.map(c => c.name);
    const activeCity = (rawCity && availableCities.includes(rawCity))
      ? rawCity : (availableCities[0] || null);

    return res.render('list', {
      mode: 'vacancies', cities, legacyCandidates, activeCity, selectedDate,
      todayStr: todayCO(), formatDateTimeCO, formatTimeCO, role: req.userRole,
      normalizeCandidateStatusForUI, candidates: [], activeStatusScope: null, summaryLabel: '',
      successMsg: normalizeString(req.query.success),
      errorMsg: normalizeString(req.query.error),
      isFemaleHumanReviewCandidate,
      adminFilters,
      vacancyFiltersById
    });
  });

  // ── Monitor (solo dev) ───────────────────────────────────────
  router.get('/monitor', ensureDevRole, async (req, res) => {
    try {
      const messages = await fetchMonitorMessages(prisma);
      res.render('monitor', { messages, formatDateTimeCO, role: req.userRole, isFemaleHumanReviewCandidate });
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
        candidateId: m.candidate?.id || '',
        phone: m.candidate?.phone || '', currentStep: m.candidate?.currentStep || '',
        gender: m.candidate?.gender || '',
        isFemaleHumanReview: isFemaleHumanReviewCandidate(m.candidate),
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
        rejectionDetails: true,
        createdAt: true,
        cvMimeType: true,
        cvOriginalName: true
      }
    });
    const candidates = filterCandidatesByScope(allCandidates.map(normalizeCandidateSnapshot), scope);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Candidatos');
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.columns = [
      { header: 'Nombre', key: 'fullName', width: 28 },
      { header: 'Teléfono', key: 'phone', width: 18 },
      { header: 'WhatsApp', key: 'whatsappLink', width: 20 },
      { header: 'Doc. Tipo', key: 'documentType', width: 12 },
      { header: 'Doc. Número', key: 'documentNumber', width: 18 },
      { header: 'Edad', key: 'age', width: 8 },
      { header: 'Barrio', key: 'neighborhood', width: 20 },
      { header: 'Localidad', key: 'locality', width: 18 },
      { header: 'Restricciones', key: 'medicalRestrictions', width: 20 },
      { header: 'Transporte', key: 'transportMode', width: 16 },
      { header: 'Estado', key: 'status', width: 14 },
      { header: 'Tiene HV', key: 'hasCV', width: 10 },
      { header: 'Fecha registro', key: 'createdAt', width: 20 },
    ];
    for (const c of candidates) {
      const normalizedCandidate = normalizeCandidateSnapshot(c);
      const whatsappLink = buildWhatsAppLink(normalizedCandidate.phone);
      const row = sheet.addRow({
        ...normalizedCandidate,
        neighborhood: normalizedCandidate.neighborhood || normalizedCandidate.zone || '',
        locality: normalizedCandidate.locality || normalizedCandidate.zone || '',
        whatsappLink: whatsappLink ? 'Abrir WhatsApp' : 'Sin número',
        hasCV: candidateHasCv(normalizedCandidate) ? 'Sí' : 'No',
        createdAt: formatDateTimeCO(normalizedCandidate.createdAt)
      });
      if (whatsappLink) {
        row.getCell('whatsappLink').value = { text: 'Abrir WhatsApp', hyperlink: whatsappLink };
      }
    }
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
    const statusColors = {
      REGISTRADO: 'FFDCFCE7',
      VALIDANDO: 'FFDBEAFE',
      APROBADO: 'FFD1FAE5',
      CONTACTADO: 'FFEDE9FE',
      RECHAZADO: 'FFFEE2E2',
      NUEVO: 'FFF3F4F6'
    };
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
      const statusCell = row.getCell('status');
      const statusColor = statusColors[String(statusCell.value || '').toUpperCase()] || 'FFFFFFFF';
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusColor } };
      statusCell.font = { bold: true, color: { argb: 'FF1F2937' } };

      const hvCell = row.getCell('hasCV');
      hvCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: hvCell.value === 'Sí' ? 'FFDCFCE7' : 'FFFEE2E2' }
      };
      hvCell.font = { bold: true, color: { argb: hvCell.value === 'Sí' ? 'FF166534' : 'FF991B1B' } };

      ['whatsappLink'].forEach((key) => {
        const linkCell = row.getCell(key);
        linkCell.font = { color: { argb: 'FF1D4ED8' }, underline: true };
      });
    });
    const filename = exportFilenameByScope(scope);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  });

  // ── Detalle de candidato ─────────────────────────────────────
  router.get('/outreach/approved', async (req, res) => {
    const outreachFilters = normalizeOutreachFilters(req.query);
    const allApprovedCandidates = await loadApprovedOutreachCandidates(prisma);
    const cityOptions = [...new Set(allApprovedCandidates
      .map((candidate) => candidate?.vacancy?.city)
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    const vacancyOptions = allApprovedCandidates
      .filter((candidate) => candidate?.vacancy?.id)
      .map((candidate) => ({
        id: candidate.vacancy.id,
        label: `${candidate.vacancy.city || 'Sin ciudad'} · ${candidate.vacancy.title || candidate.vacancy.role || 'Sin vacante'}`
      }))
      .filter((option, index, array) => array.findIndex((item) => item.id === option.id) === index)
      .sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
    const candidates = filterOutreachCandidates(allApprovedCandidates, outreachFilters);

    res.render('outreachApproved', {
      role: req.userRole,
      candidates,
      cityOptions,
      vacancyOptions,
      outreachFilters,
      preparedRecipients: [],
      preparedSuccess: normalizeString(req.query.success),
      preparedError: normalizeString(req.query.error)
    });
  });

  router.post('/outreach/approved/prepare', express.urlencoded({ extended: true }), async (req, res) => {
    const outreachFilters = normalizeOutreachFilters(req.body);
    const selectedCandidateIds = Array.isArray(req.body.candidateIds)
      ? req.body.candidateIds
      : (req.body.candidateIds ? [req.body.candidateIds] : []);
    const selectedIds = new Set(selectedCandidateIds.map((value) => String(value || '').trim()).filter(Boolean));
    const allApprovedCandidates = await loadApprovedOutreachCandidates(prisma);
    const cityOptions = [...new Set(allApprovedCandidates
      .map((candidate) => candidate?.vacancy?.city)
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    const vacancyOptions = allApprovedCandidates
      .filter((candidate) => candidate?.vacancy?.id)
      .map((candidate) => ({
        id: candidate.vacancy.id,
        label: `${candidate.vacancy.city || 'Sin ciudad'} · ${candidate.vacancy.title || candidate.vacancy.role || 'Sin vacante'}`
      }))
      .filter((option, index, array) => array.findIndex((item) => item.id === option.id) === index)
      .sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
    const candidates = filterOutreachCandidates(allApprovedCandidates, outreachFilters);
    const preparedRecipients = candidates
      .filter((candidate) => selectedIds.has(candidate.id))
      .map((candidate) => {
        const personalizedMessage = personalizeOutreachMessage(outreachFilters.messageTemplate, candidate);
        const params = new URLSearchParams({ returnTo: '/admin/outreach/approved' });
        params.set('text', personalizedMessage);
        return {
          ...candidate,
          personalizedMessage,
          whatsappHref: `/admin/candidates/${candidate.id}/open-whatsapp?${params.toString()}`
        };
      });

    res.render('outreachApproved', {
      role: req.userRole,
      candidates,
      cityOptions,
      vacancyOptions,
      outreachFilters,
      preparedRecipients,
      preparedSuccess: preparedRecipients.length ? `Ronda preparada para ${preparedRecipients.length} candidato(s).` : null,
      preparedError: preparedRecipients.length ? null : 'Selecciona al menos un candidato aprobado para preparar la ronda.'
    });
  });

  router.get('/candidates/:id', async (req, res) => {
    const returnToPath = safeAdminReturnPath(req.query.returnTo || '/admin');
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      include: {
        vacancy: {
          select: {
            id: true,
            title: true,
            city: true,
            role: true,
            acceptingApplications: true,
            isActive: true
          }
        },
        messages: { orderBy: { createdAt: 'asc' } },
        interviewBookings: {
          orderBy: { scheduledAt: 'desc' },
          include: {
            vacancy: { select: { id: true, title: true, role: true, city: true } }
          }
        }
      }
    });
    if (!candidate) return res.status(404).send('Candidato no encontrado.');

    if (req.userRole === 'dev') {
      const seenAt = new Date();
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { devLastSeenAt: seenAt }
      });
      candidate.devLastSeenAt = seenAt;
    }

    const cvSizeBytes = candidate.cvData
      ? normalizeBinaryData(candidate.cvData)?.length || 0
      : 0;

    const outboundWindow = req.userRole === 'dev'
      ? await getOutboundWindowStatus(prisma, candidate.id)
      : null;
    const availableVacancies = req.userRole === 'dev'
      ? await prisma.vacancy.findMany({
        where: {
          OR: [
            { isActive: true },
            { acceptingApplications: true }
          ]
        },
        orderBy: [{ city: 'asc' }, { title: 'asc' }],
        select: {
          id: true,
          title: true,
          city: true,
          role: true,
          acceptingApplications: true,
          isActive: true
        }
      })
      : [];
    const detailCandidate = {
      ...normalizeCandidateSnapshot(candidate),
      outboundWindowOpen: outboundWindow?.isOpen ?? (
        Boolean(candidate.lastInboundAt)
        && (Date.now() - new Date(candidate.lastInboundAt).getTime()) <= WHATSAPP_WINDOW_MS
      ),
      lastInboundAt: outboundWindow?.lastInboundAt || candidate.lastInboundAt || null,
      hasNewInbound: candidateHasUnreadInbound(candidate)
    };

    const cvSuccess = normalizeString(req.query.cvSuccess);
    const cvError   = normalizeString(req.query.cvError);
    const outboundSuccess = normalizeString(req.query.outboundSuccess);
    const outboundError   = normalizeString(req.query.outboundError);
    const botPauseSuccess = normalizeString(req.query.botPauseSuccess);
    const botPauseError   = normalizeString(req.query.botPauseError);
    const bookingSuccess  = normalizeString(req.query.bookingSuccess || req.query.success);
    const bookingError    = normalizeString(req.query.bookingError || req.query.error);

    res.render('detail', {
      candidate: detailCandidate, role: req.userRole, formatDateTimeCO,
      normalizeCandidateStatusForUI, cvSizeBytes,
      availableVacancies,
      returnToPath,
      outboundWindow, cvSuccess, cvError,
      outboundSuccess, outboundError, botPauseSuccess, botPauseError,
      bookingSuccess, bookingError, isFemaleHumanReviewCandidate
    });
  });

  router.post('/interviews/:id/status', express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const action = normalizeString(req.body.action);
    const nextStatus = action ? BOOKING_ACTION_STATUS[action] : null;
    const returnTo = safeAdminReturnPath(req.body.returnTo || req.get('referer') || '/admin');

    if (!nextStatus) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Acción de entrevista inválida.'));
    }

    const booking = await prisma.interviewBooking.findUnique({
      where: { id },
      select: { id: true }
    });
    if (!booking) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Entrevista no encontrada.'));
    }

    await prisma.interviewBooking.update({
      where: { id },
      data: { status: nextStatus }
    });

    return res.redirect(withFlashMessage(returnTo, 'success', 'Entrevista actualizada correctamente.'));
  });

  // ── Cambiar estado ───────────────────────────────────────────
  router.post('/candidates/:id/status', express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const status = normalizeString(req.body.status);
    const returnTo = safeAdminReturnPath(req.body.returnTo || '/admin');
    const allowed = ['NUEVO', 'REGISTRADO', 'APROBADO', 'CONTACTADO', 'RECHAZADO'];
    if (!status || !allowed.includes(status)) return res.redirect(buildCandidateDetailPath(id, returnTo));
    await prisma.candidate.update({ where: { id }, data: { status } });
    res.redirect(buildCandidateDetailPath(id, returnTo));
  });

  // ── Edición manual ───────────────────────────────────────────
  router.get('/candidates/:id/open-whatsapp', async (req, res) => {
    const { id } = req.params;
    const returnTo = safeAdminReturnPath(req.query.returnTo || req.get('referer') || '/admin');
    const whatsappText = typeof req.query.text === 'string' ? req.query.text.trim() : '';
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      select: { id: true, phone: true }
    });

    if (!candidate) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Candidato no encontrado.'));
    }

    const whatsappBaseUrl = buildWhatsAppLink(candidate.phone);
    if (!whatsappBaseUrl) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'El candidato no tiene un número válido para WhatsApp.'));
    }

    await prisma.candidate.update({
      where: { id },
      data: req.userRole === 'dev'
        ? { devLastSeenAt: new Date() }
        : { status: 'CONTACTADO' }
    });

    const whatsappUrl = whatsappText
      ? `${whatsappBaseUrl}?text=${encodeURIComponent(whatsappText)}`
      : whatsappBaseUrl;
    return res.redirect(whatsappUrl);
  });

  router.post('/candidates/:id/assign-vacancy', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const vacancyId = normalizeString(req.body.vacancyId);
    const returnTo = `/admin/candidates/${id}`;

    const candidate = await prisma.candidate.findUnique({
      where: { id },
      select: { id: true }
    });
    if (!candidate) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Candidato no encontrado.'));
    }

    if (!vacancyId) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Debes seleccionar una vacante.'));
    }

    const vacancy = await prisma.vacancy.findUnique({
      where: { id: vacancyId },
      select: { id: true, isActive: true, acceptingApplications: true }
    });
    if (!vacancy || (!vacancy.isActive && !vacancy.acceptingApplications)) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'La vacante seleccionada no está disponible para asignación.'));
    }

    await prisma.candidate.update({
      where: { id },
      data: { vacancyId: vacancy.id }
    });

    return res.redirect(withFlashMessage(returnTo, 'success', 'Vacante asignada correctamente.'));
  });

  router.post('/candidates/:id/edit', express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const returnTo = safeAdminReturnPath(req.body.returnTo || '/admin');
    const raw = req.body;
    const candidateCoreFields = normalizeCandidateFields({
      fullName:            normalizeString(raw.fullName),
      documentType:        normalizeString(raw.documentType),
      documentNumber:      normalizeString(raw.documentNumber),
      age:                 raw.age ? parseInt(raw.age, 10) : null,
      neighborhood:        normalizeString(raw.neighborhood),
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
    res.redirect(buildCandidateDetailPath(id, returnTo));
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
      await sendAdminOutboundMessage(prisma, candidate, body, {
        source: 'admin_outbound',
        action: action || 'free_text'
      });
      res.redirect(`/admin/candidates/${id}?outboundSuccess=` + encodeURIComponent('Mensaje enviado correctamente.'));
    } catch (err) {
      console.error('[outbound]', err);
      res.redirect(`/admin/candidates/${id}?outboundError=` + encodeURIComponent('Error al enviar el mensaje.'));
    }
  });

  router.post('/candidates/:id/request-hv', express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const returnTo = safeAdminReturnPath(req.body.returnTo);
    const candidate = await prisma.candidate.findUnique({ where: { id } });
    if (!candidate) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Candidato no encontrado.'));
    }

    const window = await getOutboundWindowStatus(prisma, id);
    if (!window.isOpen) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'La ventana de 24h de WhatsApp está vencida. No se puede solicitar la HV.'));
    }

    const body = 'Hola 👋 Para continuar tu proceso necesito tu Hoja de vida (HV) en PDF o Word (.doc/.docx).';

    try {
      await sendAdminOutboundMessage(prisma, candidate, body, {
        source: 'admin_request_hv',
        action: 'request_hv'
      });
      res.redirect(withFlashMessage(returnTo, 'success', 'Solicitud de HV enviada correctamente.'));
    } catch (err) {
      console.error('[request_hv]', err);
      res.redirect(withFlashMessage(returnTo, 'error', 'Error al enviar la solicitud de HV.'));
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
