import { normalizeBogotaLocalidad, normalizeComparableText } from './geographyNormalization.js';

const SIBERIA_NEAR_MUNICIPALITIES = new Set(['funza', 'mosquera', 'madrid']);
const SIBERIA_NEAR_BOGOTA_LOCALITIES = new Set(['Fontibón', 'Engativá']);
const SIBERIA_FAR_BOGOTA_LOCALITIES = new Set(['Bosa', 'Kennedy', 'Ciudad Bolívar', 'Usme', 'Tunjuelito', 'Rafael Uribe Uribe', 'San Cristóbal']);
const ADVISORY_SIGNATURE = 'traslado hacia Siberia puede ser exigente';

function vacancyLocationText(vacancy = null) {
  return [
    vacancy?.title,
    vacancy?.role,
    vacancy?.city,
    vacancy?.operationAddress,
    vacancy?.address,
    vacancy?.location,
    vacancy?.operation?.name,
    vacancy?.operation?.city?.name
  ].filter(Boolean).join(' ');
}

function isSiberiaVacancy(vacancy = null) {
  return normalizeComparableText(vacancyLocationText(vacancy)).includes('siberia');
}

function normalizedResidenceParts(candidate = {}) {
  const raw = [candidate?.locality, candidate?.neighborhood, candidate?.zone, candidate?.city, candidate?.residenceCity]
    .filter(Boolean)
    .join(' ');
  const normalized = normalizeComparableText(raw);
  const bogotaLocality = normalizeBogotaLocalidad(raw);
  return { raw, normalized, bogotaLocality };
}

function alreadyWarned(recentMessages = []) {
  return (recentMessages || []).some((message) => {
    if (message?.direction && message.direction !== 'OUTBOUND') return false;
    return String(message?.body || '').includes(ADVISORY_SIGNATURE);
  });
}

export function evaluateCommuteAdvisory({ candidate = {}, vacancy = null, recentMessages = [] } = {}) {
  if (!isSiberiaVacancy(vacancy) || alreadyWarned(recentMessages)) {
    return { shouldWarn: false, code: null, message: null };
  }

  const residence = normalizedResidenceParts(candidate);
  if (!residence.normalized) return { shouldWarn: false, code: null, message: null };

  if (SIBERIA_NEAR_MUNICIPALITIES.has(residence.normalized) || SIBERIA_NEAR_BOGOTA_LOCALITIES.has(residence.bogotaLocality)) {
    return { shouldWarn: false, code: 'near_siberia', message: null };
  }

  const farMunicipality = residence.normalized.includes('soacha');
  const farBogota = SIBERIA_FAR_BOGOTA_LOCALITIES.has(residence.bogotaLocality);
  if (!farMunicipality && !farBogota) return { shouldWarn: false, code: null, message: null };

  return {
    shouldWarn: true,
    code: farMunicipality ? 'far_municipality' : 'far_bogota_locality',
    message: 'Te aviso con cuidado: el traslado hacia Siberia puede ser exigente desde tu zona. No te descarto por eso; si para ti es viable continuar, seguimos con el proceso.'
  };
}

export function applyCommuteAdvisoryToReply(reply = '', context = {}) {
  const advisory = evaluateCommuteAdvisory(context);
  if (!advisory.shouldWarn) return String(reply || '');
  const base = String(reply || '').trim();
  return base ? `${advisory.message}\n\n${base}` : advisory.message;
}

export const __commuteAdvisoryPolicyInternals = { isSiberiaVacancy, normalizedResidenceParts, ADVISORY_SIGNATURE };
