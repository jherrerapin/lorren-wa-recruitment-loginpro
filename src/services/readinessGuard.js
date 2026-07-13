import { getCandidateResidenceValue, getResidenceFieldConfig, normalizeCandidateFields } from './candidateData.js';
import { isCvMimeTypeAllowed } from './cvFlow.js';

export const CORE_FIELDS = [
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'medicalRestrictions',
  'transportMode'
];

const FIELD_LABELS = {
  fullName: 'nombre completo',
  documentType: 'tipo de documento',
  documentNumber: 'numero de documento',
  age: 'edad',
  locality: 'localidad',
  neighborhood: 'barrio',
  medicalRestrictions: 'restricciones medicas',
  transportMode: 'medio de transporte',
  experienceInfo: 'experiencia',
  experienceTime: 'tiempo de experiencia',
  experienceSummary: 'en qué tiene experiencia',
  cv: 'hoja de vida en PDF o Word/DOCX',
  vacancyId: 'vacante asignada',
  eligibility: 'requisitos de la vacante'
};

function getConfiguredCandidateFields(vacancy = null) {
  const configured = vacancy?.requiredCandidateFields
    || vacancy?.requiredFields
    || vacancy?.dataFields
    || vacancy?.fieldsToCollect
    || null;
  if (!Array.isArray(configured)) return null;
  const fields = configured.map((field) => String(field || '').trim()).filter(Boolean);
  return fields.length ? [...new Set(fields)] : null;
}

export function getRequiredCandidateFieldKeys(vacancy = null) {
  const configuredFields = getConfiguredCandidateFields(vacancy);
  if (configuredFields) return configuredFields;

  const residenceConfig = getResidenceFieldConfig(vacancy);
  const fields = [
    'fullName',
    'documentType',
    'documentNumber',
    'age',
    residenceConfig.field,
    'medicalRestrictions',
    'transportMode'
  ];

  if (vacancy?.experienceRequired === 'YES') {
    fields.push('experienceInfo', 'experienceTime', 'experienceSummary');
  }

  return fields;
}

export function getFieldLabel(field, vacancy = null) {
  if (field === 'locality' || field === 'neighborhood') {
    return getResidenceFieldConfig(vacancy).articleLabel;
  }
  if (field === 'experienceTime' && vacancy?.experienceTimeText) {
    return `tiempo de experiencia (${vacancy.experienceTimeText})`;
  }
  if (field === 'experienceInfo') return 'si tiene experiencia';
  return FIELD_LABELS[field] || field;
}

function parseNullableInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildAgeRangeText(minAge, maxAge) {
  if (Number.isFinite(minAge) && Number.isFinite(maxAge)) return `entre ${minAge} y ${maxAge} años`;
  if (Number.isFinite(minAge)) return `mínimo ${minAge} años`;
  if (Number.isFinite(maxAge)) return `máximo ${maxAge} años`;
  return null;
}

function buildAgeEligibilityFailure({ code, candidateAge, minAge, maxAge }) {
  const rangeText = buildAgeRangeText(minAge, maxAge);
  const message = rangeText
    ? `edad fuera del rango requerido para la vacante (${rangeText})`
    : 'edad fuera del rango requerido para la vacante';

  return {
    code,
    field: 'age',
    message,
    label: message,
    candidateAge,
    minAge,
    maxAge,
    reason: code,
    details: `Edad detectada: ${candidateAge}${rangeText ? `. Rango requerido: ${rangeText}` : ''}.`
  };
}

