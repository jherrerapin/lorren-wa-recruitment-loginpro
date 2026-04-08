import { getCandidateResidenceValue } from './candidateData.js';

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalizePhoneDigits(phone = '') {
  return String(phone || '').replace(/\D/g, '');
}

function timeValue(value) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function candidateLastMessageTime(candidate = {}) {
  return Math.max(
    timeValue(candidate?.lastInboundAt),
    timeValue(candidate?.lastOutboundAt),
    timeValue(candidate?.createdAt)
  );
}

export function candidateLastMessageDirection(candidate = {}) {
  const inboundTime = timeValue(candidate?.lastInboundAt);
  const outboundTime = timeValue(candidate?.lastOutboundAt);
  if (inboundTime === 0 && outboundTime === 0) return null;
  return inboundTime >= outboundTime ? 'INBOUND' : 'OUTBOUND';
}

export function candidateHasCv(candidate = {}) {
  return Boolean(candidate.cvData)
    || hasValue(candidate.cvOriginalName)
    || hasValue(candidate.cvMimeType);
}

export function buildWhatsAppLink(phone = '') {
  const digits = normalizePhoneDigits(phone);
  return digits ? `https://wa.me/${digits}` : '';
}

export function buildAdminOpenWhatsAppPath(candidateId = '') {
  return candidateId ? `/admin/candidates/${candidateId}/open-whatsapp` : '/admin';
}

export function candidateHasUnreadInbound(candidate = {}) {
  const inboundTime = timeValue(candidate?.lastInboundAt);
  if (!inboundTime) return false;
  const reviewedTime = Math.max(
    timeValue(candidate?.devLastSeenAt),
    timeValue(candidate?.lastOutboundAt)
  );
  if (!reviewedTime) return true;
  return inboundTime > reviewedTime;
}

export function compareCandidatesByRecentInbound(a = {}, b = {}) {
  const aLastMessage = candidateLastMessageTime(a);
  const bLastMessage = candidateLastMessageTime(b);
  if (aLastMessage !== bLastMessage) return bLastMessage - aLastMessage;

  const aUnread = candidateHasUnreadInbound(a) ? 1 : 0;
  const bUnread = candidateHasUnreadInbound(b) ? 1 : 0;
  if (aUnread !== bUnread) return bUnread - aUnread;

  const aCreated = timeValue(a?.createdAt);
  const bCreated = timeValue(b?.createdAt);
  return bCreated - aCreated;
}

export function normalizeCandidateStatusForUI(status) {
  if (status === 'VALIDANDO') return 'REGISTRADO';
  return status;
}

export function deriveCandidateStatusForUI(candidate = {}) {
  const normalizedStatus = normalizeCandidateStatusForUI(candidate?.status);
  if (['APROBADO', 'CONTACTADO', 'RECHAZADO'].includes(normalizedStatus)) return normalizedStatus;
  if (isOperationallyRegistered({ ...candidate, status: 'REGISTRADO' })) return 'REGISTRADO';
  return 'NUEVO';
}

export function isOperationallyRegistered(candidate) {
  const uiStatus = normalizeCandidateStatusForUI(candidate.status);
  return hasValue(candidate.fullName)
    && hasValue(candidate.documentType)
    && hasValue(candidate.documentNumber)
    && candidate.age !== null
    && candidate.age !== undefined
    && hasValue(getCandidateResidenceValue(candidate))
    && hasValue(candidate.medicalRestrictions)
    && hasValue(candidate.transportMode)
    && candidateHasCv(candidate)
    && uiStatus !== 'RECHAZADO'
    && uiStatus !== 'CONTACTADO';
}

export function isOperationallyCompleteWithoutCv(candidate) {
  const uiStatus = normalizeCandidateStatusForUI(candidate.status);
  return hasValue(candidate.fullName)
    && hasValue(candidate.documentType)
    && hasValue(candidate.documentNumber)
    && candidate.age !== null
    && candidate.age !== undefined
    && hasValue(getCandidateResidenceValue(candidate))
    && hasValue(candidate.medicalRestrictions)
    && hasValue(candidate.transportMode)
    && !candidateHasCv(candidate)
    && uiStatus !== 'RECHAZADO';
}

export function filterCandidatesByScope(candidates, scope = 'all') {
  if (scope === 'inbox') return candidates.filter((c) => Boolean(c?.lastInboundAt));
  if (scope === 'approved') return candidates.filter((c) => c?.status === 'APROBADO');
  if (scope === 'registered') return candidates.filter((c) => isOperationallyRegistered(c));
  if (scope === 'missing_cv_complete') return candidates.filter((c) => isOperationallyCompleteWithoutCv(c));
  if (scope === 'new') return candidates.filter((c) => normalizeCandidateStatusForUI(c.status) === 'NUEVO');
  if (scope === 'contacted') return candidates.filter((c) => normalizeCandidateStatusForUI(c.status) === 'CONTACTADO');
  if (scope === 'rejected') return candidates.filter((c) => normalizeCandidateStatusForUI(c.status) === 'RECHAZADO');
  return candidates;
}

export function formatDateForFilenameCO(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  return formatter.format(date);
}

export function exportFilenameByScope(scope = 'all') {
  const safeScope = ['all', 'registered', 'missing_cv_complete', 'approved', 'new', 'contacted', 'rejected'].includes(scope)
    ? scope
    : 'all';
  const scopeLabelByKey = {
    registered: 'registrados',
    missing_cv_complete: 'pendientes_hv',
    approved: 'aprobados',
    new: 'nuevos',
    contacted: 'contactados',
    rejected: 'rechazados',
    all: 'todos'
  };
  const today = formatDateForFilenameCO();
  return `candidatos_${scopeLabelByKey[safeScope]}_${today}.xlsx`;
}
