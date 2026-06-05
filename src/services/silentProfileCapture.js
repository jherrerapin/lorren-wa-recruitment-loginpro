const SILENT_PROFILE_CAPTURE_MODES = new Set([
  'future_profile_offer',
  'paused_vacancy',
  'future_profile_capture',
  'paused_vacancy_capture',
  'alternative_vacancy_offer',
  'alternative_vacancy_prequalification'
]);

const MATERIAL_PROFILE_FIELDS = new Set([
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'locality',
  'neighborhood',
  'medicalRestrictions',
  'transportMode',
  'experienceInfo',
  'experienceTime'
]);

export function getBotResumeModeKey(botResumeMode = '') {
  return String(botResumeMode || '').split(':')[0];
}

export function isSilentProfileCaptureMode(botResumeMode = '') {
  return SILENT_PROFILE_CAPTURE_MODES.has(getBotResumeModeKey(botResumeMode));
}

export function hasMaterialProfileData(fields = {}) {
  return Object.entries(fields || {}).some(([field, value]) => (
    MATERIAL_PROFILE_FIELDS.has(field)
    && value !== undefined
    && value !== null
    && String(value).trim() !== ''
  ));
}

export function shouldSilentCaptureProfileData({ candidate = {}, normalizedData = {}, hasDataIntent = false } = {}) {
  if (!candidate) return false;
  if (candidate.vacancyId) return false;
  if (!isSilentProfileCaptureMode(candidate.botResumeMode)) return false;
  if (!hasDataIntent && !hasMaterialProfileData(normalizedData)) return false;
  return hasMaterialProfileData(normalizedData);
}

function getFirstName(candidate = {}) {
  return String(candidate?.fullName || '').trim().split(/\s+/)[0] || '';
}

export function buildSilentProfileCaptureUpdate({ candidate = {}, normalizedData = {} } = {}) {
  const modeKey = getBotResumeModeKey(candidate.botResumeMode);
  const shouldKeepAlternativePending = modeKey === 'alternative_vacancy_offer'
    || modeKey === 'alternative_vacancy_prequalification';

  return {
    ...normalizedData,
    vacancyId: undefined,
    currentStep: 'GREETING_SENT',
    reminderScheduledFor: null,
    reminderState: 'SKIPPED',
    ...(shouldKeepAlternativePending ? { botResumeMode: candidate.botResumeMode } : {})
  };
}

export function buildSilentProfileCaptureReply({ candidate = {}, city = null, requestedRoleText = null } = {}) {
  const firstName = getFirstName(candidate);
  const greeting = firstName ? `Gracias, ${firstName}.` : 'Gracias.';
  const modeKey = getBotResumeModeKey(candidate.botResumeMode);
  const cityText = city ? ` en ${city}` : '';
  const roleText = requestedRoleText ? ` de ${requestedRoleText}` : '';

  if (modeKey === 'alternative_vacancy_offer') {
    return `${greeting} Dejo tus datos registrados. Aún no te asigno a una vacante porque primero necesito que me confirmes si deseas revisar la opción disponible${cityText}.`;
  }

  if (modeKey === 'alternative_vacancy_prequalification') {
    return `${greeting} Dejo tus datos registrados. Para avanzar con la alternativa disponible${cityText}, primero necesito confirmar si cuentas con el perfil requerido.`;
  }

  if (modeKey === 'paused_vacancy' || modeKey === 'paused_vacancy_capture') {
    return `${greeting} Dejo tus datos registrados para futuras aperturas compatibles. En este momento esa vacante no está activa para recibir postulaciones.`;
  }

  return `${greeting} Dejo tus datos registrados para futuras aperturas compatibles${roleText}${cityText}. En este momento no hay una vacante activa asociada ni entrevista por agendar.`;
}
