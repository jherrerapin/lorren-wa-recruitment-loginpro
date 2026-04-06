function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalizePhoneDigits(phone = '') {
  return String(phone || '').replace(/\D/g, '');
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
  if (!candidate?.lastInboundAt) return false;
  if (!candidate?.lastOutboundAt) return true;
  return new Date(candidate.lastInboundAt).getTime() > new Date(candidate.lastOutboundAt).getTime();
}

export function compareCandidatesByRecentInbound(a = {}, b = {}) {
  const aUnread = candidateHasUnreadInbound(a) ? 1 : 0;
  const bUnread = candidateHasUnreadInbound(b) ? 1 : 0;
  if (aUnread !== bUnread) return bUnread - aUnread;

  const aInbound = a?.lastInboundAt ? new Date(a.lastInboundAt).getTime() : 0;
  const bInbound = b?.lastInboundAt ? new Date(b.lastInboundAt).getTime() : 0;
  if (aInbound !== bInbound) return bInbound - aInbound;

  const aCreated = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bCreated = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
  return bCreated - aCreated;
}

export function normalizeCandidateStatusForUI(status) {
  if (status === 'VALIDANDO' || status === 'APROBADO') return 'REGISTRADO';
  return status;
}

export function isOperationallyRegistered(candidate) {
  const uiStatus = normalizeCandidateStatusForUI(candidate.status);
  return hasValue(candidate.fullName)
    && hasValue(candidate.documentType)
    && hasValue(candidate.documentNumber)
    && candidate.age !== null
    && candidate.age !== undefined
    && hasValue(candidate.neighborhood)
    && hasValue(candidate.experienceInfo)
    && hasValue(candidate.experienceTime)
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
    && hasValue(candidate.neighborhood)
    && hasValue(candidate.experienceInfo)
    && hasValue(candidate.experienceTime)
    && hasValue(candidate.medicalRestrictions)
    && hasValue(candidate.transportMode)
    && !candidateHasCv(candidate)
    && uiStatus !== 'RECHAZADO';
}

export function filterCandidatesByScope(candidates, scope = 'all') {
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
  const safeScope = ['all', 'registered', 'missing_cv_complete', 'new', 'contacted', 'rejected'].includes(scope)
    ? scope
    : 'all';
  const scopeLabelByKey = {
    registered: 'registrados',
    missing_cv_complete: 'pendientes_hv',
    new: 'nuevos',
    contacted: 'contactados',
    rejected: 'rechazados',
    all: 'todos'
  };
  const today = formatDateForFilenameCO();
  return `candidatos_${scopeLabelByKey[safeScope]}_${today}.xlsx`;
}
