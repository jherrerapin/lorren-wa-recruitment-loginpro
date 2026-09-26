const VACANCY_QUESTION_INTENTS = new Set([
  'ASK_VACANCY_INFORMATION',
  'ASK_VACANCY_COMPANY',
  'ASK_VACANCY_SALARY',
  'ASK_VACANCY_CONDITIONS',
  'ASK_VACANCY_REQUIREMENTS',
  'ASK_VACANCY_EXPERIENCE',
  'ASK_VACANCY_AGE',
  'ASK_VACANCY_FUNCTIONS',
  'ASK_VACANCY_LOCATION',
  'ASK_VACANCY_SCHEDULE'
]);

function normalize(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanConfiguredFragment(value = '') {
  return String(value || '').trim().replace(/\.+$/g, '');
}

function configuredInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function vacancyCity(vacancy = {}) {
  return vacancy?.operation?.city?.name || vacancy?.city || '';
}

function vacancyTitle(vacancy = {}) {
  return vacancy?.title || vacancy?.role || 'esta vacante';
}

function vacancyLocation(vacancy = {}) {
  return vacancy?.operationAddress
    || vacancy?.operation?.name
    || vacancyCity(vacancy)
    || '';
}

function getConfiguredAgeRequirementText(vacancy = {}) {
  const minAge = configuredInteger(vacancy?.minAge);
  const maxAge = configuredInteger(vacancy?.maxAge);

  if (minAge !== null && maxAge !== null) {
    if (minAge === maxAge) return `la edad requerida es ${minAge} años`;
    return `el rango de edad es de ${minAge} a ${maxAge} años`;
  }
  if (minAge !== null) return `la edad mínima es ${minAge} años`;
  if (maxAge !== null) return `la edad máxima es ${maxAge} años`;
  return '';
}

function getConfiguredExperienceRequirementText(vacancy = {}) {
  const mode = String(vacancy?.experienceRequired || '').trim().toUpperCase();
  const time = String(vacancy?.experienceTimeText || '').trim();

  if (mode === 'YES') {
    return time ? `la experiencia requerida es ${time}` : 'se requiere experiencia previa';
  }
  if (mode === 'NO') return 'no se requiere experiencia previa';
  return '';
}

function configuredScheduleText(vacancy = {}) {
  const fragments = [vacancy?.requirements, vacancy?.conditions]
    .flatMap((value) => String(value || '').split(/\r?\n|[.;]+/))
    .map((value) => cleanConfiguredFragment(value).replace(/^[-*]\s*/, ''))
    .filter((value) => /\b(horario|turno|jornada|rotativ|diurn|nocturn|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|tiempo extra)\w*\b/i.test(value));

  return [...new Set(fragments)].join('; ');
}

function buildVacancyTimingReply(vacancy = {}, text = '') {
  const normalized = normalize(text);
  const asksStartDate = /\b(cuando|fecha)\b.*\b(?:empez|empiez|inici|arranc|comienz|comens|pies)\w*/.test(normalized);

  if (asksStartDate) {
    return 'No hay una fecha de inicio registrada para esta vacante; esa fecha solo puede confirmarse cuando avance el proceso.';
  }

  if (!/\b(horarios?|turnos?|jornadas?|dias? de trabajo)\b/.test(normalized)) return '';

  const schedule = configuredScheduleText(vacancy);
  if (!schedule) {
    return 'La información registrada de esta vacante no especifica los días ni el horario de trabajo.';
  }

  const hasExactDaysOrHours = /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}\s*(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d+\s+horas?)\b/i.test(schedule);

  return hasExactDaysOrHours
    ? `Lo registrado sobre la jornada es: ${schedule}.`
    : `Solo tengo registrado sobre la jornada: ${schedule}. No hay días ni un horario exacto configurados.`;
}

function isVacancyQuestionIntent(interpretation = {}) {
  const intent = String(interpretation?.intent || '').trim().toUpperCase();
  return VACANCY_QUESTION_INTENTS.has(intent) || intent.startsWith('ASK_VACANCY_');
}

