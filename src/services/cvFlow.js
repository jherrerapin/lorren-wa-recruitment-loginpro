import path from 'node:path';

export const ALLOWED_CV_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

export const ALLOWED_CV_EXTENSIONS = ['.pdf', '.doc', '.docx'];

const MIME_TYPES_BY_EXTENSION = Object.freeze({
  '.pdf': new Set(['application/pdf']),
  '.doc': new Set(['application/msword']),
  '.docx': new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
});

export function hasAllowedCvExtension(filename = '') {
  return ALLOWED_CV_EXTENSIONS.includes(path.extname(filename || '').toLowerCase());
}

export function isCvMimeTypeAllowed(mimeType = '', filename = '') {
  const normalizedMimeType = String(mimeType || '').trim().toLowerCase();
  const extension = path.extname(filename || '').toLowerCase();
  const mimeMissingOrGeneric = !normalizedMimeType || normalizedMimeType === 'application/octet-stream';

  if (extension) {
    if (!ALLOWED_CV_EXTENSIONS.includes(extension)) return false;
    if (mimeMissingOrGeneric) return true;
    return MIME_TYPES_BY_EXTENSION[extension].has(normalizedMimeType);
  }

  return ALLOWED_CV_MIME_TYPES.includes(normalizedMimeType);
}

export function resolveStepAfterDataCompletion({ hasCv }) {
  return hasCv ? 'DONE' : 'ASK_CV';
}

export function shouldFinalizeAfterCv({ missingFields }) {
  return Array.isArray(missingFields) && missingFields.length === 0;
}

export function looksLikeCvFilenameText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const mentionsCv = /\b(hoja\s+de\s+vida|hv|curriculum|curriculo|minerva\s*1003)\b/.test(normalized);
  const mentionsFileExtension = /\.(pdf|docx?)\b/.test(normalized);
  const hasNoRealAttachmentHint = !/\b(adjunto|adjunte|anexo|envio\s+archivo|subi|cargue)\b/.test(normalized);
  return mentionsCv && mentionsFileExtension && hasNoRealAttachmentHint;
}
