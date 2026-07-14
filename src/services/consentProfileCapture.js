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

const CONSENT_DECLARATION_PREFIXES = [
  /^(?:si|sí|sii|sip|claro|correcto|de acuerdo|dale|ok|listo)?[\s,;:-]*(?:autorizo|acepto|consiento)(?:\s+(?:el\s+)?tratamiento(?:\s+de)?(?:\s+mis|\s+los)?\s+datos?)?/i,
  /^(?:si|sí|sii|sip|claro|correcto|de acuerdo|dale|ok|listo)?[\s,;:-]*(?:estoy\s+de\s+acuerdo|doy\s+mi\s+consentimiento|doy\s+consentimiento|doy\s+permiso|tienen\s+mi\s+permiso)/i,
  /^(?:pueden|puede)\s+(?:usar|tratar|manejar|procesar|guardar)\s+(?:mis|los)\s+datos/i,
  /^(?:pueden|puede)\s+continuar\s+con\s+(?:mis|los)\s+datos/i
];

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function stripConsentDeclaration(text = '') {
  let remaining = String(text || '').trim();
  for (const pattern of CONSENT_DECLARATION_PREFIXES) {
    if (!pattern.test(remaining)) continue;
    remaining = remaining.replace(pattern, '').replace(/^[\s,.;:-]+/, '').trim();
    break;
  }
  return remaining;
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

  // Solo se procesa la parte de datos del mismo mensaje en que se registró la autorización.
  // Se retira la declaración de consentimiento para que expresiones como "sí autorizo"
  // no sean interpretadas erróneamente como nombre u otro dato del candidato.
  const profileText = stripConsentDeclaration(consentMessageText);
  if (!profileText) {
    return { candidate, capturedFields: [], reason: 'no_new_profile_data' };
  }

  const extracted = extractHighConfidenceFields(profileText, vacancy);
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
