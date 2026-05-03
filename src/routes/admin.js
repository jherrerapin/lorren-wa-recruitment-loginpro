// Importa Express para crear el router del panel administrativo.
import express from 'express';
import ExcelJS from 'exceljs';
import path from 'node:path';
import multer from 'multer';
import bcrypt from 'bcrypt';
import {
  alignCandidateLocationFields,
  getCandidateResidenceValue,
  getResidenceFieldConfig,
  normalizeCandidateFields,
  normalizeTransportMode
} from '../services/candidateData.js';
import {
  buildWhatsAppLink,
  compareCandidatesByRecentInbound,
  candidateHasUnreadInbound,
  candidateLastMessageTime,
  candidateLastMessageDirection,
  candidateHasCv,
  deriveCandidateStatusForUI,
  exportFilenameByScopeAndVacancy,
  filterCandidatesByScope,
  isOperationallyCompleteWithoutCv,
  isOperationallyRegistered,
  normalizeCandidateStatusForUI
} from '../services/candidateExport.js';
import { sendTextMessage } from '../services/whatsapp.js';
import { ConversationStep, MessageDirection, MessageType, Gender } from '@prisma/client';
import { buildTechnicalOutboundCandidateUpdate } from '../services/adminOutboundPolicy.js';
import { describeResumeBehavior } from '../services/botAutomationPolicy.js';
import { listOfferableSlots, createBooking, cancelCandidateBookings, formatInterviewDate } from '../services/interviewScheduler.js';
import { getReminderMissingItems } from '../services/reminder.js';
import { clearCandidateCvStorage, resolveCandidateCvBuffer, storeCandidateCv } from '../services/cvStorage.js';
import { isStorageConfigured } from '../services/storage.js';
import { loadPendingCvMigrationCount, migrateCandidateCvBatch } from '../services/cvMigration.js';
import {
  buildCandidateAccessWhere,
  buildUniqueRecruiterUsername,
  buildVacancyAccessWhere,
  canAccessCandidate,
  canAccessVacancy,
  describeUserScope,
  generateRecoveryCode,
  getAccessContext,
  normalizeUserAccessScope
} from '../services/appUsers.js';

function sessionAuth(req, res, next) {
  const role = req.session?.userRole;
  if (!role) return res.redirect('/login');
  req.userRole = role;
  req.userId = req.session?.userId || null;
  req.username = req.session?.username || null;
  req.userAccessScope = req.session?.userAccessScope || 'ALL';
  req.userAccessCity = req.session?.userAccessCity || null;
  req.userAccessVacancyId = req.session?.userAccessVacancyId || null;
  req.userSource = req.session?.userSource || null;
  return next();
}

function canManageRecruiterUsers(req) {
  const role = req.userRole || req.session?.userRole;
  const source = req.userSource || req.session?.userSource;
  return source === 'env' && (role === 'admin' || role === 'dev');
}

function ensureRecruiterUserManagementAccess(req, res) {
  if (canManageRecruiterUsers(req)) return true;
  if (res) {
    return res.redirect('/admin?error=' + encodeURIComponent('La gestión de usuarios solo está disponible para reclutador y devloginpro.'));
  }
  return false;
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function stripCountryCode57(value) {
  const digits = normalizeDigits(value);
  if (digits.startsWith('57') && digits.length > 10) return digits.slice(2);
  return digits;
}

function formatPhoneForDisplay(value) {
  return stripCountryCode57(value) || String(value || '');
}

function normalizeVacancyTextBlock(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function buildVacancySection(label, value) {
  const content = normalizeVacancyTextBlock(value);
  if (!content) return null;
  return content.includes('\n')
    ? `${label}:\n${content}`
    : `${label}: ${content}`;
}

function buildManualVacancyInfoMessage(vacancy) {
  if (!vacancy) return '';
  const title = normalizeString(vacancy.title) || normalizeString(vacancy.role) || 'la vacante';
  const city = normalizeString(vacancy.city);
  const lines = [`Hola, te comparto la información de la vacante ${title}${city ? ` en ${city}` : ''}.`];

  const description = buildVacancySection('Descripción', vacancy.roleDescription);
  const operationArea = buildVacancySection('Zona de operación', vacancy.operationAddress);
  const requirements = buildVacancySection('Requisitos', vacancy.requirements);
  const conditions = buildVacancySection('Condiciones', vacancy.conditions);

  if (description) lines.push(description);
  if (operationArea) lines.push(operationArea);
  if (requirements) lines.push(requirements);
  if (conditions) lines.push(conditions);

  lines.push(
    vacancy.acceptingApplications
      ? 'Si te interesa continuar, me confirmas y seguimos con tu proceso.'
      : 'En este momento no estamos recibiendo personal para esta vacante, pero sí podemos dejar tus datos y tu hoja de vida para cuando vuelva a abrir.'
  );

  return lines.filter(Boolean).join('\n\n');
}

function formatHumanList(items = []) {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} y ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

function buildMissingDataRequestMessage(candidate) {
  const { missingFields } = getReminderMissingItems(candidate);
  if (!missingFields.length) return null;
  return `Para continuar con tu postulacion necesito ${formatHumanList(missingFields)}.`;
}

function normalizeCandidateSearch(source = {}) {
  const field = normalizeString(source.searchField);
  const text = normalizeString(source.searchText);
  return {
    field: ['document', 'phone'].includes(field) ? field : 'document',
    text: text || ''
  };
}

function normalizeVacancySearches(source = {}) {
  const searchesByVacancyId = {};
  for (const [key, value] of Object.entries(source || {})) {
    const match = /^vs_([^_]+)_(field|text)$/.exec(String(key));
    if (!match) continue;
    const [, vacancyId, field] = match;
    if (!searchesByVacancyId[vacancyId]) {
      searchesByVacancyId[vacancyId] = { field: 'document', text: '' };
    }
    if (field === 'field') {
      const normalizedField = normalizeString(value);
      searchesByVacancyId[vacancyId].field = ['document', 'phone'].includes(normalizedField)
        ? normalizedField
        : 'document';
      continue;
    }
    searchesByVacancyId[vacancyId].text = normalizeString(value) || '';
  }
  return searchesByVacancyId;
}

function candidateMatchesSearch(candidate, search = {}) {
  const searchText = normalizeString(search?.text);
  if (!searchText) return true;
  if ((search?.field || 'document') === 'phone') {
    const queryDigits = stripCountryCode57(searchText);
    const candidateDigits = stripCountryCode57(candidate?.phone);
    return Boolean(queryDigits) && candidateDigits.includes(queryDigits);
  }
  const queryDigits = normalizeDigits(searchText);
  const candidateDocument = normalizeDigits(candidate?.documentNumber);
  return Boolean(queryDigits) && candidateDocument.includes(queryDigits);
}

function normalizeGenderInput(value) {
  const normalized = normalizeString(value)?.toUpperCase() || null;
  return ['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'].includes(normalized) ? normalized : null;
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

function timeValue(value) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
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

function getRequestAccessContext(req) {
  return getAccessContext({
    userRole: req.userRole,
    userId: req.userId,
    username: req.username,
    userAccessScope: req.userAccessScope,
    userAccessCity: req.userAccessCity,
    userAccessVacancyId: req.userAccessVacancyId
  });
}

function ensureCandidateAccess(req, candidate, res, returnTo = '/admin') {
  const accessContext = getRequestAccessContext(req);
  if (canAccessCandidate(accessContext, candidate)) return true;
  if (res) {
    res.redirect(withFlashMessage(returnTo, 'error', 'No tienes acceso a ese candidato.'));
  }
  return false;
}

function ensureVacancyAccess(req, vacancy, res, returnTo = '/admin/vacancies') {
  const accessContext = getRequestAccessContext(req);
  if (canAccessVacancy(accessContext, vacancy)) return true;
  if (res) {
    res.redirect(withFlashMessage(returnTo, 'error', 'No tienes acceso a esa vacante.'));
  }
  return false;
}

function getManageableScopeOptions(req, vacancies = []) {
  const accessContext = getRequestAccessContext(req);
  if (accessContext.isDev || accessContext.scope === 'ALL') {
    return {
      canCreateAll: true,
      allowedCities: Array.from(new Set(vacancies.map((vacancy) => vacancy.city).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'es')),
      allowedVacancies: vacancies
    };
  }
  if (accessContext.scope === 'CITY') {
    return {
      canCreateAll: false,
      allowedCities: accessContext.city ? [accessContext.city] : [],
      allowedVacancies: vacancies.filter((vacancy) => vacancy.city === accessContext.city)
    };
  }
  return {
    canCreateAll: false,
    allowedCities: [],
    allowedVacancies: vacancies.filter((vacancy) => vacancy.id === accessContext.vacancyId)
  };
}

async function resolveRequestedUserScope(prisma, req, body = {}) {
  const accessContext = getRequestAccessContext(req);
  const accessScope = normalizeUserAccessScope(body.accessScope);
  const scopeCity = normalizeString(body.scopeCity);
  const scopeVacancyId = normalizeString(body.scopeVacancyId);

  if (!accessContext.isDev && accessContext.scope === 'VACANCY' && accessScope !== 'VACANCY') {
    return { error: 'Tu perfil solo puede crear usuarios asignados a la misma vacante.' };
  }
  if (!accessContext.isDev && accessContext.scope === 'CITY' && accessScope === 'ALL') {
    return { error: 'Tu perfil no puede crear usuarios con acceso total.' };
  }
  if (!accessContext.isDev && accessContext.scope === 'VACANCY' && scopeVacancyId !== accessContext.vacancyId) {
    return { error: 'Tu perfil solo puede crear usuarios para tu misma vacante.' };
  }

  if (accessScope === 'ALL') {
    if (!accessContext.isDev && accessContext.scope !== 'ALL') {
      return { error: 'Solo dev o un reclutador general pueden crear usuarios con acceso total.' };
    }
    return {
      accessScope,
      scopeCity: null,
      scopeVacancyId: null,
      scopeVacancy: null
    };
  }

  if (accessScope === 'CITY') {
    const finalCity = accessContext.isDev || accessContext.scope === 'ALL'
      ? scopeCity
      : accessContext.city;
    if (!finalCity) {
      return { error: 'Debes seleccionar una ciudad para este usuario.' };
    }
    if (!accessContext.isDev && accessContext.scope === 'CITY' && finalCity !== accessContext.city) {
      return { error: 'Tu perfil solo puede crear usuarios para tu misma ciudad.' };
    }
    return {
      accessScope,
      scopeCity: finalCity,
      scopeVacancyId: null,
      scopeVacancy: null
    };
  }

  if (!scopeVacancyId) {
    return { error: 'Debes seleccionar una vacante para este usuario.' };
  }

  const scopeVacancy = await prisma.vacancy.findUnique({
    where: { id: scopeVacancyId },
    select: { id: true, title: true, city: true }
  });
  if (!scopeVacancy) {
    return { error: 'La vacante seleccionada no existe.' };
  }
  if (!canAccessVacancy(accessContext, scopeVacancy)) {
    return { error: 'Tu perfil no puede crear usuarios fuera de tu alcance.' };
  }

  return {
    accessScope: 'VACANCY',
    scopeCity: null,
    scopeVacancyId: scopeVacancy.id,
    scopeVacancy
  };
}

async function loadCandidateAccessSnapshot(prisma, candidateId) {
  return prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      vacancyId: true,
      vacancy: {
        select: {
          id: true,
          city: true
        }
      }
    }
  });
}

