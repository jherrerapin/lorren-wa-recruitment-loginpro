export const ALLOWED_CV_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

export function isCvMimeTypeAllowed(mimeType = '') {
  return ALLOWED_CV_MIME_TYPES.includes(mimeType);
}

export function resolveStepAfterDataCompletion({ hasCv }) {
  return hasCv ? 'DONE' : 'ASK_CV';
}

export function shouldFinalizeAfterCv({ missingFields }) {
  return Array.isArray(missingFields) && missingFields.length === 0;
}
