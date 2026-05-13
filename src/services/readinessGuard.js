import { getCandidateResidenceValue, getResidenceFieldConfig } from './candidateData.js';

const CORE_FIELDS = [
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

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function hasValidCv(candidate = {}) {
  const mime = String(candidate.cvMimeType || '').toLowerCase();
  const name = String(candidate.cvOriginalName || '').toLowerCase();
  const hasStoredFile = Boolean(candidate.cvStorageKey || candidate.cvData || candidate.cvOriginalName);
  if (!hasStoredFile) return false;
  if (mime.startsWith('image/')) return false;
  if (mime) {
    return mime.includes('pdf')
      || mime.includes('word')
      || mime === 'application/msword'
      || mime.includes('officedocument.wordprocessingml.document');
  }
  return /\.(pdf|docx?|doc)$/i.test(name) || Boolean(candidate.cvStorageKey || candidate.cvData);
}

export function getCandidateReadiness(candidate = {}, vacancy = null, options = {}) {
  const missingFields = [];
  for (const field of CORE_FIELDS) {
    if (!hasValue(candidate[field])) missingFields.push(field);
  }

  const residenceConfig = getResidenceFieldConfig(vacancy || candidate?.vacancy || candidate);
  if (!hasValue(getCandidateResidenceValue(candidate, vacancy || candidate?.vacancy || candidate))) {
    missingFields.push(residenceConfig.field);
  }

  if (vacancy?.experienceRequired === 'YES') {
    if (!hasValue(candidate.experienceInfo)) missingFields.push('experienceInfo');
    if (!hasValue(candidate.experienceTime)) missingFields.push('experienceTime');
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
    missingFieldLabels: missingFields.map((field) => FIELD_LABELS[field] || field),
    readyForCvRequest: missingFields.length === 0 && !validCv,
    readyForScheduling: missingFields.length === 0 && validCv && Boolean(candidate.vacancyId || vacancy?.id),
    readyForDone: missingForDone.length === 0,
    missingForDone,
    blockedReasons
  };
}

export function getFirstMissingFieldLabel(readiness = {}) {
  const field = readiness.missingFields?.[0] || readiness.missingForDone?.[0] || null;
  return field ? (FIELD_LABELS[field] || field) : null;
}

export function buildMissingFieldReply(readiness = {}) {
  if (!readiness?.missingFields?.length) {
    if (!readiness?.hasValidCv) return 'Para continuar, adjunta tu hoja de vida como archivo PDF o Word/DOCX.';
    return 'Ya tengo la información principal; voy a revisar el siguiente paso del proceso.';
  }
  const label = getFirstMissingFieldLabel(readiness);
  return `Para avanzar de forma correcta, confírmame por favor ${label}.`;
}
