import path from 'node:path';

export const ALLOWED_CV_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

export const ALLOWED_CV_EXTENSIONS = ['.pdf', '.doc', '.docx'];

export function hasAllowedCvExtension(filename = '') {
  return ALLOWED_CV_EXTENSIONS.includes(path.extname(filename || '').toLowerCase());
}

export function isCvMimeTypeAllowed(mimeType = '', filename = '') {
  const normalizedMimeType = String(mimeType || '').trim().toLowerCase();
  if (ALLOWED_CV_MIME_TYPES.includes(normalizedMimeType)) return true;

  const extensionAllowed = hasAllowedCvExtension(filename);
  const mimeMissingOrGeneric = !normalizedMimeType || normalizedMimeType === 'application/octet-stream';
  if (mimeMissingOrGeneric) return extensionAllowed;

  return normalizedMimeType === 'application/msword' && path.extname(filename || '').toLowerCase() === '.doc';
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
