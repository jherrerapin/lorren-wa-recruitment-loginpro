import { normalizeLocationText, resolveLocationEntity, LocationEntityType } from './locationResolver.js';
import { classifyTransportKind, TransportKind } from './transportClassifier.js';

export const OperationalMatchAction = Object.freeze({
  NEED_CITY: 'NEED_CITY',
  NEED_BOGOTA_LOCALITY: 'NEED_BOGOTA_LOCALITY',
  NEED_NEIGHBORHOOD: 'NEED_NEIGHBORHOOD',
  NEED_SIBERIA_TRANSPORT: 'NEED_SIBERIA_TRANSPORT',
  ASSIGN_ACTIVE: 'ASSIGN_ACTIVE',
  ASSIGN_INACTIVE_REGISTER_ONLY: 'ASSIGN_INACTIVE_REGISTER_ONLY',
  OFFER_ACTIVE_ALTERNATIVE: 'OFFER_ACTIVE_ALTERNATIVE',
  NO_MATCH: 'NO_MATCH'
});

function vacancyName(vacancy = {}) {
  return normalizeLocationText([vacancy?.title, vacancy?.role, vacancy?.operation?.name, vacancy?.city].filter(Boolean).join(' '));
}

function isSiberiaVacancy(vacancy = {}) {
  return vacancyName(vacancy).includes('siberia');
}

function isMontevideoVacancy(vacancy = {}) {
  return vacancyName(vacancy).includes('montevideo');
}

function isOpenVacancy(vacancy = {}) {
  return Boolean(vacancy?.isActive && vacancy?.acceptingApplications);
}

function scoreVacancyForResidence(vacancy = {}, entity = {}, adHintVacancyId = null) {
  let score = 0;
  if (adHintVacancyId && vacancy.id === adHintVacancyId) score += 1;

  if (entity.type === LocationEntityType.BOGOTA_LOCALITY) {
    if (isMontevideoVacancy(vacancy)) score += 2;
    if (isSiberiaVacancy(vacancy)) score += 1;
  }

  if (entity.type === LocationEntityType.BOGOTA_AREA_MUNICIPALITY) {
    if (isSiberiaVacancy(vacancy)) score += 2;
    if (isMontevideoVacancy(vacancy)) score += 1;
  }

  if (entity.type === LocationEntityType.OTHER_CITY_OR_PLACE) {
    const cityText = normalizeLocationText(vacancy?.operation?.city?.name || vacancy?.city || '');
    if (cityText && entity.normalized && cityText === entity.normalized) score += 2;
  }

  return score;
}

function rankVacancies(vacancies = [], entity = {}, adHintVacancyId = null) {
  return [...(vacancies || [])]
    .map((vacancy) => ({ vacancy, score: scoreVacancyForResidence(vacancy, entity, adHintVacancyId) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

function findOpenAlternative(ranked = [], selectedVacancy = null) {
  return ranked.find((entry) => entry.vacancy.id !== selectedVacancy?.id && isOpenVacancy(entry.vacancy))?.vacancy || null;
}

export function evaluateOperationalVacancyMatch({
  residenceText = '',
  transportMode = null,
  vacancies = [],
  adHintVacancyId = null
} = {}) {
  const entity = resolveLocationEntity(residenceText);
  if (entity.type === LocationEntityType.UNKNOWN) return { action: OperationalMatchAction.NEED_CITY, entity };
  if (entity.type === LocationEntityType.BOGOTA_CITY) return { action: OperationalMatchAction.NEED_BOGOTA_LOCALITY, entity };

  const ranked = rankVacancies(vacancies, entity, adHintVacancyId);
  if (!ranked.length) {
    if (entity.type === LocationEntityType.OTHER_CITY_OR_PLACE) return { action: OperationalMatchAction.NEED_NEIGHBORHOOD, entity };
    return { action: OperationalMatchAction.NO_MATCH, entity };
  }

  const best = ranked[0].vacancy;
  const transport = classifyTransportKind(transportMode);
  if (isSiberiaVacancy(best) && transport.kind === TransportKind.UNKNOWN) {
    return { action: OperationalMatchAction.NEED_SIBERIA_TRANSPORT, entity, vacancy: best, transport };
  }

  if (isOpenVacancy(best)) return { action: OperationalMatchAction.ASSIGN_ACTIVE, entity, vacancy: best, transport };

  const activeAlternative = findOpenAlternative(ranked, best);
  if (activeAlternative) {
    return { action: OperationalMatchAction.OFFER_ACTIVE_ALTERNATIVE, entity, vacancy: best, activeAlternative, transport };
  }

  return { action: OperationalMatchAction.ASSIGN_INACTIVE_REGISTER_ONLY, entity, vacancy: best, transport };
}