export function evaluateCandidateEligibility(candidate = {}, vacancy = null) {
  const vacancyContext = vacancy || candidate?.vacancy || null;
  const candidateAge = parseNullableInteger(candidate?.age);
  const minAge = parseNullableInteger(vacancyContext?.minAge);
  const maxAge = parseNullableInteger(vacancyContext?.maxAge);
  const failures = [];

  if (Number.isFinite(candidateAge)) {
    if (Number.isFinite(minAge) && candidateAge < minAge) {
      failures.push(buildAgeEligibilityFailure({
        code: 'age_below_min',
        candidateAge,
        minAge,
        maxAge
      }));
    }

    if (Number.isFinite(maxAge) && candidateAge > maxAge) {
      failures.push(buildAgeEligibilityFailure({
        code: 'age_above_max',
        candidateAge,
        minAge,
        maxAge
      }));
    }
  }

  return {
    eligible: failures.length === 0,
    failures,
    blockedReasons: failures.map((failure) => `eligibility_${failure.code}:age`),
    age: candidateAge,
    minAge,
    maxAge
  };
}

export function getMissingFieldLabels(candidate = {}, vacancy = null) {
  const readiness = getCandidateReadiness(candidate, vacancy, { requireCv: false });
  return [
    ...readiness.missingFields.map((field) => getFieldLabel(field, vacancy)),
    ...(readiness.eligibilityFailures || []).map((failure) => failure.label || failure.message).filter(Boolean)
  ];
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function hasCandidateFieldValue(candidate = {}, field = '') {
  if (hasValue(candidate[field])) return true;

  if (field === 'experienceInfo') {
    const inferred = normalizeCandidateFields({
      experienceTime: candidate.experienceTime,
      experienceSummary: candidate.experienceSummary
    });
    return hasValue(inferred.experienceInfo);
  }

  return false;
}

export function hasValidCv(candidate = {}) {
  const mime = String(candidate.cvMimeType || '').trim().toLowerCase();
  const filename = String(candidate.cvOriginalName || '').trim();
  const hasStoredFile = Boolean(candidate.cvStorageKey || candidate.cvData);

  if (!hasStoredFile) return false;
  if (mime.startsWith('image/')) return false;

  return isCvMimeTypeAllowed(mime, filename);
}

function hasBaseRegistrationFields(candidate = {}, vacancyContext = null) {
  return Boolean(
    hasValue(candidate.fullName)
    && hasValue(candidate.documentType)
    && hasValue(candidate.documentNumber)
    && hasValue(candidate.age)
    && hasValue(getCandidateResidenceValue(candidate, vacancyContext))
    && hasValue(candidate.medicalRestrictions)
    && hasValue(candidate.transportMode)
  );
}

function isClosedOrRegistered(candidate = {}) {
  return candidate.currentStep === 'DONE'
    || ['REGISTRADO', 'VALIDANDO', 'APROBADO', 'CONTACTADO'].includes(String(candidate.status || ''));
}

function removePostRegistrationDynamicFields(missingFields = []) {
  for (const field of ['experienceInfo', 'experienceTime', 'experienceSummary']) {
    const index = missingFields.indexOf(field);
    if (index >= 0) missingFields.splice(index, 1);
  }
}

function normalizedExperienceState(candidate = {}) {
  return normalizeCandidateFields({
    experienceInfo: candidate.experienceInfo,
    experienceTime: candidate.experienceTime,
    experienceSummary: candidate.experienceSummary
  });
}

export function getCandidateReadiness(candidate = {}, vacancy = null, options = {}) {
  const missingFields = [];
  const vacancyContext = vacancy || candidate?.vacancy || candidate;
  const residenceConfig = getResidenceFieldConfig(vacancyContext);
  const experienceState = normalizedExperienceState(candidate);

  for (const field of getRequiredCandidateFieldKeys(vacancyContext)) {
    if (field === residenceConfig.field) {
      if (!hasValue(getCandidateResidenceValue(candidate, vacancyContext))) missingFields.push(field);
      continue;
    }
    if (field === 'experienceSummary' && experienceState.experienceInfo === 'No') {
      continue;
    }
    if (!hasCandidateFieldValue(candidate, field)) missingFields.push(field);
  }

  const requireCv = options.requireCv !== false;
  const validCv = hasValidCv(candidate);
  const eligibility = evaluateCandidateEligibility(candidate, vacancyContext);
  const eligibilityFailures = eligibility.failures;
  const hasEligibilityFailures = eligibilityFailures.length > 0;

  if (validCv && isClosedOrRegistered(candidate) && hasBaseRegistrationFields(candidate, vacancyContext)) {
    removePostRegistrationDynamicFields(missingFields);
  }

  const missingForDone = [...missingFields];
  if (hasEligibilityFailures) missingForDone.push('eligibility');
  if (requireCv && !validCv) missingForDone.push('cv');

  const blockedReasons = [];
  if (missingFields.length) blockedReasons.push(`missing_core_fields:${missingFields.join(',')}`);
  if (hasEligibilityFailures) blockedReasons.push(...eligibility.blockedReasons);
  if (requireCv && !validCv) blockedReasons.push('missing_cv');
  if (!candidate.vacancyId && !vacancy?.id) blockedReasons.push('missing_vacancy');

  return {
    coreDataComplete: missingFields.length === 0 && !hasEligibilityFailures,
    hasValidCv: validCv,
    missingFields,
    missingFieldLabels: [
      ...missingFields.map((field) => getFieldLabel(field, vacancyContext)),
      ...eligibilityFailures.map((failure) => failure.label || failure.message).filter(Boolean)
    ],
    eligibility,
    eligibilityFailures,
    readyForCvRequest: missingFields.length === 0 && !validCv && !hasEligibilityFailures,
    readyForScheduling: missingFields.length === 0 && validCv && Boolean(candidate.vacancyId || vacancy?.id) && !hasEligibilityFailures,
    readyForDone: missingForDone.length === 0,
    missingForDone,
    blockedReasons
  };
}

function formatNaturalFieldList(labels = []) {
  const values = labels.map((label) => String(label || '').trim()).filter(Boolean);
  if (!values.length) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} y ${values[1]}`;
  return `${values.slice(0, -1).join(', ')} y ${values[values.length - 1]}`;
}

function buildEligibilityFailureReply(readiness = {}) {
  const failure = readiness?.eligibilityFailures?.[0];
  if (!failure) return '';
  return 'Gracias por tu interés. En este caso no es posible continuar con tu postulación porque la edad registrada no cumple el rango definido para esta vacante.';
}

export function buildCandidateDataCollectionMessage(candidate = {}, vacancy = null) {
  const readiness = getCandidateReadiness(candidate, vacancy, { requireCv: false });
  const eligibilityReply = buildEligibilityFailureReply(readiness);
  if (eligibilityReply) return eligibilityReply;
  const pendingText = formatNaturalFieldList(readiness.missingFieldLabels || []);
  if (!pendingText) return '';
  return `Perfecto, seguimos con tu postulación. Para dejar tu registro completo, compárteme en un solo mensaje ${pendingText}.`;
}

export function getFirstMissingFieldLabel(readiness = {}) {
  if (readiness?.eligibilityFailures?.length) {
    return readiness.eligibilityFailures[0].label || readiness.eligibilityFailures[0].message || FIELD_LABELS.eligibility;
  }
  const field = readiness.missingFields?.[0] || readiness.missingForDone?.[0] || null;
  return field ? (readiness.missingFieldLabels?.[0] || FIELD_LABELS[field] || field) : null;
}

export function buildMissingFieldReply(readiness = {}) {
  const eligibilityReply = buildEligibilityFailureReply(readiness);
  if (eligibilityReply) return eligibilityReply;
  if (!readiness?.missingFields?.length) {
    if (!readiness?.hasValidCv) return 'Para continuar, adjunta tu hoja de vida como archivo PDF o Word/DOCX.';
    return 'La información principal está lista; sigo con el punto concreto que falta para avanzar.';
  }
  const label = getFirstMissingFieldLabel(readiness);
  return `Para avanzar de forma correcta, confírmame por favor ${label}.`;
}