async function ensureCandidateIdAccess(prisma, req, candidateId, res, returnTo = '/admin') {
  const candidate = await loadCandidateAccessSnapshot(prisma, candidateId);
  if (!candidate) {
    if (res) {
      res.redirect(withFlashMessage(returnTo, 'error', 'Candidato no encontrado.'));
    }
    return null;
  }
  if (!ensureCandidateAccess(req, candidate, res, returnTo)) {
    return null;
  }
  return candidate;
}

async function loadVacancyAccessSnapshot(prisma, vacancyId) {
  return prisma.vacancy.findUnique({
    where: { id: vacancyId },
    select: {
      id: true,
      title: true,
      city: true,
      isActive: true,
      acceptingApplications: true
    }
  });
}

async function ensureVacancyIdAccess(prisma, req, vacancyId, res, returnTo = '/admin/vacancies') {
  const vacancy = await loadVacancyAccessSnapshot(prisma, vacancyId);
  if (!vacancy) {
    if (res) {
      res.redirect(withFlashMessage(returnTo, 'error', 'Vacante no encontrada.'));
    }
    return null;
  }
  if (!ensureVacancyAccess(req, vacancy, res, returnTo)) {
    return null;
  }
  return vacancy;
}

function buildManageableUsersWhere(accessContext = {}) {
  if (accessContext.isDev || accessContext.scope === 'ALL') return { role: 'ADMIN' };
  if (accessContext.scope === 'CITY') {
    return {
      role: 'ADMIN',
      OR: [
        {
          accessScope: 'CITY',
          scopeCity: accessContext.city || '__OUT_OF_SCOPE__'
        },
        {
          accessScope: 'VACANCY',
          scopeVacancy: {
            city: accessContext.city || '__OUT_OF_SCOPE__'
          }
        }
      ]
    };
  }
  return {
    role: 'ADMIN',
    accessScope: 'VACANCY',
    scopeVacancyId: accessContext.vacancyId || '__OUT_OF_SCOPE__'
  };
}

function isManualAttentionCandidate(candidate) {
  if (!candidate?.botPaused) return false;
  if (isFemaleHumanReviewCandidate(candidate)) return false;
  const attentionAt = Math.max(
    timeValue(candidate?.lastInboundAt),
    timeValue(candidate?.botPausedAt)
  );
  if (!attentionAt) return true;
  return attentionAt > timeValue(candidate?.devLastSeenAt);
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
  'APROBADO': 'Aprobado', 'RECHAZADO': 'Rechazado', 'CONTACTADO': 'Contactado', 'CONTRATADO': 'Contratado'
};

function formatAdminEventValue(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return STATUS_LABELS[normalized] || normalized;
}

function formatActorRoleLabel(role) {
  const normalized = normalizeString(role);
  if (!normalized) return 'Sistema';
  if (normalized === 'dev') return 'Dev';
  if (normalized === 'admin') return 'Reclutador';
  return normalized;
}

function formatAdminEventLabel(event = {}) {
  const normalizedType = normalizeString(event.eventType);
  const fallback = normalizeString(event.eventLabel);
  if (normalizedType === 'STATUS_CHANGED') return fallback || 'Cambio de estado';
  if (normalizedType === 'WHATSAPP_OPENED') return 'Abrio WhatsApp del candidato';
  if (normalizedType === 'INTERVIEW_ASSIGNED') return 'Asigno entrevista manualmente';
  if (normalizedType === 'INTERVIEW_STATUS_CHANGED') return 'Actualizo estado de entrevista';
  if (normalizedType === 'INTERVIEW_MANUAL_REMINDER_SENT') return 'Envio recordatorio manual de entrevista';
  if (normalizedType === 'DEV_NOTES_UPDATED') return 'Actualizo observaciones dev';
  if (normalizedType === 'GENDER_UPDATED') return 'Actualizo genero del candidato';
  if (normalizedType === 'BOT_PAUSED') return 'Pauso el bot';
  if (normalizedType === 'BOT_RESUMED') return 'Reanudo el bot';
  if (normalizedType === 'VACANCY_ASSIGNED') return fallback || 'Actualizo vacante asignada';
  return fallback || 'Movimiento manual';
}

async function logCandidateAdminEvent(prisma, {
  candidateId,
  actorRole,
  eventType,
  eventLabel,
  fromValue = null,
  toValue = null,
  note = null
} = {}) {
  if (!candidateId || !eventType || !eventLabel || typeof prisma?.candidateAdminEvent?.create !== 'function') return;
  try {
    await prisma.candidateAdminEvent.create({
      data: {
        candidateId,
        actorRole: normalizeString(actorRole) || 'system',
        eventType,
        eventLabel,
        fromValue,
        toValue,
        note
      }
    });
  } catch (error) {
    console.error('[candidate_admin_event]', {
      candidateId,
      eventType,
      error: error?.message || error
    });
  }
}

const ADMIN_STATUS_SCOPES = new Set(['inbox', 'registered', 'missing_cv_complete', 'new', 'contacted', 'contracted', 'rejected', 'all']);
const RECRUITER_STATUS_SCOPES = new Set(['registered', 'missing_cv_complete', 'contacted', 'contracted', 'rejected', 'all']);
const EXPORT_SCOPES = new Set(['registered', 'missing_cv_complete', 'approved', 'new', 'contacted', 'contracted', 'rejected', 'all']);
const ACTIVE_CANDIDATE_STATUSES = ['NUEVO', 'REGISTRADO', 'VALIDANDO', 'APROBADO', 'CONTACTADO', 'CONTRATADO'];

