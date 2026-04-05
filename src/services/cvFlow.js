import path from 'node:path';

export const ALLOWED_CV_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

export const ALLOWED_CV_EXTENSIONS = ['.pdf', '.doc', '.docx'];

export function hasAllowedCvExtension(filename = '') {
  return ALLOWED_CV_EXTENSIONS.includes(path.extname(filename || '').toLowerCase());
}

export function isCvMimeTypeAllowed(mimeType = '', filename = '') {
  const normalizedMimeType = String(mimeType || '').trim().toLowerCase();
  if (ALLOWED_CV_MIME_TYPES.includes(normalizedMimeType)) return true;

  const mimeMissingOrGeneric = !normalizedMimeType || normalizedMimeType === 'application/octet-stream';
  return mimeMissingOrGeneric && hasAllowedCvExtension(filename);
}

export function resolveStepAfterDataCompletion({ hasCv }) {
  return hasCv ? 'DONE' : 'ASK_CV';
}

export function shouldFinalizeAfterCv({ missingFields }) {
  return Array.isArray(missingFields) && missingFields.length === 0;
}