export function buildVacancyPolicyReply(vacancy = {}, rawText = '') {
  if (!vacancy) return '';

  const normalized = normalize(rawText);
  const timingReply = buildVacancyTimingReply(vacancy, rawText);
  if (timingReply) return timingReply;

  const lead = `Sobre la vacante de ${vacancyTitle(vacancy)}`;

  if (/\b(empresa|compania|cliente|quien contrata|para que empresa|operacion)\b/.test(normalized)) {
    const operationName = String(vacancy?.operation?.name || '').trim();
    return operationName
      ? `El proceso de selección lo gestiona LoginPro Service. La operación asociada a esta vacante es ${operationName}.`
      : 'El proceso de selección lo gestiona LoginPro Service.';
  }

  if (/\b(salario|sueldo|pago|cuanto pagan|cuanto es)\b/.test(normalized)) {
    const conditions = cleanConfiguredFragment(vacancy.conditions);
    return conditions
      ? `${lead}, las condiciones son: ${conditions}.`
      : 'La información disponible de esta vacante no especifica el salario.';
  }

  if (/\b(contrato|prestacion|beneficio|condicion)\b/.test(normalized)) {
    const conditions = cleanConfiguredFragment(vacancy.conditions);
    return conditions
      ? `${lead}, las condiciones son: ${conditions}.`
      : 'La información disponible de esta vacante no especifica ese detalle.';
  }

  if (/\b(edad|rango de edad)\b/.test(normalized)) {
    const ageRequirement = getConfiguredAgeRequirementText(vacancy);
    return ageRequirement
      ? `${lead}, ${ageRequirement}.`
      : 'La información disponible de esta vacante no especifica un rango de edad.';
  }

  if (/\b(experiencia|tiempo de experiencia)\b/.test(normalized)) {
    const experienceRequirement = getConfiguredExperienceRequirementText(vacancy);
    if (experienceRequirement) return `${lead}, ${experienceRequirement}.`;
    return vacancy.requirements && /\bexperiencia\b/i.test(vacancy.requirements)
      ? `${lead}, los requisitos son: ${vacancy.requirements}.`
      : 'La información disponible de esta vacante no especifica un requisito adicional de experiencia.';
  }

  if (/\b(requisito|perfil|estudio|formacion|documento|moto|carro|transporte|vehiculo)\b/.test(normalized)) {
    const parts = [];
    if (vacancy.requirements) parts.push(vacancy.requirements);

    const requiredDocuments = cleanConfiguredFragment(vacancy.requiredDocuments);
    if (requiredDocuments && /\bdocumento\b/.test(normalized)) {
      parts.push(`Documentos: ${requiredDocuments}`);
    }

    return parts.length
      ? `${lead}, los requisitos son: ${parts.join('. ')}.`
      : 'Ese requisito no aparece en la información disponible de esta vacante.';
  }

  if (/\b(funcion|funciones|labor|hacer|cargo|rol|consiste|tarea|tareas|responsabilidad|responsabilidades)\b/.test(normalized)) {
    const roleDescription = cleanConfiguredFragment(vacancy.roleDescription);
    return roleDescription
      ? `${lead}, las funciones del cargo son: ${roleDescription}.`
      : `El cargo es ${vacancyTitle(vacancy)}, pero no tengo una descripción adicional.`;
  }

  if (/\b(donde|direccion|ubicacion|zona|sector|queda)\b/.test(normalized)) {
    const location = vacancyLocation(vacancy);
    return location
      ? `${lead}, el lugar de trabajo es: ${location}.`
      : 'La información disponible de esta vacante no incluye una ubicación más específica.';
  }

  return 'Ese detalle no aparece en la información disponible de esta vacante.';
}

/**
 * Pure vacancy-context policy.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export async function vacancyPolicy(input) {
  if (!isVacancyQuestionIntent(input?.interpretation)) return {};
  if (!input?.vacancy) return {};
  if (input?.execution?.mayReply !== true) return {};

  const text = buildVacancyPolicyReply(input.vacancy, input?.turn?.rawText || '');
  return text ? { reply: { text } } : {};
}

export default vacancyPolicy;
