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
const AWAITING_POOL_CONSENT = 'AWAITING_POOL_CONSENT';
const AWAITING_VACANCY_INTEREST = 'awaiting_vacancy_interest';
const AWAITING_DATA_CONSENT = 'awaiting_data_consent';
const POOL_DECLINED_REPLY =
  'Entendido. Si más adelante deseas continuar con la postulación, puedes volver a escribirme y con gusto retomamos el proceso.';
const POOL_OPTIONS = Object.freeze([
  Object.freeze({ id: 'pool_consent:accept', label: 'Sí, de acuerdo' }),
  Object.freeze({ id: 'pool_consent:reject', label: 'No, gracias' })
]);
const INTEREST_OPTIONS = Object.freeze([
  Object.freeze({ id: 'vacancy_interest:accept', label: 'Sí, me interesa' }),
  Object.freeze({ id: 'vacancy_interest:reject', label: 'No, gracias' })
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

function poolDecision(input = {}) {
  const intent = String(input?.interpretation?.intent || '').trim().toUpperCase();
  const interpreted = String(
    input?.interpretation?.poolConsentDecision
      ?? input?.interpretation?.generalPoolDecision
      ?? ''
  ).trim().toUpperCase();
  if (['ACCEPTED', 'AGREED', 'YES', 'OPT_IN'].includes(interpreted)) return 'ACCEPTED';
  if (['REJECTED', 'DECLINED', 'NO', 'OPT_OUT'].includes(interpreted)) return 'REJECTED';
  if (['ACCEPTED', 'AGREED', 'YES', 'OPT_IN'].includes(intent)) return 'ACCEPTED';
  if (['REJECTED', 'DECLINED', 'NO', 'OPT_OUT'].includes(intent)) return 'REJECTED';
  const text = normalize(input?.turn?.rawText);
  if (/^(no|no gracias|nop|negativo|paso|mejor no|prefiero no)\b/.test(text)) return 'REJECTED';
  if (/^(si|si de acuerdo|de acuerdo|acepto|claro|listo|quiero)\b/.test(text)) return 'ACCEPTED';
  return null;
}

function isAwaitingPoolConsent(input = {}) {
  if (String(input?.candidate?.facts?.currentStep || '').trim().toUpperCase() === AWAITING_POOL_CONSENT) {
    return true;
  }
  return (input?.pending?.fields || []).some((field) => (
    ['AWAITING_POOL_CONSENT', 'POOLCONSENT', 'OPTINGENERALPOOL']
      .includes(String(field || '').trim().toUpperCase())
  ));
}

function buildPoolOffer(input = {}) {
  const role = String(input?.vacancy?.role || input?.vacancy?.title
    || input?.candidate?.facts?.vacancyRole || '').trim();
  const city = String(vacancyCity(input?.vacancy)
    || input?.candidate?.facts?.vacancyCity || '').trim();
  const label = role
    ? `la vacante de ${role}${city ? ` en ${city}` : ''}`
    : city ? `la vacante en ${city}` : 'esta vacante';
  return `En este momento ${label} no se encuentra activa, pero si deseas podemos dejar tu postulación para futuras aperturas. ¿Estás de acuerdo?`;
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

function candidateResumeMode(input = {}) {
  return String(input?.candidate?.facts?.botResumeMode || '').trim().toLowerCase();
}

function consentIsPending(input = {}) {
  const status = String(input?.candidate?.facts?.dataConsentStatus || '').trim().toUpperCase();
  return !['ACCEPTED', 'REVOKED', 'REJECTED'].includes(status);
}

function buildVacancyOverview(vacancy = {}) {
  const parts = [];
  const title = vacancyTitle(vacancy);
  const city = vacancyCity(vacancy);
  parts.push(`La vacante es ${title}${city ? ` en ${city}` : ''}.`);

  const description = cleanConfiguredFragment(vacancy.roleDescription);
  if (description) parts.push(`Funciones: ${description}.`);

  const requirements = cleanConfiguredFragment(vacancy.requirements);
  if (requirements) parts.push(`Requisitos: ${requirements}.`);

  const conditions = cleanConfiguredFragment(vacancy.conditions);
  if (conditions) parts.push(`Condiciones: ${conditions}.`);

  const location = cleanConfiguredFragment(vacancy.operationAddress);
  if (location) parts.push(`Lugar de trabajo: ${location}.`);

  parts.push('¿Te interesa continuar con la postulación?');
  return parts.join('\n');
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

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function unresolvedRecruitmentContext(input = {}) {
  const facts = input?.candidate?.facts || {};
  const interpretation = input?.interpretation || {};
  const detected = interpretation.detectedFields || {};
  const extracted = interpretation.extractedFields || {};
  const provided = interpretation.providedFields || {};
  const fields = interpretation.fields || {};

  return {
    city: firstNonEmptyString(
      facts.recruitmentCity,
      fields.recruitmentCity,
      provided.recruitmentCity,
      extracted.recruitmentCity,
      detected.recruitmentCity,
      provided.cityHint,
      extracted.cityHint,
      detected.cityHint,
      fields.city,
      provided.city,
      extracted.city,
      detected.city
    ),
    role: firstNonEmptyString(
      facts.recruitmentRole,
      fields.recruitmentRole,
      provided.recruitmentRole,
      extracted.recruitmentRole,
      detected.recruitmentRole,
      provided.roleHint,
      extracted.roleHint,
      detected.roleHint,
      fields.role,
      provided.role,
      extracted.role,
      detected.role
    )
  };
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

  if (/\b(requisitos?|perfil|estudios?|formacion|documentos?|moto|carro|transporte|vehiculo)\b/.test(normalized)) {
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
export function vacancyPolicy(input) {
  const intent = String(input?.interpretation?.intent || '').trim().toUpperCase();
  if (['INACTIVITY_REMINDER', 'INTERVIEW_REMINDER'].includes(intent)) return {};

  if (isAwaitingPoolConsent(input)) {
    const decision = poolDecision(input);
    if (decision === 'ACCEPTED') {
      return { mutations: { fieldsToPersist: { optInGeneralPool: true } } };
    }
    if (decision === 'REJECTED') {
      return {
        reply: { text: POOL_DECLINED_REPLY, interactiveOptions: [] },
        transitions: { endConversation: true }
      };
    }
    if (['ACKNOWLEDGEMENT', 'SOFT_CONFIRMATION', 'THANKS'].includes(intent)) {
      return {
        reply: {
          text: 'Para continuar necesito que me confirmes si deseas que guardemos tu postulación para futuras aperturas. ¿Estás de acuerdo?',
          interactiveOptions: POOL_OPTIONS
        },
        transitions: { keepCurrentStep: true }
      };
    }
    return {};
  }

  if (input?.vacancy === null && !input?.candidate?.facts?.vacancyId) {
    const context = unresolvedRecruitmentContext(input);
    if (!context.city && !context.role) {
      return {
        reply: { directive: 'ASK_CITY_AND_VACANCY' },
        transitions: { keepCurrentStep: true }
      };
    }
    if (context.city && !context.role) {
      return {
        reply: {
          directive: 'ASK_VACANCY_FOR_CITY',
          parameters: { city: context.city }
        },
        transitions: { keepCurrentStep: true }
      };
    }
    if (!context.city && context.role) {
      return {
        reply: {
          directive: 'ASK_CITY_FOR_ROLE',
          parameters: { role: context.role }
        },
        transitions: { keepCurrentStep: true }
      };
    }
    return {
      reply: {
        directive: 'CLARIFY_VACANCY_SELECTION',
        parameters: { roleHint: context.role, cityHint: context.city }
      },
      transitions: { keepCurrentStep: true }
    };
  }

  const vacancyActive = input?.vacancy?.isActive ?? input?.candidate?.facts?.vacancyActive;
  const accepting = input?.vacancy?.acceptingApplications
    ?? input?.candidate?.facts?.vacancyAcceptingApplications
    ?? input?.candidate?.facts?.acceptingApplications;
  if (vacancyActive === false || accepting === false) {
    return {
      reply: {
        text: buildPoolOffer(input),
        interactiveOptions: POOL_OPTIONS
      },
      mutations: { nextStep: AWAITING_POOL_CONSENT },
      transitions: { keepCurrentStep: false }
    };
  }

  if (!input?.vacancy || input?.execution?.mayReply !== true) return {};

  const mode = candidateResumeMode(input);
  const vacancyQuestion = isVacancyQuestionIntent(input?.interpretation);

  if (consentIsPending(input) && mode !== AWAITING_DATA_CONSENT) {
    if (mode === AWAITING_VACANCY_INTEREST) {
      if (!vacancyQuestion) return {};
      const answer = buildVacancyPolicyReply(input.vacancy, input?.turn?.rawText || '');
      return answer
        ? {
            reply: {
              text: `${answer}\n\n¿Te interesa continuar con la postulación?`,
              interactiveOptions: INTEREST_OPTIONS
            },
            transitions: { keepCurrentStep: true }
          }
        : {};
    }

    if (vacancyQuestion) {
      const answer = buildVacancyPolicyReply(input.vacancy, input?.turn?.rawText || '');
      return answer
        ? {
            reply: {
              text: `${answer}\n\n¿Te interesa continuar con la postulación?`,
              interactiveOptions: INTEREST_OPTIONS
            },
            mutations: {
              fieldsToPersist: { botResumeMode: AWAITING_VACANCY_INTEREST }
            },
            transitions: { keepCurrentStep: true }
          }
        : {};
    }

    return {
      reply: {
        text: buildVacancyOverview(input.vacancy),
        interactiveOptions: INTEREST_OPTIONS
      },
      mutations: {
        fieldsToPersist: { botResumeMode: AWAITING_VACANCY_INTEREST }
      },
      transitions: { keepCurrentStep: true }
    };
  }

  if (!vacancyQuestion) return {};
  const text = buildVacancyPolicyReply(input.vacancy, input?.turn?.rawText || '');
  return text ? { reply: { text } } : {};
}

export default vacancyPolicy;
