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
    if (minAge === maxAge) return `la edad configurada es ${minAge} años`;
    return `el rango de edad configurado es de ${minAge} a ${maxAge} años`;
  }
  if (minAge !== null) return `la edad mínima configurada es ${minAge} años`;
  if (maxAge !== null) return `la edad máxima configurada es ${maxAge} años`;
  return '';
}

export function getConfiguredExperienceRequirementText(vacancy = {}) {
  const mode = String(vacancy?.experienceRequired || '').trim().toUpperCase();
  const time = String(vacancy?.experienceTimeText || '').trim();
  if (mode === 'YES') return time ? `la experiencia requerida es ${time}` : 'se requiere experiencia previa';
  if (mode === 'NO') return 'no se requiere experiencia previa';
  return '';
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
