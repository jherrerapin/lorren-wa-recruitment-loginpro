import { normalizeResolverText } from './vacancyResolver.js';

export const VacancyConceptAlternativeAction = Object.freeze({
  NONE: 'NONE',
  OFFER_ALTERNATIVE: 'OFFER_ALTERNATIVE',
  ASK_PREQUALIFICATION: 'ASK_PREQUALIFICATION'
});

function vacancyCity(vacancy = {}) {
  return vacancy?.operation?.city?.name || vacancy?.city || null;
}

function sameCity(a = '', b = '') {
  const left = normalizeResolverText(a);
  const right = normalizeResolverText(b);
  return Boolean(left && right && left === right);
}

function titleOf(vacancy = {}) {
  return vacancy?.title || vacancy?.role || 'la vacante disponible';
}

function isOpenVacancy(vacancy = {}) {
  return Boolean(vacancy?.isActive && vacancy?.acceptingApplications);
}

function hasConfiguredExperienceRequirement(vacancy = {}) {
  return String(vacancy?.experienceRequired || '') === 'YES'
    || Number(vacancy?.minExperienceMonths || 0) > 0
    || Boolean(String(vacancy?.experienceTimeText || '').trim());
}

function hasConfiguredEducationOrLeadershipRequirement(vacancy = {}) {
  const text = normalizeResolverText([
    vacancy?.title,
    vacancy?.role,
    vacancy?.roleDescription,
    vacancy?.requirements
  ].filter(Boolean).join(' '));
  return /\b(tecnico|tecnologo|tecnologica|profesional|lider|liderar|supervisor|coordinador|personal a cargo|manejo de personal)\b/.test(text);
}

export function vacancyRequiresPrequalification(vacancy = {}) {
  return hasConfiguredExperienceRequirement(vacancy)
    || hasConfiguredEducationOrLeadershipRequirement(vacancy);
}

function pickAlternativeVacancy(cityVacancies = []) {
  if (!cityVacancies.length) return null;
  return cityVacancies.find((vacancy) => !vacancyRequiresPrequalification(vacancy)) || cityVacancies[0];
}

function roleLabel(roleText = '') {
  const value = String(roleText || '').trim();
  return value ? ` de ${value}` : '';
}

function prequalificationSummary(vacancy = {}) {
  const parts = [];
  const text = normalizeResolverText([
    vacancy?.title,
    vacancy?.role,
    vacancy?.roleDescription,
    vacancy?.requirements
  ].filter(Boolean).join(' '));

  if (hasConfiguredExperienceRequirement(vacancy)) parts.push('experiencia relacionada');
  if (/\b(lider|liderar|supervisor|coordinador|personal a cargo|manejo de personal)\b/.test(text)) parts.push('experiencia liderando o coordinando personal');
  if (/\b(tecnico|tecnologo|tecnologica|profesional)\b/.test(text)) parts.push('formacion tecnica, tecnologica o la formacion indicada');

  return [...new Set(parts)].slice(0, 3);
}

function buildOpenAlternativeReply({ city, requestedRoleText, vacancy }) {
  const location = city ? ` en ${city}` : '';
  return [
    `En este momento no tengo una vacante activa${roleLabel(requestedRoleText)}${location}.`,
    `La opcion activa que tengo${location} es ${titleOf(vacancy)}, que puede ser diferente a la que mencionas.`,
    '¿Te gustaria que revisemos esa opcion o prefieres dejar tu perfil para futuras aperturas compatibles?'
  ].join(' ');
}

function buildPrequalificationReply({ city, requestedRoleText, vacancy }) {
  const location = city ? ` en ${city}` : '';
  const summary = prequalificationSummary(vacancy);
  const requirementText = summary.length
    ? ` y requiere ${summary.join(', ')}`
    : ' y tiene requisitos especificos configurados';
  return [
    `En este momento no tengo una vacante activa${roleLabel(requestedRoleText)}${location}.`,
    `La convocatoria activa que tengo${location} es ${titleOf(vacancy)}${requirementText}.`,
    '¿Cuentas con ese perfil?'
  ].join(' ');
}

export function evaluateVacancyConceptAlternative({ city = null, requestedRoleText = null, activeVacancies = [] } = {}) {
  if (!normalizeResolverText(city) || !normalizeResolverText(requestedRoleText)) {
    return { action: VacancyConceptAlternativeAction.NONE, reason: 'missing_city_or_role' };
  }

  const cityVacancies = (activeVacancies || [])
    .filter(isOpenVacancy)
    .filter((vacancy) => sameCity(vacancyCity(vacancy), city));

  if (!cityVacancies.length) {
    return { action: VacancyConceptAlternativeAction.NONE, reason: 'no_active_vacancies_in_city' };
  }

  const suggestedVacancy = pickAlternativeVacancy(cityVacancies);
  if (!suggestedVacancy) {
    return { action: VacancyConceptAlternativeAction.NONE, reason: 'no_suggested_vacancy' };
  }

  const requiresPrequalification = vacancyRequiresPrequalification(suggestedVacancy);
  return {
    action: requiresPrequalification
      ? VacancyConceptAlternativeAction.ASK_PREQUALIFICATION
      : VacancyConceptAlternativeAction.OFFER_ALTERNATIVE,
    reason: requiresPrequalification ? 'alternative_requires_prequalification' : 'open_alternative_available',
    city,
    requestedRoleText,
    suggestedVacancy,
    suggestedVacancyId: suggestedVacancy.id,
    requiresPrequalification,
    reply: requiresPrequalification
      ? buildPrequalificationReply({ city, requestedRoleText, vacancy: suggestedVacancy })
      : buildOpenAlternativeReply({ city, requestedRoleText, vacancy: suggestedVacancy })
  };
}
