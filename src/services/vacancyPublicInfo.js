export function cleanConfiguredFragment(value = '') {
  return String(value || '').trim().replace(/\.+$/g, '');
}

function configuredInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function sentence(fragment = '') {
  const value = String(fragment || '').trim();
  if (!value) return '';
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}.`;
}

export function getConfiguredAgeRequirementText(vacancy = {}) {
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

export function getConfiguredExperienceRequirementText(vacancy = {}) {
  const mode = String(vacancy?.experienceRequired || '').trim().toUpperCase();
  const time = String(vacancy?.experienceTimeText || '').trim();
  if (mode === 'YES') return time ? `la experiencia requerida es ${time}` : 'se requiere experiencia previa';
  if (mode === 'NO') return 'no se requiere experiencia previa';
  return '';
}

function normalizePublicQuestion(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function configuredScheduleText(vacancy = {}) {
  const fragments = [vacancy?.requirements, vacancy?.conditions]
    .flatMap((value) => String(value || '').split(/\r?\n|[.;]+/))
    .map((value) => cleanConfiguredFragment(value).replace(/^[-*]\s*/, ''))
    .filter((value) => /\b(horario|turno|jornada|rotativ|diurn|nocturn|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|tiempo extra)\w*\b/i.test(value));
  return [...new Set(fragments)].join('; ');
}

export function buildVacancyTimingReply(vacancy = {}, text = '') {
  const normalized = normalizePublicQuestion(text);
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

export function getConfiguredPublicRequirementSentences(vacancy = {}, requirementsText = '') {
  const requirements = String(requirementsText || '').trim();
  const age = getConfiguredAgeRequirementText(vacancy);
  const experience = getConfiguredExperienceRequirementText(vacancy);
  const facts = [];
  const mentionsAge = /\bedad\b|\b\d{1,2}\s*(?:a|-)\s*\d{1,2}\s*a[nñ]os?\b/i.test(requirements);
  const mentionsExperience = /\bexperiencia\b/i.test(requirements);
  if (age && !mentionsAge) facts.push(sentence(age));
  if (experience && !mentionsExperience) facts.push(sentence(experience));
  return facts;
}

function publicVacancyCity(vacancy = {}) {
  return vacancy?.operation?.city?.name || vacancy?.city || '';
}

function publicVacancyTitle(vacancy = {}) {
  return String(vacancy?.title || vacancy?.role || 'Vacante disponible').trim();
}

function professionalSentence(value = '') {
  const clean = cleanConfiguredFragment(value);
  return clean ? `${clean}.` : '';
}

function professionalAgeLine(vacancy = {}, requirements = '') {
  if (/\bedad\b|\b\d{1,2}\s*(?:a|-)\s*\d{1,2}\s*a[nñ]os?\b/i.test(requirements)) return '';
  const minAge = configuredInteger(vacancy?.minAge);
  const maxAge = configuredInteger(vacancy?.maxAge);
  if (minAge !== null && maxAge !== null) {
    return minAge === maxAge ? `Edad: ${minAge} años.` : `Edad: ${minAge} a ${maxAge} años.`;
  }
  if (minAge !== null) return `Edad mínima: ${minAge} años.`;
  if (maxAge !== null) return `Edad máxima: ${maxAge} años.`;
  return '';
}

function professionalExperienceLine(vacancy = {}, requirements = '') {
  if (/\bexperiencia\b/i.test(requirements)) return '';
  const mode = String(vacancy?.experienceRequired || '').trim().toUpperCase();
  const time = cleanConfiguredFragment(vacancy?.experienceTimeText);
  if (mode === 'YES') {
    return time ? `Experiencia: ${time.charAt(0).toUpperCase()}${time.slice(1)}.` : 'Experiencia: Requerida.';
  }
  if (mode === 'NO') return 'Experiencia: No requerida.';
  return '';
}

// Fuente única para la ficha pública de vacante usada en los distintos puntos de entrada conversacionales.
export function buildProfessionalVacancyPresentation(
  vacancy = {},
  { includeInterestPrompt = false, includeDocuments = false } = {}
) {
  const title = publicVacancyTitle(vacancy);
  const city = publicVacancyCity(vacancy);
  const roleDescription = cleanConfiguredFragment(vacancy?.roleDescription);
  const requirements = cleanConfiguredFragment(vacancy?.requirements);
  const conditions = cleanConfiguredFragment(vacancy?.conditions);
  const address = cleanConfiguredFragment(vacancy?.operationAddress);
  const documents = includeDocuments ? cleanConfiguredFragment(vacancy?.requiredDocuments) : '';

  const sections = [`*Vacante: ${title}*`];
  if (address) sections.push(`*Zona de trabajo:* ${address}`);
  else if (city) sections.push(`*Ciudad:* ${city}`);
  if (roleDescription) sections.push(`*Funciones del cargo*\n${professionalSentence(roleDescription)}`);

  const requirementLines = [
    requirements ? professionalSentence(requirements) : '',
    professionalAgeLine(vacancy, requirements),
    professionalExperienceLine(vacancy, requirements)
  ].filter(Boolean);
  if (requirementLines.length) sections.push(`*Requisitos*\n${requirementLines.join('\n')}`);
  if (conditions) sections.push(`*Condiciones*\n${professionalSentence(conditions)}`);
  if (documents) sections.push(`*Documentación para el proceso*\n${professionalSentence(documents)}`);

  const hasDetails = Boolean(
    roleDescription || requirements || conditions || address || documents
    || Number.isInteger(vacancy?.minAge) || Number.isInteger(vacancy?.maxAge)
    || ['YES', 'NO'].includes(String(vacancy?.experienceRequired || '').trim().toUpperCase())
  );
  if (!hasDetails) sections.push('La vacante está activa para recibir postulaciones.');
  if (includeInterestPrompt) {
    sections.push('¿Te interesa continuar con esta vacante? Si es así, confírmame y seguimos con la postulación.');
  }
  return sections.join('\n\n');
}
