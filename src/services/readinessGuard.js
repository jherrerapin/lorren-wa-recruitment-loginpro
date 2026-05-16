import { getCandidateResidenceValue, getResidenceFieldConfig } from './candidateData.js';
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
  cv: 'hoja de vida en PDF o Word/DOCX',
  vacancyId: 'vacante asignada'
};


export function getRequiredCandidateFieldKeys(vacancy = null) {
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
    fields.push('experienceInfo', 'experienceTime');
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
  if (field === 'experienceInfo') return 'experiencia (si o no)';
  return FIELD_LABELS[field] || field;
}

export function getMissingFieldLabels(candidate = {}, vacancy = null) {
  return getCandidateReadiness(candidate, vacancy, { requireCv: false })
    .missingFields
    .map((field) => getFieldLabel(field, vacancy));
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function hasValidCv(candidate = {}) {
  const mime = String(candidate.cvMimeType || '').trim().toLowerCase();
  const filename = String(candidate.cvOriginalName || '').trim();
  const hasStoredFile = Boolean(candidate.cvStorageKey || candidate.cvData);

  if (!hasStoredFile) return false;
  if (mime.startsWith('image/')) return false;

  return isCvMimeTypeAllowed(mime, filename);
}

export function getCandidateReadiness(candidate = {}, vacancy = null, options = {}) {
  const missingFields = [];
  const vacancyContext = vacancy || candidate?.vacancy || candidate;
  const residenceConfig = getResidenceFieldConfig(vacancyContext);

  for (const field of getRequiredCandidateFieldKeys(vacancyContext)) {
    if (field === residenceConfig.field) {
      if (!hasValue(getCandidateResidenceValue(candidate, vacancyContext))) missingFields.push(field);
      continue;
    }
    if (!hasValue(candidate[field])) missingFields.push(field);
  }

  const requireCv = options.requireCv !== false;
  const validCv = hasValidCv(candidate);
  const missingForDone = [...missingFields];
  if (requireCv && !validCv) missingForDone.push('cv');

  const blockedReasons = [];
  if (missingFields.length) blockedReasons.push(`missing_core_fields:${missingFields.join(',')}`);
  if (requireCv && !validCv) blockedReasons.push('missing_cv');
  if (!candidate.vacancyId && !vacancy?.id) blockedReasons.push('missing_vacancy');

  return {
    coreDataComplete: missingFields.length === 0,
    hasValidCv: validCv,
    missingFields,
    missingFieldLabels: missingFields.map((field) => getFieldLabel(field, vacancyContext)),
    readyForCvRequest: missingFields.length === 0 && !validCv,
    readyForScheduling: missingFields.length === 0 && validCv && Boolean(candidate.vacancyId || vacancy?.id),
    readyForDone: missingForDone.length === 0,
    missingForDone,
    blockedReasons
  };
}

export function getFirstMissingFieldLabel(readiness = {}) {
  const field = readiness.missingFields?.[0] || readiness.missingForDone?.[0] || null;
  return field ? (readiness.missingFieldLabels?.[0] || FIELD_LABELS[field] || field) : null;
}

export function buildMissingFieldReply(readiness = {}) {
  if (!readiness?.missingFields?.length) {
    if (!readiness?.hasValidCv) return 'Para continuar, adjunta tu hoja de vida como archivo PDF o Word/DOCX.';
    return 'La información principal está lista; sigo con el punto concreto que falta para avanzar.';
  }
  const label = getFirstMissingFieldLabel(readiness);
  return `Para avanzar de forma correcta, confírmame por favor ${label}.`;
}
