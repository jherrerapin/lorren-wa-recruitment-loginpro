from pathlib import Path
import re


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)


def regex_once(text, pattern, replacement, label):
    updated, count = re.subn(pattern, lambda _match: replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return updated


# Shared candidate-facing vacancy card and professional requirement wording.
p = 'src/services/vacancyPublicInfo.js'
t = read(p)
for old, new in {
    'la edad configurada es': 'la edad requerida es',
    'el rango de edad configurado es de': 'el rango de edad es de',
    'la edad mínima configurada es': 'la edad mínima es',
    'la edad máxima configurada es': 'la edad máxima es'
}.items():
    if old not in t:
        raise SystemExit(f'age wording not found: {old}')
    t = t.replace(old, new)

if 'export function buildProfessionalVacancyPresentation' not in t:
    t += r'''

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

export function buildProfessionalVacancyPresentation(vacancy = {}, { includeInterestPrompt = false } = {}) {
  const title = publicVacancyTitle(vacancy);
  const city = publicVacancyCity(vacancy);
  const roleDescription = cleanConfiguredFragment(vacancy?.roleDescription);
  const requirements = cleanConfiguredFragment(vacancy?.requirements);
  const conditions = cleanConfiguredFragment(vacancy?.conditions);
  const address = cleanConfiguredFragment(vacancy?.operationAddress);
  const documents = cleanConfiguredFragment(vacancy?.requiredDocuments);
  const sections = [
    `*Vacante: ${title}*`,
    city ? `Ciudad: ${city}` : null,
    address ? `Zona de trabajo: ${address}` : null
  ].filter(Boolean);

  if (roleDescription) sections.push(`*Funciones*\n${professionalSentence(roleDescription)}`);

  const requirementLines = [
    requirements ? professionalSentence(requirements) : '',
    professionalAgeLine(vacancy, requirements),
    professionalExperienceLine(vacancy, requirements)
  ].filter(Boolean);
  if (requirementLines.length) sections.push(`*Requisitos*\n${requirementLines.join('\n')}`);
  if (conditions) sections.push(`*Condiciones*\n${professionalSentence(conditions)}`);
  if (documents) sections.push(`*Documentación para el proceso*\n${professionalSentence(documents)}`);

  const hasDetails = Boolean(
    roleDescription || requirements || conditions || documents
    || Number.isInteger(vacancy?.minAge) || Number.isInteger(vacancy?.maxAge)
    || ['YES', 'NO'].includes(String(vacancy?.experienceRequired || '').trim().toUpperCase())
  );
  if (!hasDetails) sections.push('La información disponible no incluye detalles adicionales para esta vacante.');
  if (includeInterestPrompt) sections.push('¿Te interesa continuar con esta vacante? Si es así, confírmame y seguimos con la postulación.');
  return sections.join('\n\n');
}
'''
write(p, t)


# Vacancy-first uses exactly the shared card; state/decision logic is unchanged.
p = 'src/services/vacancyFirstGate.js'
t = read(p)
t = replace_once(
    t,
    "import { cleanConfiguredFragment, getConfiguredAgeRequirementText, getConfiguredExperienceRequirementText } from './vacancyPublicInfo.js';",
    "import { buildProfessionalVacancyPresentation, cleanConfiguredFragment, getConfiguredAgeRequirementText, getConfiguredExperienceRequirementText } from './vacancyPublicInfo.js';",
    'vacancy first import'
)
t = regex_once(
    t,
    r"function ensureProfessionalSentence\(value = ''\) \{.*?\n\}\n\nfunction buildActiveVacancyInterestReply",
    "function buildVacancyOverview(vacancy = {}) {\n  return buildProfessionalVacancyPresentation(vacancy);\n}\n\nfunction buildActiveVacancyInterestReply",
    'vacancy first local formatter'
)
replacements = [
    ('empresa u operación exacta registrada', 'empresa u operación exacta'),
    ('La operación registrada para esta vacante es', 'La operación asociada a esta vacante es'),
    ('`La función registrada para ${title}${location} es ${roleDescription}.`', '`Las funciones del cargo para ${title}${location} son: ${roleDescription}.`'),
    ('`Tengo identificado el cargo de ${title}${location}, pero no hay una descripción adicional registrada.`', '`Tengo identificado el cargo de ${title}${location}, pero la información disponible no incluye una descripción adicional de funciones.`'),
    ('`No hay un rango de edad configurado para ${title}${location}.`', '`La información disponible no especifica un rango de edad para ${title}${location}.`'),
    ('`Los requisitos registrados para ${title}${location} son: ${requirements}.`', '`Los requisitos para ${title}${location} son: ${requirements}.`'),
    ('`No hay un requisito específico de experiencia configurado para ${title}${location}.`', '`La información disponible no especifica un requisito adicional de experiencia para ${title}${location}.`'),
    ('`No tengo requisitos adicionales registrados para ${title}${location}.`', '`La información disponible no incluye requisitos adicionales para ${title}${location}.`'),
    ('`Los documentos registrados para el proceso de ${title}${location} son: ${documents}.`', '`Los documentos requeridos para el proceso de ${title}${location} son: ${documents}.`'),
    ('`No tengo documentos adicionales registrados para ${title}${location}.`', '`La información disponible no especifica documentos adicionales para ${title}${location}.`'),
    ('`Las condiciones registradas para ${title}${location} son: ${conditions}.`', '`Las condiciones para ${title}${location} son: ${conditions}.`'),
    ('`Ese dato no está registrado para ${title}${location}.`', '`La información disponible no especifica ese detalle para ${title}${location}.`'),
    ('`La zona registrada para ${title}${location} es ${address}.`', '`El lugar de trabajo para ${title}${location} es ${address}.`'),
    ('`No tengo una zona más detallada registrada para ${title}${location}.`', '`La información disponible no incluye una ubicación más específica para ${title}${location}.`')
]
for index, (old, new) in enumerate(replacements, start=1):
    t = replace_once(t, old, new, f'vacancy first wording {index}')
write(p, t)


# Meta/consent path uses the same structured card and professional public wording.
p = 'src/services/dataConsentGate.js'
t = read(p)
t = replace_once(
    t,
    "import { cleanConfiguredFragment, getConfiguredAgeRequirementText, getConfiguredExperienceRequirementText, getConfiguredPublicRequirementSentences } from './vacancyPublicInfo.js';",
    "import { buildProfessionalVacancyPresentation, cleanConfiguredFragment, getConfiguredAgeRequirementText, getConfiguredExperienceRequirementText } from './vacancyPublicInfo.js';",
    'consent public info import'
)
t = regex_once(
    t,
    r"function buildVacancyInfoReply\(vacancy = \{\}\) \{.*?\n\}\n\nexport function buildVacancyQuestionReply",
    "function buildVacancyInfoReply(vacancy = {}) {\n  return buildProfessionalVacancyPresentation(vacancy, { includeInterestPrompt: true });\n}\n\nexport function buildVacancyQuestionReply",
    'consent shared formatter'
)
for index, (old, new) in enumerate([
    ('La operación registrada para esta vacante es', 'La operación asociada a esta vacante es'),
    ('las condiciones registradas son:', 'las condiciones son:'),
    ('No tengo un salario registrado para esta vacante.', 'La información disponible de esta vacante no especifica el salario.'),
    ('No tengo esas condiciones registradas para esta vacante.', 'La información disponible de esta vacante no especifica ese detalle.'),
    ('No hay un rango de edad configurado para esta vacante.', 'La información disponible de esta vacante no especifica un rango de edad.'),
    ('los requisitos registrados son:', 'los requisitos son:'),
    ('No hay un requisito específico de experiencia configurado para esta vacante.', 'La información disponible de esta vacante no especifica un requisito adicional de experiencia.'),
    ('No tengo ese requisito registrado para esta vacante.', 'Ese requisito no aparece en la información disponible de esta vacante.'),
    ('el cargo consiste en', 'las funciones del cargo son:'),
    ('El cargo registrado es', 'El cargo es'),
    ('la ubicación registrada es', 'el lugar de trabajo es:'),
    ('No tengo una ubicación específica registrada para esta vacante.', 'La información disponible de esta vacante no incluye una ubicación más específica.'),
    ('No tengo ese dato registrado en la vacante. Puedo continuar con la información disponible.', 'Ese detalle no aparece en la información disponible de esta vacante.')
], start=1):
    if old not in t:
        raise SystemExit(f'consent wording {index} not found: {old}')
    t = t.replace(old, new)
write(p, t)


# Contract tests: public copy must not expose implementation jargon.
p = 'test/vacancyConfiguredInformationContract.test.js'
t = read(p)
t = replace_once(
    t,
    '  assert.match(reply, /no hay un rango de edad configurado/i);',
    '  assert.match(reply, /no especifica un rango de edad/i);',
    'age missing assertion'
)
if 'respuestas públicas de vacante no exponen jerga interna' not in t:
    t += r'''

test('respuestas públicas de vacante no exponen jerga interna de configuración', () => {
  const questions = [
    '¿Para qué empresa u operación es?',
    '¿Qué condiciones tiene la vacante?',
    '¿Qué requisitos piden?',
    '¿Qué edad piden?',
    '¿Qué funciones tiene?',
    '¿Dónde queda?'
  ];
  for (const question of questions) {
    const reply = buildVacancyQuestionReply(configuredVacancy, question);
    assert.doesNotMatch(reply, /registrad[oa]|configurad[oa]|cargad[oa]/i, question);
  }
});
'''
write(p, t)


# One older assertion was tied to the former internal wording.
p = 'test/vacancyFirstGate.test.js'
t = read(p)
old = 'assert.match(decision.reply, /requisitos registrados/i);'
if old in t:
    t = t.replace(old, 'assert.match(decision.reply, /Los requisitos para .* son:/i);', 1)
write(p, t)

print('professional vacancy presentation patch applied')
