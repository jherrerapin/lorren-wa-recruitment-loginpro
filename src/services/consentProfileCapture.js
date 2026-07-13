import {
  alignCandidateLocationFields,
  isHighConfidenceLocalField,
  normalizeCandidateFields,
  parseNaturalData
} from './candidateData.js';

const CAPTURABLE_FIELDS = new Set([
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'gender',
  'neighborhood',
  'locality',
  'medicalRestrictions',
  'transportMode',
  'experienceInfo',
  'experienceTime',
  'experienceSummary'
]);

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function extractHighConfidenceFields(text = '', vacancy = null) {
  const parsed = parseNaturalData(text);
  let normalized = normalizeCandidateFields(parsed);
  normalized = alignCandidateLocationFields(normalized, vacancy, { clearAlternate: false });

  const fields = {};
  for (const [field, value] of Object.entries(normalized)) {
    if (!CAPTURABLE_FIELDS.has(field) || !hasValue(value)) continue;
    if (!isHighConfidenceLocalField(field, value)) continue;
    fields[field] = value;
  }
  return fields;
}

export async function captureConsentedProfileData({
  prisma,
  candidate,
  vacancy = null,
  currentText = ''
} = {}) {
  if (!prisma?.candidate?.update || !candidate?.id) {
    return { candidate, capturedFields: [], reason: 'candidate_not_ready' };
  }

  const consentMessageText = String(currentText || '').trim();
  if (!consentMessageText) {
    return { candidate, capturedFields: [], reason: 'no_consented_message_data' };
  }

  // Solo se procesa el mismo mensaje en el que quedó registrada la autorización.
  // El historial anterior no se relee porque fue recibido antes del consentimiento.
  const extracted = extractHighConfidenceFields(consentMessageText, vacancy);
  const update = {};
  for (const [field, value] of Object.entries(extracted)) {
    if (!hasValue(candidate[field])) update[field] = value;
  }

  if (!Object.keys(update).length) {
    return { candidate, capturedFields: [], reason: 'no_new_profile_data' };
  }

  const updatedCandidate = await prisma.candidate.update({
    where: { id: candidate.id },
    data: update
  });

  return {
    candidate: updatedCandidate,
    capturedFields: Object.keys(update),
    reason: 'profile_data_captured_from_consent_message'
  };
}
