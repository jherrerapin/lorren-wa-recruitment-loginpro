const CHANGE_VACANCY_INTENT = 'CHANGE_VACANCY';

const ROLE_STOPWORDS = new Set([
  'vacante',
  'cargo',
  'trabajo',
  'operacion',
  'operaciones',
  'para',
  'como',
  'esta',
  'este',
  'otra',
  'otro'
]);

function normalize(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function intentOf(input = {}) {
  return String(input?.interpretation?.intent || '').trim().toUpperCase();
}

function candidateFacts(input = {}) {
  const facts = input?.candidate?.facts;
  return facts && typeof facts === 'object' && !Array.isArray(facts)
    ? facts
    : {};
}

function vacancyCity(vacancy = {}) {
  return vacancy?.operation?.city?.name || vacancy?.city || '';
}

function vacancyRole(vacancy = {}) {
  return vacancy?.role || vacancy?.title || '';
}

function significantRoleTokens(value = '') {
  return normalize(value)
    .split(' ')
    .filter((token) => token.length >= 4 && !ROLE_STOPWORDS.has(token));
}

function currentTurnMentionsTargetRole(input = {}) {
  const text = normalize(input?.turn?.rawText || '');
  const vacancy = input?.vacancy || {};
  if (!text) return false;

  const tokens = [
    ...significantRoleTokens(vacancy.role),
    ...significantRoleTokens(vacancy.title)
  ];

  return [...new Set(tokens)].some((token) => text.includes(token));
}

function currentTurnMentionsTargetCity(input = {}) {
  const text = normalize(input?.turn?.rawText || '');
  const city = normalize(vacancyCity(input?.vacancy));

  return Boolean(text && city && text.includes(city));
}

function responseFragment(input, text) {
  return {
    ...(input?.execution?.mayReply === true
      ? {
          reply: {
            text
          }
        }
      : {}),
    scheduling: null
  };
}

/**
 * Pure policy for changing an already assigned vacancy.
 *
 * The candidate's current vacancy is never used as evidence for the requested
 * role. A target vacancy snapshot supplied upstream is accepted only when the
 * current inbound turn explicitly contains both its city and role evidence.
 * This prevents a partial request such as "otra vacante en Medellín" from
 * silently inheriting the role of the previous vacancy.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export async function vacancyChangePolicy(input) {
  if (intentOf(input) !== CHANGE_VACANCY_INTENT) {
    return {};
  }

  const facts = candidateFacts(input);
  const currentVacancyId = String(facts.vacancyId || '').trim();

  if (!currentVacancyId) {
    return {};
  }

  const targetVacancy = input?.vacancy || null;
  const targetVacancyId = String(targetVacancy?.id || '').trim();
  const hasExplicitRole = currentTurnMentionsTargetRole(input);
  const hasExplicitCity = currentTurnMentionsTargetCity(input);

  if (!hasExplicitRole) {
    const city = hasExplicitCity ? vacancyCity(targetVacancy) : '';
    return responseFragment(
      input,
      city
        ? `Ya tengo la ciudad ${city}. Para cambiar tu proceso sin asumir el cargo de tu vacante actual, dime el cargo exacto de la nueva vacante.`
        : 'Para cambiar tu proceso sin asumir datos de tu vacante actual, indícame el cargo exacto de la nueva vacante.'
    );
  }

  if (!hasExplicitCity) {
    return responseFragment(
      input,
      'Ya tengo el cargo que buscas. Ahora indícame la ciudad de la nueva vacante para ubicar el proceso correcto.'
    );
  }

  if (!targetVacancyId || targetVacancyId === currentVacancyId) {
    return responseFragment(
      input,
      'Tengo la ciudad y el cargo del cambio, pero todavía no tengo identificada una vacante distinta de forma inequívoca. Indícame la operación, zona o anuncio por el que viste esa vacante.'
    );
  }

  const role = vacancyRole(targetVacancy) || 'la nueva vacante';
  const city = vacancyCity(targetVacancy);
  const targetLabel = city ? `${role} en ${city}` : role;

  return {
    mutations: {
      fieldsToPersist: {
        vacancyId: targetVacancyId
      }
    },
    ...(input?.execution?.mayReply === true
      ? {
          reply: {
            text: `Listo, cambio tu proceso a ${targetLabel}.`
          }
        }
      : {}),
    scheduling: null
  };
}

export default vacancyChangePolicy;