const STATUS_SCOPE_SUMMARY_LABELS = {
  inbox: 'en bandeja', registered: 'registrados', missing_cv_complete: 'completos pendientes de HV',
  approved: 'aprobados', new: 'nuevos', contacted: 'contactados', contracted: 'contratados',
  rejected: 'rechazados', all: 'totales'
};
const ACTIVE_BOOKING_STATUSES = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'];
const ALL_BOOKING_STATUSES = ['SCHEDULED', 'CONFIRMED', 'ATTENDED', 'NO_RESPONSE', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED'];
const BOOKING_ACTION_STATUS = {
  confirmed: 'CONFIRMED',
  attended: 'ATTENDED',
  no_response: 'NO_RESPONSE',
  no_show: 'NO_SHOW',
  cancelled: 'CANCELLED',
  rescheduled: 'RESCHEDULED'
};
const BOOKING_STATUS_PRIORITY = {
  ATTENDED: 6,
  CONFIRMED: 5,
  SCHEDULED: 4,
  NO_RESPONSE: 3,
  NO_SHOW: 2,
  CANCELLED: 1,
  RESCHEDULED: 0
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

function buildLastBotFlowIssue(messages = []) {
  const issues = new Set(['engine_fallback', 'engine_suppressed', 'bot_manual_review']);
  const lastIssueMessage = [...(messages || [])]
    .reverse()
    .find((message) => {
      if (message?.direction !== 'OUTBOUND') return false;
      const source = String(message?.rawPayload?.source || '').trim();
      return issues.has(source);
    });

  if (!lastIssueMessage) return null;
  return {
    source: String(lastIssueMessage.rawPayload?.source || ''),
    reason: normalizeString(lastIssueMessage.rawPayload?.reason) || 'Sin detalle técnico registrado',
    createdAt: lastIssueMessage.createdAt || null
  };
}

function parseInterviewAssignment(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const [slotId, scheduledAtRaw] = raw.split('|');
  if (!slotId || !scheduledAtRaw) return null;
  const scheduledAt = new Date(scheduledAtRaw);
  if (Number.isNaN(scheduledAt.getTime())) return null;
  return { slotId, scheduledAt };
}

function bookingDedupKey(booking) {
  const candidateId = booking?.candidateId || booking?.candidate?.id || 'candidate';
  const vacancyId = booking?.vacancyId || booking?.vacancy?.id || 'vacancy';
  const scheduledAt = booking?.scheduledAt ? new Date(booking.scheduledAt).toISOString() : 'no-date';
  return `${candidateId}|${vacancyId}|${scheduledAt}`;
}

function bookingPriority(booking) {
  return BOOKING_STATUS_PRIORITY[booking?.status] || 0;
}

function normalizeInterviewBookings(bookings = []) {
  const unique = new Map();

  for (const booking of bookings) {
    const key = bookingDedupKey(booking);
    const current = unique.get(key);
    if (!current) {
      unique.set(key, booking);
      continue;
    }

    const incomingPriority = bookingPriority(booking);
    const currentPriority = bookingPriority(current);
    if (incomingPriority > currentPriority) {
      unique.set(key, booking);
      continue;
    }
    if (incomingPriority < currentPriority) continue;

    const incomingUpdatedAt = booking?.updatedAt ? new Date(booking.updatedAt).getTime() : 0;
    const currentUpdatedAt = current?.updatedAt ? new Date(current.updatedAt).getTime() : 0;
    if (incomingUpdatedAt > currentUpdatedAt) {
      unique.set(key, booking);
      continue;
    }

    const incomingCreatedAt = booking?.createdAt ? new Date(booking.createdAt).getTime() : 0;
    const currentCreatedAt = current?.createdAt ? new Date(current.createdAt).getTime() : 0;
    if (incomingCreatedAt > currentCreatedAt) {
      unique.set(key, booking);
    }
  }

  return Array.from(unique.values()).sort((a, b) => {
    const dateDiff = new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime();
    if (dateDiff !== 0) return dateDiff;
    return bookingPriority(b) - bookingPriority(a);
  });
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
  const expiresAt = lastInboundAt ? new Date(new Date(lastInboundAt).getTime() + WHATSAPP_WINDOW_MS) : null;
  const remainingMs = expiresAt ? (expiresAt.getTime() - now.getTime()) : 0;
  const isOpen = remainingMs > 0;
  return {
    hasInbound: Boolean(lastInboundAt),
    lastInboundAt,
    isOpen,
    expiresAt,
    remainingMs,
    expiringSoon: isOpen && remainingMs <= (2 * 60 * 60 * 1000)
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

function normalizeCandidateSnapshot(candidate) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const normalizedTransport = normalizeTransportMode(candidate.transportMode);
  return {
    ...candidate,
    phoneDisplay: formatPhoneForDisplay(candidate.phone),
    status: deriveCandidateStatusForUI({ ...candidate, transportMode: normalizedTransport || normalizeString(candidate.transportMode) }),
    transportMode: normalizedTransport || normalizeString(candidate.transportMode)
  };
}

function decorateDashboardCandidate(candidate) {
  const normalizedCandidate = normalizeCandidateSnapshot(candidate);
  const outboundWindowOpen = Boolean(normalizedCandidate?.lastInboundAt)
    && (Date.now() - new Date(normalizedCandidate.lastInboundAt).getTime()) <= WHATSAPP_WINDOW_MS;
  return {
    ...normalizedCandidate,
    hasCv: candidateHasCv(normalizedCandidate),
    isFemaleCandidate: normalizedCandidate?.gender === 'FEMALE',
    isFemaleHumanReview: isFemaleHumanReviewCandidate(normalizedCandidate),
    isManualAttention: isManualAttentionCandidate(normalizedCandidate),
    outboundWindowOpen,
    hasNewInbound: candidateHasUnreadInbound(normalizedCandidate),
    lastMessageAt: candidateLastMessageTime(normalizedCandidate) || null,
    lastMessageDirection: candidateLastMessageDirection(normalizedCandidate)
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

function buildManualInterviewReminderText(booking) {
  const fullName = normalizeString(booking?.candidate?.fullName);
  const firstName = fullName ? fullName.split(/\s+/)[0] : null;
  const greeting = firstName ? `Hola, ${firstName},` : 'Hola,';
  const scheduledAt = booking?.scheduledAt ? new Date(booking.scheduledAt) : null;

  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
    return `${greeting} Te escribo para recordarte tu entrevista. Por favor respóndeme con una de estas opciones: confirmo, cancelar o reprogramar.`;
  }

  const interviewDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(scheduledAt);

  const today = todayCO();
  const timeOnly = formatTimeCO(scheduledAt);
  const when = interviewDay === today
    ? `hoy a las ${timeOnly}`
    : formatInterviewDate(scheduledAt);

  return `${greeting} Tu entrevista está programada para ${when}. Por favor respóndeme con una de estas opciones: confirmo, cancelar o reprogramar.`;
}

async function buildDashboardData(prisma, dateStr, options = {}) {
  const { start, end } = colombiaDayBounds(dateStr);
  const accessContext = options.accessContext || getAccessContext({ userRole: options.role });
  const isDev = accessContext.isDev;
  const candidateFilters = options.candidateFilters || null;
  const shouldFilterCandidates = accessContext.isAdmin
    && candidateFilters
    && Object.values(candidateFilters).some(Boolean);
  const filterDashboardCandidates = (candidates) => (
    shouldFilterCandidates ? applyRecruiterCandidateFilters(candidates, candidateFilters) : candidates
  );
  const vacancyAccessWhere = buildVacancyAccessWhere(accessContext);

  const vacancies = await prisma.vacancy.findMany({
    where: {
      AND: [
        vacancyAccessWhere,
        {
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
              interviewNotes: true,
      cvOriginalName: true, cvMimeType: true, cvStorageKey: true, gender: true,
              botPaused: true, botPausedAt: true, botPauseReason: true,
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
        where: { status: { in: ACTIVE_CANDIDATE_STATUSES } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, fullName: true, phone: true,
          documentType: true, documentNumber: true,
          age: true, neighborhood: true, locality: true, zone: true, status: true,
          medicalRestrictions: true, transportMode: true,
          interviewNotes: true,
          cvOriginalName: true, cvMimeType: true, cvStorageKey: true,
          gender: true, createdAt: true,
          botPaused: true, botPausedAt: true, botPauseReason: true,
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

  const legacyCandidates = isDev
    ? await prisma.candidate.findMany({
      where: {
        vacancyId: null,
        status: { in: ACTIVE_CANDIDATE_STATUSES }
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, fullName: true, phone: true,
        documentType: true, documentNumber: true,
        age: true, neighborhood: true, locality: true, zone: true, status: true,
        medicalRestrictions: true, transportMode: true,
        interviewNotes: true,
        cvOriginalName: true, cvMimeType: true, cvStorageKey: true, createdAt: true,
        gender: true, botPaused: true, botPausedAt: true, botPauseReason: true,
        currentStep: true,
        lastInboundAt: true,
        lastOutboundAt: true,
        devLastSeenAt: true
      }
    })
    : [];

  const citiesMap = new Map();
  const manualAttentionMap = new Map();

  for (const v of vacancies) {
    const city = v.city || 'Sin ciudad';
    if (!citiesMap.has(city)) citiesMap.set(city, []);

    const candidatesWithFlags = v.candidates.map(decorateDashboardCandidate);
    for (const candidate of candidatesWithFlags) {
      if (candidate.isManualAttention) {
        manualAttentionMap.set(candidate.id, candidate);
      }
    }
    const bookedCandidateIds = new Set(candidatesWithFlags
      .filter((candidate) => candidate.interviewBookings.length > 0)
      .map((candidate) => candidate.id));
    const approvedCandidatesBase = candidatesWithFlags
      .filter((candidate) => normalizeCandidateStatusForUI(candidate.status) === 'APROBADO')
      .filter((candidate) => !v.schedulingEnabled || !bookedCandidateIds.has(candidate.id));
    const contractedCandidatesBase = candidatesWithFlags
      .filter((candidate) => normalizeCandidateStatusForUI(candidate.status) === 'CONTRATADO')
      .filter((candidate) => !v.schedulingEnabled || !bookedCandidateIds.has(candidate.id));
    const pendingReviewCandidates = candidatesWithFlags
      .filter((candidate) => ['NUEVO', 'REGISTRADO'].includes(normalizeCandidateStatusForUI(candidate.status)));
    const operationallyRegisteredCandidates = pendingReviewCandidates
      .filter((candidate) => isOperationallyRegistered(candidate));
    const operationallyCompleteWithoutCvCandidates = pendingReviewCandidates
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
    const approvedCandidates = filterDashboardCandidates(approvedCandidatesBase);
    const contractedCandidates = filterDashboardCandidates(contractedCandidatesBase);
    const filteredBookingsToday = normalizeInterviewBookings(v.interviewBookings)
      .map(b => ({
        ...b,
        candidate: decorateDashboardCandidate(b.candidate),
        formattedTime: formatTimeCO(b.scheduledAt),
        formattedDateTime: formatDateTimeCO(b.scheduledAt),
        isFemaleHumanReview: isFemaleHumanReviewCandidate(b.candidate)
      }))
      .filter((booking) => (
        !shouldFilterCandidates || applyRecruiterCandidateFilters([booking.candidate], candidateFilters).length > 0
      ));

    if (isDev) {
      registeredNoBooking.sort(compareCandidatesByRecentInbound);
      registeredComplete.sort(compareCandidatesByRecentInbound);
      completeWithoutCv.sort(compareCandidatesByRecentInbound);
      approvedCandidates.sort(compareCandidatesByRecentInbound);
      contractedCandidates.sort(compareCandidatesByRecentInbound);
    }

    const enriched = {
      ...v,
      bookingsToday: filteredBookingsToday,
      registeredNoBooking,
      registeredComplete,
      completeWithoutCv,
      approvedCandidates,
      contractedCandidates
    };

    citiesMap.get(city).push(enriched);
  }

  const cities = Array.from(citiesMap.entries()).map(([name, vacs]) => ({ name, vacancies: vacs }));
  const decoratedLegacyCandidates = filterDashboardCandidates(legacyCandidates.map(decorateDashboardCandidate));
  if (isDev) decoratedLegacyCandidates.sort(compareCandidatesByRecentInbound);
  for (const candidate of decoratedLegacyCandidates) {
    if (candidate.isManualAttention) {
      manualAttentionMap.set(candidate.id, candidate);
    }
  }
  const manualReviewCandidates = Array.from(manualAttentionMap.values()).sort(compareCandidatesByRecentInbound);
  return {
    cities,
    legacyCandidates: decoratedLegacyCandidates,
    manualReviewCandidates
  };
}

async function loadApprovedOutreachCandidates(prisma, accessContext = null) {
  const candidates = await prisma.candidate.findMany({
    where: {
      ...buildCandidateAccessWhere(accessContext || { scope: 'ALL', isDev: true }),
      status: 'APROBADO'
    },
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
  const normalizeRequiredDocuments = (value) => {
    const values = Array.isArray(value)
      ? value
      : (typeof value === 'string' ? [value] : []);

    const normalized = values
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean);

    return normalized.length ? normalized.join('\n') : null;
  };
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
    requiredDocuments:    normalizeRequiredDocuments(body.requiredDocuments),
    minAge:               int(body.minAge),
    maxAge:               int(body.maxAge),
    experienceRequired:   str(body.experienceRequired) || 'INDIFFERENT',
    experienceTimeText:   (str(body.experienceRequired) === 'YES' ? str(body.experienceTimeText) : null),
    isActive:             bool(body.isActive),
    acceptingApplications: bool(body.acceptingApplications),
    schedulingEnabled:    bool(body.schedulingEnabled),
    slotDays:             [...new Set(slotDays
      .map((value) => parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6))].sort((a, b) => a - b),
    slotStartTime:        time(body.slotStartTime),
    slotMaxCandidates:    positiveInt(body.slotMaxCandidates, 10),
  };
}

function hasValidInterviewConfig(data) {
  if (!data.schedulingEnabled) return true;
  return Boolean(data.slotDays.length && data.slotStartTime);
}

function hasValidExperienceConfig(data) {
  if (data.experienceRequired !== 'YES') return true;
  return Boolean(data.experienceTimeText);
}

function buildWeeklyInterviewSlots(vacancyId, data) {
  return data.slotDays.map((dayOfWeek) => ({
    vacancyId,
    dayOfWeek,
    startTime: data.slotStartTime,
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
async function loadOperations(prisma, options = {}) {
  try {
    const allowedCities = Array.isArray(options.allowedCities) ? options.allowedCities.filter(Boolean) : [];
    return await prisma.operation.findMany({
      where: allowedCities.length
        ? { city: { name: { in: allowedCities } } }
        : undefined,
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
          botPausedAt: true,
          botPauseReason: true
        }
      }
    }
  });
}

async function loadBotChatCount(prisma) {
  if (typeof prisma?.candidate?.count === 'function') {
    return prisma.candidate.count();
  }

  if (typeof prisma?.candidate?.findMany === 'function') {
    const candidates = await prisma.candidate.findMany({
      select: { id: true }
    });
    return Array.isArray(candidates) ? candidates.length : 0;
  }

  return 0;
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
    const accessContext = getRequestAccessContext(req);
    const requestedStatus = normalizeString(req.query.status);
    const adminFilters = normalizeCandidateListFilters(req.query);
    const vacancyFiltersById = normalizeVacancyDashboardFilters(req.query);
    const candidateSearch = normalizeCandidateSearch(req.query);
    const vacancySearchById = normalizeVacancySearches(req.query);
    const botChatCount = await loadBotChatCount(prisma);
    const canUseLegacyScope = requestedStatus
      && ADMIN_STATUS_SCOPES.has(requestedStatus)
      && (req.userRole === 'dev' || RECRUITER_STATUS_SCOPES.has(requestedStatus));

    if (canUseLegacyScope) {
      const legacyQuery = {
        where: buildCandidateAccessWhere(accessContext),
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
          interviewNotes: true,
          status: true,
          rejectionReason: true,
          rejectionDetails: true,
          createdAt: true,
          cvMimeType: true,
          cvOriginalName: true,
          cvStorageKey: true,
          gender: true,
            botPaused: true,
            botPausedAt: true,
            botPauseReason: true,
            lastInboundAt: true,
          lastOutboundAt: true,
          devLastSeenAt: true,
          vacancy: { select: { city: true } }
        }
      };
      if (requestedStatus === 'inbox' && req.userRole === 'dev') {
        legacyQuery.where = {
          ...buildCandidateAccessWhere(accessContext),
          lastInboundAt: { not: null }
        };
        legacyQuery.orderBy = [{ lastInboundAt: 'desc' }, { createdAt: 'desc' }];
      }
      if (req.userRole !== 'dev' && !['registered', 'missing_cv_complete'].includes(requestedStatus)) {
        legacyQuery.take = 200;
      }

      const allCandidates = (await prisma.candidate.findMany(legacyQuery))
        .map(decorateDashboardCandidate);
      let candidates = filterCandidatesByScope(allCandidates, requestedStatus);
      if (req.userRole === 'admin' && requestedStatus === 'all') {
        candidates = candidates.filter((candidate) => normalizeCandidateStatusForUI(candidate.status) !== 'NUEVO');
      }
      if (req.userRole === 'admin' && ['registered', 'missing_cv_complete'].includes(requestedStatus)) {
        candidates = applyRecruiterCandidateFilters(candidates, adminFilters);
      }
      if (candidateSearch.text) {
        candidates = candidates.filter((candidate) => candidateMatchesSearch(candidate, candidateSearch));
      }
      candidates.sort(compareCandidatesByRecentInbound);
      return res.render('list', {
        mode: 'legacy', candidates, formatDateTimeCO, role: req.userRole,
        canManageUsers: canManageRecruiterUsers(req),
        activeStatusScope: requestedStatus,
        summaryLabel: STATUS_SCOPE_SUMMARY_LABELS[requestedStatus] || STATUS_SCOPE_SUMMARY_LABELS.all,
        normalizeCandidateStatusForUI, cities: [], legacyCandidates: [], manualReviewCandidates: [],
        activeCity: null, selectedDate: todayCO(), todayStr: todayCO(),
        successMsg: normalizeString(req.query.success),
        errorMsg: normalizeString(req.query.error),
        isFemaleHumanReviewCandidate,
        adminFilters,
        candidateSearch,
        botChatCount,
        vacancyFiltersById: {},
        vacancySearchById: {}
      });
    }

    const rawDate = normalizeString(req.query.date);
    const selectedDate = isValidDateString(rawDate) ? rawDate : todayCO();
    const { cities, legacyCandidates, manualReviewCandidates } = await buildDashboardData(prisma, selectedDate, {
      role: req.userRole,
      accessContext
    });

    const rawCity = normalizeString(req.query.city);
    const availableCities = cities.map(c => c.name);
    const activeCity = (rawCity && availableCities.includes(rawCity))
      ? rawCity : (availableCities[0] || null);

    return res.render('list', {
      mode: 'vacancies', cities, legacyCandidates, manualReviewCandidates, activeCity, selectedDate,
      todayStr: todayCO(), formatDateTimeCO, formatTimeCO, role: req.userRole,
      canManageUsers: canManageRecruiterUsers(req),
      normalizeCandidateStatusForUI, candidates: [], activeStatusScope: null, summaryLabel: '',
      successMsg: normalizeString(req.query.success),
      errorMsg: normalizeString(req.query.error),
      isFemaleHumanReviewCandidate,
      botChatCount,
      adminFilters,
      candidateSearch: null,
      vacancyFiltersById,
      vacancySearchById
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
    const accessContext = getRequestAccessContext(req);
    const scope = normalizeString(req.query.scope) || 'all';
    const vacancyId = normalizeString(req.query.vacancyId);
    if (!EXPORT_SCOPES.has(scope)) return res.status(400).send('Scope inválido.');
    if (!vacancyId) return res.status(400).send('Debes seleccionar una vacante para exportar.');
    const vacancy = await ensureVacancyIdAccess(prisma, req, vacancyId, res, '/admin');
    if (!vacancy) return;

    const allCandidates = await prisma.candidate.findMany({
      where: {
        ...buildCandidateAccessWhere(accessContext),
        vacancyId
      },
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
          cvStorageKey: true,
        vacancy: { select: { city: true } }
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
      const residenceConfig = getResidenceFieldConfig(normalizedCandidate.vacancy);
      const residenceValue = getCandidateResidenceValue(normalizedCandidate, normalizedCandidate.vacancy) || normalizedCandidate.zone || '';
      const whatsappLink = buildWhatsAppLink(normalizedCandidate.phone);
      const row = sheet.addRow({
        ...normalizedCandidate,
        neighborhood: residenceConfig.field === 'neighborhood' ? residenceValue : '',
        locality: residenceConfig.field === 'locality' ? residenceValue : (normalizedCandidate.locality || ''),
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
      CONTRATADO: 'FFE0F2FE',
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
    const filename = exportFilenameByScopeAndVacancy(scope, vacancy);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  });

  // ── Detalle de candidato ─────────────────────────────────────
  router.get('/outreach/approved', async (req, res) => {
    const accessContext = getRequestAccessContext(req);
    const outreachFilters = normalizeOutreachFilters(req.query);
    const allApprovedCandidates = await loadApprovedOutreachCandidates(prisma, accessContext);
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
    const accessContext = getRequestAccessContext(req);
    const outreachFilters = normalizeOutreachFilters(req.body);
    const selectedCandidateIds = Array.isArray(req.body.candidateIds)
      ? req.body.candidateIds
      : (req.body.candidateIds ? [req.body.candidateIds] : []);
    const selectedIds = new Set(selectedCandidateIds.map((value) => String(value || '').trim()).filter(Boolean));
    const allApprovedCandidates = await loadApprovedOutreachCandidates(prisma, accessContext);
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
    const accessContext = getRequestAccessContext(req);
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      include: {
        vacancy: {
          select: {
            id: true,
            title: true,
            city: true,
            role: true,
            schedulingEnabled: true,
            acceptingApplications: true,
            isActive: true,
            operationAddress: true,
            interviewAddress: true,
            roleDescription: true,
            requirements: true,
            conditions: true,
            experienceRequired: true,
            experienceTimeText: true
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
    if (!canAccessCandidate(accessContext, candidate)) {
      return res.redirect(withFlashMessage(returnToPath, 'error', 'No tienes acceso a ese candidato.'));
    }

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
    const adminEvents = req.userRole === 'dev' && typeof prisma?.candidateAdminEvent?.findMany === 'function'
      ? await prisma.candidateAdminEvent.findMany({
        where: { candidateId: candidate.id },
        orderBy: { createdAt: 'desc' },
        take: 30
      })
      : [];
    const availableInterviewSlots = candidate.vacancyId && candidate.vacancy?.schedulingEnabled
      ? (await listOfferableSlots(
        prisma,
        candidate.vacancyId,
        candidate.lastInboundAt ? new Date(candidate.lastInboundAt) : null,
        new Date(),
        req.userRole === 'dev' ? 0 : undefined
      )).slice(0, 12)
      : [];
    const availableVacancies = req.userRole === 'dev'
      ? await prisma.vacancy.findMany({
        where: {
          AND: [
            buildVacancyAccessWhere(accessContext),
            {
              OR: [
                { isActive: true },
                { acceptingApplications: true }
              ]
            }
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
      interviewBookings: normalizeInterviewBookings(candidate.interviewBookings || []),
      hasCv: candidateHasCv(candidate),
      outboundWindowOpen: outboundWindow?.isOpen ?? (
        Boolean(candidate.lastInboundAt)
        && (Date.now() - new Date(candidate.lastInboundAt).getTime()) <= WHATSAPP_WINDOW_MS
      ),
      lastInboundAt: outboundWindow?.lastInboundAt || candidate.lastInboundAt || null,
      hasNewInbound: candidateHasUnreadInbound(candidate)
    };
    const lastBotFlowIssue = req.userRole === 'dev'
      ? buildLastBotFlowIssue(candidate.messages || [])
      : null;

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
      canManageUsers: canManageRecruiterUsers(req),
      normalizeCandidateStatusForUI, cvSizeBytes,
      formatActorRoleLabel,
      formatAdminEventLabel,
      availableVacancies,
      availableInterviewSlots,
      adminEvents,
      lastBotFlowIssue,
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
      select: { id: true, candidateId: true, status: true }
    });
    if (!booking) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Entrevista no encontrada.'));
    }
    if (!await ensureCandidateIdAccess(prisma, req, booking.candidateId, res, returnTo)) return;

    await prisma.interviewBooking.update({
      where: { id },
      data: { status: nextStatus }
    });
    await logCandidateAdminEvent(prisma, {
      candidateId: booking.candidateId,
      actorRole: req.userRole,
      eventType: 'INTERVIEW_STATUS_CHANGED',
      eventLabel: 'ActualizÃ³ estado de entrevista',
      fromValue: booking.status,
      toValue: nextStatus
    });

    return res.redirect(withFlashMessage(returnTo, 'success', 'Entrevista actualizada correctamente.'));
  });

  router.post('/interviews/:id/manual-reminder', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const returnTo = safeAdminReturnPath(req.body.returnTo || req.get('referer') || '/admin');

    const booking = await prisma.interviewBooking.findUnique({
      where: { id },
      include: {
        candidate: {
          include: {
            vacancy: {
              select: {
                city: true
              }
            }
          }
        }
      }
    });
    if (!booking || !booking.candidate) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Entrevista no encontrada.'));
    }
    if (!await ensureCandidateIdAccess(prisma, req, booking.candidateId, res, returnTo)) return;
    if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Solo puedes enviar recordatorio para entrevistas activas.'));
    }

    const window = await getOutboundWindowStatus(prisma, booking.candidateId);
    if (!window.isOpen) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'La ventana de 24h de WhatsApp está vencida. No se puede enviar mensaje.'));
    }

    const body = buildManualInterviewReminderText(booking);
    try {
      await sendAdminOutboundMessage(prisma, booking.candidate, body, {
        source: 'admin_manual_interview_reminder',
        interviewBookingId: booking.id
      });
      await logCandidateAdminEvent(prisma, {
        candidateId: booking.candidateId,
        actorRole: req.userRole,
        eventType: 'INTERVIEW_MANUAL_REMINDER_SENT',
        eventLabel: 'Envio recordatorio manual de entrevista',
        note: booking?.scheduledAt ? `Horario: ${formatInterviewDate(new Date(booking.scheduledAt))}` : null
      });
      return res.redirect(withFlashMessage(returnTo, 'success', 'Recordatorio manual enviado correctamente.'));
    } catch (err) {
      console.error('[manual_interview_reminder]', err);
      return res.redirect(withFlashMessage(returnTo, 'error', 'No fue posible enviar el recordatorio manual.'));
    }
  });

  router.post('/interviews/:id/delete', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const returnTo = safeAdminReturnPath(req.body.returnTo || req.get('referer') || '/admin');

    const booking = await prisma.interviewBooking.findUnique({
      where: { id },
      select: {
        id: true,
        candidateId: true
      }
    });

    if (!booking) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Agendamiento no encontrado.'));
    }

    await prisma.$transaction(async (tx) => {
      await tx.interviewBooking.delete({
        where: { id: booking.id }
      });

      const remainingActiveBooking = await tx.interviewBooking.findFirst({
        where: {
          candidateId: booking.candidateId,
          status: { in: ACTIVE_BOOKING_STATUSES }
        },
        select: { id: true }
      });

      if (!remainingActiveBooking) {
        await tx.candidate.update({
          where: { id: booking.candidateId },
          data: {
            currentStep: ConversationStep.SCHEDULING
          }
        });
      }
    });

    return res.redirect(withFlashMessage(returnTo, 'success', 'Agendamiento eliminado correctamente.'));
  });

  router.post('/candidates/:id/interview-assign', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const returnTo = safeAdminReturnPath(req.body.returnTo || `/admin/candidates/${id}`);
    try {
      const selectedSlot = parseInterviewAssignment(req.body.slotOption);
      if (!selectedSlot) {
        return res.redirect(withFlashMessage(returnTo, 'error', 'Debes seleccionar un horario de entrevista válido.'));
      }

      const candidate = await prisma.candidate.findUnique({
        where: { id },
        select: {
          id: true,
          vacancyId: true,
          lastInboundAt: true,
          vacancy: {
            select: {
              id: true,
              title: true,
              role: true,
              schedulingEnabled: true
            }
          }
        }
      });

      if (!candidate) {
        return res.redirect(withFlashMessage(returnTo, 'error', 'Candidato no encontrado.'));
      }
      if (!ensureCandidateAccess(req, candidate, res, returnTo)) {
        return;
      }

      if (!candidate.vacancyId || !candidate.vacancy?.schedulingEnabled) {
        return res.redirect(withFlashMessage(returnTo, 'error', 'La vacante del candidato no tiene agenda habilitada.'));
      }

      const offerableSlots = await listOfferableSlots(
        prisma,
        candidate.vacancyId,
        candidate.lastInboundAt ? new Date(candidate.lastInboundAt) : null,
        new Date(),
        0
      );

      const chosenOffer = offerableSlots.find((option) => (
        option.slot?.id === selectedSlot.slotId
        && option.date?.getTime?.() === selectedSlot.scheduledAt.getTime()
      ));

      if (!chosenOffer?.slot) {
        return res.redirect(withFlashMessage(returnTo, 'error', 'Ese horario ya no está disponible. Actualiza la página e intenta de nuevo.'));
      }

      await prisma.$transaction(async (tx) => {
        const activeBooking = await tx.interviewBooking.findFirst({
          where: {
            candidateId: candidate.id,
            status: { in: ACTIVE_BOOKING_STATUSES }
          },
          select: { id: true }
        });

        if (activeBooking) {
          await cancelCandidateBookings(tx, candidate.id, 'RESCHEDULED');
        }

        await createBooking(
          tx,
          candidate.id,
          candidate.vacancyId,
          chosenOffer.slot.id,
          chosenOffer.date,
          !chosenOffer.windowOk
        );
      });

      try {
        await prisma.candidate.update({
          where: { id: candidate.id },
          data: { currentStep: ConversationStep.SCHEDULED }
        });
      } catch (stepError) {
        console.error('[manual_interview_assign_step_update]', {
          candidateId: candidate.id,
          preferredStep: ConversationStep.SCHEDULED,
          stepError
        });
        try {
          await prisma.candidate.update({
            where: { id: candidate.id },
            data: { currentStep: ConversationStep.SCHEDULING }
          });
        } catch (fallbackStepError) {
          console.error('[manual_interview_assign_step_update_fallback]', {
            candidateId: candidate.id,
            fallbackStep: ConversationStep.SCHEDULING,
            fallbackStepError
          });
        }
      }

      await logCandidateAdminEvent(prisma, {
        candidateId: candidate.id,
        actorRole: req.userRole,
        eventType: 'INTERVIEW_ASSIGNED',
        eventLabel: 'AsignÃ³ entrevista manualmente',
        note: chosenOffer.formattedDate
      });

    return res.redirect(withFlashMessage(returnTo, 'success', `Entrevista asignada para ${chosenOffer.formattedDate}.`));
    } catch (error) {
      console.error('[manual_interview_assign]', {
        candidateId: id,
        returnTo,
        slotOption: req.body?.slotOption,
        error
      });
      return res.redirect(withFlashMessage(returnTo, 'error', 'No fue posible asignar la entrevista en este momento.'));
    }
  });

  // ── Cambiar estado ───────────────────────────────────────────
  router.post('/candidates/:id/status', express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const status = normalizeString(req.body.status);
    const returnTo = safeAdminReturnPath(req.body.returnTo || '/admin');
    const allowed = req.userRole === 'dev'
      ? ['NUEVO', 'REGISTRADO', 'APROBADO', 'CONTACTADO', 'CONTRATADO', 'RECHAZADO']
      : ['REGISTRADO', 'APROBADO', 'CONTACTADO', 'CONTRATADO', 'RECHAZADO'];
    if (!status || !allowed.includes(status)) return res.redirect(buildCandidateDetailPath(id, returnTo));
    const existingCandidate = await prisma.candidate.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        fullName: true,
        vacancyId: true,
        vacancy: { select: { id: true, city: true } }
      }
    });
    if (!existingCandidate) return res.redirect(withFlashMessage(returnTo, 'error', 'Candidato no encontrado.'));
    if (!ensureCandidateAccess(req, existingCandidate, res, returnTo)) return;

    await prisma.candidate.update({ where: { id }, data: { status } });
    if (existingCandidate.status !== status) {
      await logCandidateAdminEvent(prisma, {
        candidateId: id,
        actorRole: req.userRole,
        eventType: 'STATUS_CHANGED',
        eventLabel: 'Cambio de estado',
        fromValue: formatAdminEventValue(existingCandidate.status),
        toValue: formatAdminEventValue(status)
      });
    }
    res.redirect(buildCandidateDetailPath(id, returnTo));
  });

  // ── Edición manual ───────────────────────────────────────────
  router.get('/candidates/:id/open-whatsapp', async (req, res) => {
    const { id } = req.params;
    const returnTo = safeAdminReturnPath(req.query.returnTo || req.get('referer') || '/admin');
    const whatsappText = typeof req.query.text === 'string' ? req.query.text.trim() : '';
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      select: {
        id: true,
        phone: true,
        status: true,
        vacancyId: true,
        vacancy: { select: { id: true, city: true } }
      }
    });

    if (!candidate) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Candidato no encontrado.'));
    }
    if (!ensureCandidateAccess(req, candidate, res, returnTo)) return;

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
    if (req.userRole !== 'dev' && candidate.status !== 'CONTACTADO') {
      await logCandidateAdminEvent(prisma, {
        candidateId: id,
        actorRole: req.userRole,
        eventType: 'WHATSAPP_OPENED',
        fromValue: formatAdminEventValue(candidate.status),
        eventLabel: 'AbriÃ³ WhatsApp del candidato',
        toValue: 'Contactado'
      });
    }

    const whatsappUrl = whatsappText
      ? `${whatsappBaseUrl}?text=${encodeURIComponent(whatsappText)}`
      : whatsappBaseUrl;
    return res.redirect(whatsappUrl);
  });

  router.post('/candidates/:id/send-vacancy-info', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const returnTo = safeAdminReturnPath(req.body.returnTo || `/admin/candidates/${id}`);
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      select: {
        id: true,
        phone: true,
        vacancy: {
          select: {
            id: true,
            title: true,
            city: true,
            role: true,
            roleDescription: true,
            requirements: true,
            conditions: true,
            operationAddress: true,
            interviewAddress: true,
            acceptingApplications: true
          }
        }
      }
    });

    if (!candidate) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Candidato no encontrado.'));
    }
    if (!ensureCandidateAccess(req, candidate, res, returnTo)) return;

    if (!candidate.vacancy) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'El candidato no tiene una vacante asignada.'));
    }

    const window = await getOutboundWindowStatus(prisma, id);
    if (!window.isOpen) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'La ventana de 24h de WhatsApp está vencida. No se puede enviar la información de la vacante.'));
    }

    const body = buildManualVacancyInfoMessage(candidate.vacancy);
    if (!body) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'La vacante no tiene información suficiente para enviarla.'));
    }

    try {
      await sendAdminOutboundMessage(prisma, candidate, body, {
        source: 'admin_manual_vacancy_info',
        action: 'send_vacancy_info',
        vacancyId: candidate.vacancy.id
      });
      return res.redirect(withFlashMessage(returnTo, 'success', 'Información de la vacante enviada correctamente.'));
    } catch (error) {
      console.error('[send_vacancy_info]', error);
      return res.redirect(withFlashMessage(returnTo, 'error', 'No fue posible enviar la información de la vacante.'));
    }
  });

  router.post('/candidates/:id/assign-vacancy', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const vacancyId = normalizeString(req.body.vacancyId);
    const returnTo = `/admin/candidates/${id}`;

    const candidate = await prisma.candidate.findUnique({
      where: { id },
      select: {
        id: true,
        vacancyId: true,
        vacancy: {
          select: {
            title: true,
            role: true,
            city: true
          }
        }
      }
    });
    if (!candidate) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Candidato no encontrado.'));
    }
    if (!ensureCandidateAccess(req, candidate, res, returnTo)) return;

    if (!vacancyId) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Debes seleccionar una vacante.'));
    }

    const vacancy = await prisma.vacancy.findUnique({
      where: { id: vacancyId },
      select: {
        id: true,
        title: true,
        role: true,
        city: true,
        isActive: true,
        acceptingApplications: true
      }
    });
    if (!vacancy || (!vacancy.isActive && !vacancy.acceptingApplications)) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'La vacante seleccionada no está disponible para asignación.'));
    }

    if (!ensureVacancyAccess(req, vacancy, res, returnTo)) return;
    await prisma.candidate.update({
      where: { id },
      data: { vacancyId: vacancy.id }
    });
    const previousVacancyLabel = candidate.vacancy
      ? `${candidate.vacancy.title || candidate.vacancy.role}${candidate.vacancy.city ? ` (${candidate.vacancy.city})` : ''}`
      : null;
    const nextVacancyLabel = `${vacancy.title || vacancy.role}${vacancy.city ? ` (${vacancy.city})` : ''}`;
    await logCandidateAdminEvent(prisma, {
      candidateId: id,
      actorRole: req.userRole,
      eventType: 'VACANCY_ASSIGNED',
      eventLabel: candidate.vacancyId ? 'Cambio vacante asignada' : 'Asigno vacante al candidato',
      fromValue: previousVacancyLabel,
      toValue: nextVacancyLabel
    });

    return res.redirect(withFlashMessage(returnTo, 'success', 'Vacante asignada correctamente.'));
  });

  router.post('/candidates/:id/delete', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const returnTo = safeAdminReturnPath(req.body.returnTo || '/admin');

    const candidate = await prisma.candidate.findUnique({
      where: { id },
      select: { id: true, fullName: true, cvStorageKey: true }
    });

    if (!candidate) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Candidato no encontrado.'));
    }

    await prisma.$transaction(async (tx) => {
      await tx.message.deleteMany({
        where: { candidateId: candidate.id }
      });

      await tx.interviewBooking.deleteMany({
        where: { candidateId: candidate.id }
      });

      await tx.candidate.delete({
        where: { id: candidate.id }
      });
    });

    await clearCandidateCvStorage(candidate);

    const candidateLabel = candidate.fullName || 'el candidato';
    return res.redirect(withFlashMessage(returnTo, 'success', `Se eliminó ${candidateLabel} correctamente.`));
  });

  router.post('/candidates/:id/edit', express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const returnTo = safeAdminReturnPath(req.body.returnTo || '/admin');
    const raw = req.body;
    const existingCandidate = await prisma.candidate.findUnique({
      where: { id },
      select: {
      id: true,
      status: true,
      gender: true,
      interviewNotes: true,
      botPaused: true,
      botPausedAt: true,
      botPauseReason: true,
        cvData: true,
        cvOriginalName: true,
        cvMimeType: true,
        cvStorageKey: true,
        currentStep: true,
        vacancy: { select: { city: true, experienceRequired: true } }
      }
    });

    if (!existingCandidate) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Candidato no encontrado.'));
    }
    if (!ensureCandidateAccess(req, existingCandidate, res, returnTo)) return;

    const residenceInput = normalizeString(raw.residenceArea) || normalizeString(raw.locality) || normalizeString(raw.neighborhood);
    let candidateCoreFields = normalizeCandidateFields({
      fullName:            normalizeString(raw.fullName),
      documentType:        normalizeString(raw.documentType),
      documentNumber:      normalizeString(raw.documentNumber),
      age:                 raw.age ? parseInt(raw.age, 10) : null,
      neighborhood:        residenceInput,
      locality:            residenceInput,
      medicalRestrictions: normalizeString(raw.medicalRestrictions),
      transportMode:       normalizeString(raw.transportMode),
      experienceInfo:      normalizeString(raw.experienceInfo),
      experienceTime:      normalizeString(raw.experienceTime),
      experienceSummary:   normalizeString(raw.experienceSummary),
    });
    candidateCoreFields = alignCandidateLocationFields(candidateCoreFields, existingCandidate.vacancy, { clearAlternate: true });
    if (existingCandidate.vacancy?.experienceRequired === 'YES' && candidateCoreFields.experienceInfo === 'Sí' && !candidateCoreFields.experienceTime) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'Para esta vacante debes diligenciar el tiempo de experiencia del candidato cuando tenga experiencia.'));
    }
    const adminStatusFields = {
      rejectionReason:  normalizeString(raw.rejectionReason),
      rejectionDetails: normalizeString(raw.rejectionDetails),
    };
    const status = normalizeString(raw.status);
    if (status) adminStatusFields.status = status;
    const canEditGender = req.userRole === 'dev';
    const gender = canEditGender ? normalizeGenderInput(raw.gender) : null;
    if (gender) adminStatusFields.gender = gender;
    if (req.userRole === 'dev') adminStatusFields.interviewNotes = normalizeString(raw.interviewNotes);

    if (canEditGender && gender === Gender.FEMALE) {
      const hasCv = candidateHasCv(existingCandidate);
      if (hasCv || [ConversationStep.ASK_CV, ConversationStep.DONE, ConversationStep.SCHEDULING, ConversationStep.SCHEDULED].includes(existingCandidate.currentStep)) {
        adminStatusFields.botPaused = true;
        adminStatusFields.botPausedAt = new Date();
        adminStatusFields.botPausedBy = req.userRole || 'admin';
        adminStatusFields.botPauseReason = 'Candidata femenina pendiente de revision humana';
        adminStatusFields.reminderScheduledFor = null;
        adminStatusFields.reminderState = 'SKIPPED';
      }
    }

    const data = { ...candidateCoreFields, ...adminStatusFields };
    await prisma.candidate.update({ where: { id }, data });
    if (existingCandidate.status !== data.status && data.status) {
      await logCandidateAdminEvent(prisma, {
        candidateId: id,
        actorRole: req.userRole,
        eventType: 'STATUS_CHANGED',
        eventLabel: 'EdiciÃ³n manual de estado',
        fromValue: formatAdminEventValue(existingCandidate.status),
        toValue: formatAdminEventValue(data.status)
      });
    }
    if (req.userRole === 'dev' && existingCandidate.interviewNotes !== data.interviewNotes && data.interviewNotes !== undefined) {
      await logCandidateAdminEvent(prisma, {
        candidateId: id,
        actorRole: req.userRole,
        eventType: 'DEV_NOTES_UPDATED',
        eventLabel: 'ActualizÃ³ observaciones dev',
        note: data.interviewNotes ? 'Observaciones actualizadas.' : 'Observaciones eliminadas.'
      });
    }
    if (req.userRole === 'dev' && existingCandidate.gender !== data.gender && data.gender) {
      await logCandidateAdminEvent(prisma, {
        candidateId: id,
        actorRole: req.userRole,
        eventType: 'GENDER_UPDATED',
        eventLabel: 'ActualizÃ³ gÃ©nero del candidato',
        fromValue: existingCandidate.gender,
        toValue: data.gender
      });
    }
    res.redirect(buildCandidateDetailPath(id, returnTo));
  });

  // ── Pausar / reanudar bot ────────────────────────────────────
  router.post('/candidates/:id/bot-pause', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const reason = normalizeString(req.body.reason) || 'Pausa manual desde admin';
    if (!await ensureCandidateIdAccess(prisma, req, id, res, `/admin/candidates/${id}`)) return;
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
    await logCandidateAdminEvent(prisma, {
      candidateId: id,
      actorRole: req.userRole,
      eventType: 'BOT_PAUSED',
      eventLabel: 'PausÃ³ el bot',
      note: reason
    });
    res.redirect(`/admin/candidates/${id}?botPauseSuccess=` + encodeURIComponent('Bot pausado correctamente.'));
  });

  router.post('/candidates/:id/bot-resume', ensureDevRole, async (req, res) => {
    const { id } = req.params;
    if (!await ensureCandidateIdAccess(prisma, req, id, res, `/admin/candidates/${id}`)) return;
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
    await logCandidateAdminEvent(prisma, {
      candidateId: id,
      actorRole: req.userRole,
      eventType: 'BOT_RESUMED',
      eventLabel: 'ReanudÃ³ el bot'
    });
    res.redirect(`/admin/candidates/${id}?botPauseSuccess=` + encodeURIComponent('Bot reanudado correctamente.'));
  });

  // ── CV: descargar ────────────────────────────────────────────
  router.get('/candidates/:id/cv', async (req, res) => {
    const candidate = await prisma.candidate.findUnique({ where: { id: req.params.id } });
    if (!candidate) return res.status(404).send('CV no encontrado.');
    if (!await ensureCandidateIdAccess(prisma, req, req.params.id, null)) return res.status(403).send('Sin acceso.');
    if (!candidateHasCv(candidate)) return res.status(404).send('CV no encontrado.');
    const buffer = await resolveCandidateCvBuffer(candidate);
    if (!buffer) return res.status(404).send('CV no encontrado.');
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
    if (!await ensureCandidateIdAccess(prisma, req, id, res, `/admin/candidates/${id}`)) return;
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
    const existingCandidate = await prisma.candidate.findUnique({
      where: { id },
      select: { id: true, cvStorageKey: true }
    });
    await storeCandidateCv(prisma, id, buffer, {
      currentCvStorageKey: existingCandidate?.cvStorageKey || null,
      mimeType: file.mimetype || 'application/octet-stream',
      originalName: file.originalname || 'hoja_de_vida'
    });
    res.redirect(`/admin/candidates/${id}?` + buildCvStatusQuery('cvSuccess', 'Hoja de vida actualizada correctamente.'));
  });

  // ── CV: eliminar ─────────────────────────────────────────────
  router.post('/candidates/:id/cv/delete', async (req, res) => {
    if (!await ensureCandidateIdAccess(prisma, req, req.params.id, res, `/admin/candidates/${req.params.id}`)) return;
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.params.id },
      select: { id: true, cvStorageKey: true }
    });
    await prisma.candidate.update({
      where: { id: req.params.id },
      data: { cvData: null, cvMimeType: null, cvOriginalName: null, cvStorageKey: null }
    });
    await clearCandidateCvStorage(candidate || {});
    res.redirect(`/admin/candidates/${req.params.id}?` + buildCvStatusQuery('cvSuccess', 'Hoja de vida eliminada.'));
  });

  // ── Mensajes salientes (solo dev) ────────────────────────────
  router.post('/candidates/:id/outbound', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const action = normalizeString(req.body.action);
    const customBody = normalizeString(req.body.customBody);

    const candidate = await prisma.candidate.findUnique({
      where: { id },
      include: {
        vacancy: {
          select: {
            city: true
          }
        }
      }
    });
    if (!candidate) return res.redirect(`/admin/candidates/${id}?outboundError=Candidato no encontrado.`);
    if (!ensureCandidateAccess(req, candidate, res, `/admin/candidates/${id}`)) return;

    const window = await getOutboundWindowStatus(prisma, id);
    if (!window.isOpen) {
      return res.redirect(`/admin/candidates/${id}?outboundError=` +
        encodeURIComponent('La ventana de 24h de WhatsApp está vencida. No se puede enviar mensaje.'));
    }

    const templates = {
      request_hv: 'Para continuar tu proceso necesito tu Hoja de vida (HV) en PDF o Word (.doc/.docx).',
      reminder: 'Te recuerdo que tu proceso sigue activo. Si deseas continuar, comparte la información faltante o tu Hoja de vida (HV).'
    };

    let body;
    if (action === 'free_text') {
      if (!customBody) return res.redirect(`/admin/candidates/${id}?outboundError=El mensaje no puede estar vacío.`);
      body = customBody;
    } else if (action === 'request_missing_data') {
      body = buildMissingDataRequestMessage(candidate);
      if (!body) {
        return res.redirect(`/admin/candidates/${id}?outboundError=` + encodeURIComponent('Este candidato no tiene datos pendientes por solicitar.'));
      }
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
    if (!await ensureCandidateIdAccess(prisma, req, id, res, returnTo)) return;

    const window = await getOutboundWindowStatus(prisma, id);
    if (!window.isOpen) {
      return res.redirect(withFlashMessage(returnTo, 'error', 'La ventana de 24h de WhatsApp está vencida. No se puede solicitar la HV.'));
    }

    const body = 'Para continuar tu proceso necesito tu Hoja de vida (HV) en PDF o Word (.doc/.docx).';

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
  router.get('/users', async (req, res) => {
    if (!ensureRecruiterUserManagementAccess(req, res)) return;
    const accessContext = getRequestAccessContext(req);
    const [users, vacancies] = await Promise.all([
      prisma.appUser.findMany({
        where: buildManageableUsersWhere(accessContext),
        orderBy: [{ createdAt: 'desc' }, { username: 'asc' }],
        include: {
          scopeVacancy: {
            select: {
              id: true,
              title: true,
              city: true
            }
          }
        }
      }),
      prisma.vacancy.findMany({
        where: buildVacancyAccessWhere(accessContext),
        orderBy: [{ city: 'asc' }, { title: 'asc' }],
        select: {
          id: true,
          title: true,
          role: true,
          city: true
        }
      })
    ]);

    const manageableScopeOptions = getManageableScopeOptions(req, vacancies);
    res.render('users', {
      role: req.userRole,
      canManageUsers: canManageRecruiterUsers(req),
      users,
      vacancies,
      manageableScopeOptions,
      describeUserScope,
      successMsg: normalizeString(req.query.success),
      errorMsg: normalizeString(req.query.error),
      revealedRecoveryCode: normalizeString(req.query.recoveryCode),
      highlightedUsername: normalizeString(req.query.username),
      currentUsername: req.username || '',
      currentUserId: req.userId || ''
    });
  });

  router.post('/users/create', express.urlencoded({ extended: true }), async (req, res) => {
    if (!ensureRecruiterUserManagementAccess(req, res)) return;
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (password.length < 6) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('La contrasena inicial debe tener al menos 6 caracteres.'));
    }

    const scopeResolution = await resolveRequestedUserScope(prisma, req, req.body);
    if (scopeResolution.error) {
      return res.redirect('/admin/users?error=' + encodeURIComponent(scopeResolution.error));
    }

    const username = await buildUniqueRecruiterUsername(prisma, {
      accessScope: scopeResolution.accessScope,
      scopeCity: scopeResolution.scopeCity,
      vacancyTitle: scopeResolution.scopeVacancy?.title
    });
    const passwordHash = await bcrypt.hash(password, 10);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await bcrypt.hash(recoveryCode, 10);

    await prisma.appUser.create({
      data: {
        username,
        passwordHash,
        recoveryCodeHash,
        role: 'ADMIN',
        accessScope: scopeResolution.accessScope,
        scopeCity: scopeResolution.scopeCity,
        scopeVacancyId: scopeResolution.scopeVacancyId,
        recoveryPhone: normalizeString(req.body.recoveryPhone),
        recoveryEmail: normalizeString(req.body.recoveryEmail),
        createdByUsername: req.username || req.userRole || 'system',
        lastPasswordResetAt: new Date(),
        isActive: true
      }
    });

    const params = new URLSearchParams();
    params.set('success', `Usuario ${username} creado correctamente.`);
    params.set('username', username);
    params.set('recoveryCode', recoveryCode);
    return res.redirect(`/admin/users?${params.toString()}`);
  });

  router.post('/users/:id/reset-password', express.urlencoded({ extended: true }), async (req, res) => {
    if (!ensureRecruiterUserManagementAccess(req, res)) return;
    const { id } = req.params;
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    if (newPassword.length < 6) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('La nueva contrasena debe tener al menos 6 caracteres.'));
    }

    const accessContext = getRequestAccessContext(req);
    const user = await prisma.appUser.findUnique({
      where: { id },
      include: {
        scopeVacancy: {
          select: {
            id: true,
            title: true,
            city: true
          }
        }
      }
    });
    if (!user) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Usuario no encontrado.'));
    }
    if (user.role !== 'ADMIN') {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Solo puedes administrar usuarios reclutadores.'));
    }

    const userIsManageable = accessContext.isDev || accessContext.scope === 'ALL'
      ? true
      : (accessContext.scope === 'CITY'
        ? (user.accessScope === 'CITY' && user.scopeCity === accessContext.city)
          || (user.accessScope === 'VACANCY' && user.scopeVacancy?.city === accessContext.city)
        : user.accessScope === 'VACANCY' && user.scopeVacancyId === accessContext.vacancyId);
    if (!userIsManageable) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('No puedes resetear la contrasena de ese usuario.'));
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.appUser.update({
      where: { id: user.id },
      data: {
        passwordHash,
        lastPasswordResetAt: new Date()
      }
    });

    return res.redirect('/admin/users?success=' + encodeURIComponent(`Contrasena actualizada para ${user.username}.`) + '&username=' + encodeURIComponent(user.username));
  });

  router.post('/users/:id/reset-recovery-code', express.urlencoded({ extended: true }), async (req, res) => {
    if (!ensureRecruiterUserManagementAccess(req, res)) return;
    const { id } = req.params;
    const accessContext = getRequestAccessContext(req);
    const user = await prisma.appUser.findUnique({
      where: { id },
      include: {
        scopeVacancy: {
          select: {
            id: true,
            title: true,
            city: true
          }
        }
      }
    });
    if (!user) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Usuario no encontrado.'));
    }
    if (user.role !== 'ADMIN') {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Solo puedes administrar usuarios reclutadores.'));
    }

    const userIsManageable = accessContext.isDev || accessContext.scope === 'ALL'
      ? true
      : (accessContext.scope === 'CITY'
        ? (user.accessScope === 'CITY' && user.scopeCity === accessContext.city)
          || (user.accessScope === 'VACANCY' && user.scopeVacancy?.city === accessContext.city)
        : user.accessScope === 'VACANCY' && user.scopeVacancyId === accessContext.vacancyId);
    if (!userIsManageable) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('No puedes regenerar el codigo de ese usuario.'));
    }

    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await bcrypt.hash(recoveryCode, 10);
    await prisma.appUser.update({
      where: { id: user.id },
      data: { recoveryCodeHash }
    });

    const params = new URLSearchParams();
    params.set('success', `Codigo de recuperacion regenerado para ${user.username}.`);
    params.set('username', user.username);
    params.set('recoveryCode', recoveryCode);
    return res.redirect(`/admin/users?${params.toString()}`);
  });

  router.post('/users/:id/toggle', express.urlencoded({ extended: true }), async (req, res) => {
    if (!ensureRecruiterUserManagementAccess(req, res)) return;
    const { id } = req.params;
    const accessContext = getRequestAccessContext(req);
    const user = await prisma.appUser.findUnique({
      where: { id },
      include: {
        scopeVacancy: {
          select: {
            id: true,
            title: true,
            city: true
          }
        }
      }
    });
    if (!user) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Usuario no encontrado.'));
    }
    if (user.role !== 'ADMIN') {
      return res.redirect('/admin/users?error=' + encodeURIComponent('Solo puedes administrar usuarios reclutadores.'));
    }

    const userIsManageable = accessContext.isDev || accessContext.scope === 'ALL'
      ? true
      : (accessContext.scope === 'CITY'
        ? (user.accessScope === 'CITY' && user.scopeCity === accessContext.city)
          || (user.accessScope === 'VACANCY' && user.scopeVacancy?.city === accessContext.city)
        : user.accessScope === 'VACANCY' && user.scopeVacancyId === accessContext.vacancyId);
    if (!userIsManageable) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('No puedes actualizar ese usuario.'));
    }
    if (req.userId && req.userId === user.id) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('No puedes desactivar tu propio usuario desde esta sesion.'));
    }

    await prisma.appUser.update({
      where: { id: user.id },
      data: { isActive: !user.isActive }
    });

    return res.redirect('/admin/users?success=' + encodeURIComponent(`Usuario ${user.username} ${user.isActive ? 'desactivado' : 'activado'} correctamente.`) + '&username=' + encodeURIComponent(user.username));
  });

  router.get('/vacancies', async (req, res) => {
    const accessContext = getRequestAccessContext(req);
    const [vacancies, operations, pendingCvMigrationCount] = await Promise.all([
      prisma.vacancy.findMany({
        where: buildVacancyAccessWhere(accessContext),
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
      loadOperations(prisma, {
        allowedCities: accessContext.scope === 'CITY'
          ? [accessContext.city]
          : []
      }),
      req.userRole === 'dev' ? loadPendingCvMigrationCount(prisma) : 0
    ]);
    const successMsg = normalizeString(req.query.success);
    const errorMsg   = normalizeString(req.query.error);
    res.render('vacancies', {
      vacancies,
      operations,
      role: req.userRole,
      canManageUsers: canManageRecruiterUsers(req),
      successMsg,
      errorMsg,
      pendingCvMigrationCount,
      storageConfigured: isStorageConfigured(),
      accessScope: accessContext.scope,
      accessCity: accessContext.city,
      canCreateVacancies: accessContext.isDev || accessContext.scope !== 'VACANCY'
    });
  });

  router.post('/storage/migrate-cvs', ensureDevRole, async (_req, res) => {
    try {
      if (!isStorageConfigured()) {
        return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Configura R2 antes de migrar las hojas de vida fuera de PostgreSQL.'));
      }
      const result = await migrateCandidateCvBatch(prisma, 20);
      if (!result.found) {
        return res.redirect('/admin/vacancies?success=' + encodeURIComponent('No hay hojas de vida pendientes por migrar.'));
      }
      if (result.interrupted) {
        return res.redirect('/admin/vacancies?error=' + encodeURIComponent(`La base de datos se estaba reiniciando. Se migraron ${result.migrated} hoja(s) de vida antes de pausar el proceso. Espera un minuto y vuelve a intentarlo.`));
      }

      const suffix = result.failed ? ` ${result.failed} fallaron.` : '';
      return res.redirect('/admin/vacancies?success=' + encodeURIComponent(`Migración ejecutada. ${result.migrated} hoja(s) de vida migradas.${suffix}`));
    } catch (error) {
      console.error('[CV_STORAGE_MIGRATION_ROUTE_FAILED]', error);
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('No fue posible migrar las hojas de vida en este momento.'));
    }
  });

  router.post('/vacancies/create', express.urlencoded({ extended: true }), async (req, res) => {
    const accessContext = getRequestAccessContext(req);
    if (!accessContext.isDev && accessContext.scope === 'VACANCY') {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Ese perfil solo puede administrar su vacante asignada.'));
    }
    const data = parseVacancyBody(req.body);
    const operation = await loadOperation(prisma, data.operationId);
    const requestedCityAccess = operation ? canAccessVacancy(accessContext, { city: operation.city.name }) : false;
    if (!data.title || !operation) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Título y operación son obligatorios.'));
    }
    if (!requestedCityAccess) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('No tienes acceso para crear vacantes en esa ciudad.'));
    }
    if (!hasValidInterviewConfig(data)) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Debes configurar al menos un día y una hora de entrevista válida.'));
    }
    if (!hasValidExperienceConfig(data)) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Si la experiencia es requerida, debes diligenciar el tiempo de experiencia requerido.'));
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
          operationAddress: data.operationAddress || '',
          interviewAddress: data.interviewAddress,
          requiredDocuments: data.requiredDocuments,
          minAge: data.minAge,
          maxAge: data.maxAge,
          experienceRequired: data.experienceRequired,
          experienceTimeText: data.experienceTimeText,
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
    const currentVacancy = await ensureVacancyIdAccess(prisma, req, id, res, '/admin/vacancies');
    if (!currentVacancy) return;
    const accessContext = getRequestAccessContext(req);
    const data = parseVacancyBody(req.body);
    const operation = await loadOperation(prisma, data.operationId);
    const canMoveToRequestedCity = operation ? canAccessVacancy(accessContext, { city: operation.city.name }) : false;
    if (!data.title || !operation) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Título y operación son obligatorios.'));
    }
    if (!hasValidInterviewConfig(data)) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Debes configurar al menos un día y una hora de entrevista válida.'));
    }
    if (!hasValidExperienceConfig(data)) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('Si la experiencia es requerida, debes diligenciar el tiempo de experiencia requerido.'));
    }
    const city = operation.city.name;
    if (!canMoveToRequestedCity) {
      return res.redirect('/admin/vacancies?error=' + encodeURIComponent('No tienes acceso para mover esta vacante a esa ciudad.'));
    }
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
          operationAddress: data.operationAddress || '',
          interviewAddress: data.interviewAddress,
          requiredDocuments: data.requiredDocuments,
          minAge: data.minAge,
          maxAge: data.maxAge,
          experienceRequired: data.experienceRequired,
          experienceTimeText: data.experienceTimeText,
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
    const vacancy = await ensureVacancyIdAccess(prisma, req, id, res, '/admin/vacancies');
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
    const vacancy = await ensureVacancyIdAccess(prisma, req, id, res, '/admin/vacancies');
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
