function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

export function normalizeCandidateStatusForUI(status) {
  if (status === 'VALIDANDO' || status === 'APROBADO') return 'REGISTRADO';
  return status;
}

export function isOperationallyRegistered(candidate) {
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
    && Boolean(candidate.cvData)
    && candidate.status !== 'RECHAZADO';
}

export function filterCandidatesByScope(candidates, scope = 'all') {
  if (scope === 'registered') return candidates.filter((c) => isOperationallyRegistered(c));
  if (scope === 'new') return candidates.filter((c) => normalizeCandidateStatusForUI(c.status) === 'NUEVO');
  if (scope === 'contacted') return candidates.filter((c) => normalizeCandidateStatusForUI(c.status) === 'CONTACTADO');
  if (scope === 'rejected') return candidates.filter((c) => normalizeCandidateStatusForUI(c.status) === 'RECHAZADO');
  return candidates;
}

export function exportFilenameByScope(scope = 'all') {
  const safeScope = ['all', 'registered', 'new', 'contacted', 'rejected'].includes(scope)
    ? scope
    : 'all';
  const today = new Date().toISOString().slice(0, 10);
  return `candidatos_${safeScope}_${today}.xlsx`;
}
