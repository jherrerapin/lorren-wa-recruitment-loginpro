import {
  alignCandidateLocationFields,
  normalizeCandidateFields,
  parseNaturalData
} from './candidateData.js';
import { sanitizeCandidateFieldsForConversation } from './fieldSanitizer.js';
import { getCandidateReadiness } from './readinessGuard.js';

const CONSENT_PREFIX_TOKEN = String.raw`(?:si|sí|sii|sip|claro|correcto|de\s+acuerdo|dale|ok|listo)`;
const CONSENT_PREFIXES = String.raw`(?:${CONSENT_PREFIX_TOKEN}[\s,;:-]*)*`;
const CONSENT_DECLARATION_PREFIXES = [
  new RegExp(`^${CONSENT_PREFIXES}(?:autorizo|acepto|consiento)(?:\\s+(?:el\\s+)?tratamiento(?:\\s+de)?(?:\\s+mis|\\s+los)?\\s+datos?)?`, 'i'),
  new RegExp(`^${CONSENT_PREFIXES}(?:estoy\\s+de\\s+acuerdo|doy\\s+mi\\s+consentimiento|doy\\s+consentimiento|doy\\s+permiso|tienen\\s+mi\\s+permiso)`, 'i'),
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

function extractCuratedProfileFields(text = '', vacancy = null, candidate = {}) {
  const parsed = parseNaturalData(text);
  let normalized = normalizeCandidateFields(parsed);
  normalized = alignCandidateLocationFields(normalized, vacancy, { clearAlternate: false });
  const readiness = getCandidateReadiness(candidate, vacancy, { requireCv: false });

  const evidence = Object.fromEntries(
    Object.keys(normalized).map((field) => [
      field,
      {
        snippet: String(text || '').slice(0, 180),
        confidence: 1,
        source: 'local_parser'
      }
    ])
  );

  return sanitizeCandidateFieldsForConversation({
    fields: normalized,
    evidence,
    text,
    context: {
      currentStep: candidate?.currentStep || null,
      pendingFields: readiness.missingFields
    },
    turnType: null
  }).fields;
}

export async function captureConsentedProfileData({
  prisma,
  candidate,
  vacancy = null,
  currentText = ''
} = {}) {
  if (!candidate?.id) {
    return { candidate, capturedFields: [], reason: 'candidate_not_ready' };
  }

  // Esta es la última frontera antes de persistir campos protegidos. El gate
  // puede interpretar el turno, pero nunca es la única protección de escritura.
  if (candidate?.dataConsentStatus !== 'ACCEPTED') {
    return { candidate, capturedFields: [], reason: 'consent_not_accepted' };
  }

  const consentMessageText = String(currentText || '').trim();
  if (!consentMessageText) {
    return { candidate, capturedFields: [], reason: 'no_consented_message_data' };
  }

  // La declaración de consentimiento se retira antes de comprender el perfil.
  // El resto del mensaje pasa por la misma compuerta semántica que cualquier
  // otro turno; este flujo no mantiene una autoridad paralela de entidades.
  const profileText = stripConsentDeclaration(consentMessageText);
  if (!profileText) {
    return { candidate, capturedFields: [], reason: 'no_new_profile_data' };
  }

  const extracted = extractCuratedProfileFields(profileText, vacancy, candidate);
  const update = {};
  for (const [field, value] of Object.entries(extracted)) {
    if (!hasValue(candidate[field])) update[field] = value;
  }

  if (!Object.keys(update).length) {
    return { candidate, capturedFields: [], reason: 'no_new_profile_data' };
  }

  if (typeof prisma?.candidate?.updateMany !== 'function'
    || typeof prisma?.candidate?.findUnique !== 'function') {
    return { candidate, capturedFields: [], reason: 'candidate_not_ready' };
  }

  const writeResult = await prisma.candidate.updateMany({
    where: {
      id: candidate.id,
      dataConsentStatus: 'ACCEPTED'
    },
    data: update
  });
  const canonicalCandidate = await prisma.candidate.findUnique({
    where: { id: candidate.id }
  });

  if (writeResult.count !== 1) {
    return {
      candidate: canonicalCandidate || candidate,
      capturedFields: [],
      reason: 'consent_changed_before_write'
    };
  }

  return {
    candidate: canonicalCandidate || { ...candidate, ...update },
    capturedFields: Object.keys(update),
    reason: 'profile_data_captured_from_consent_message'
  };
}
