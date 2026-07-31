import path from 'node:path';

const PDF_SIGNATURE = Buffer.from('%PDF-');
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08])
];

export const CV_DOCUMENT_TYPES = Object.freeze({
  PDF: Object.freeze({ kind: 'pdf', mimeType: 'application/pdf', extension: '.pdf' }),
  DOC: Object.freeze({ kind: 'doc', mimeType: 'application/msword', extension: '.doc' }),
  DOCX: Object.freeze({
    kind: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx'
  }),
  UNKNOWN: Object.freeze({ kind: 'unknown', mimeType: 'application/octet-stream', extension: '' })
});

function compact(value = '') {
  return String(value ?? '').trim();
}

function startsWith(buffer, signature) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= signature.length
    && buffer.subarray(0, signature.length).equals(signature);
}

function hasZipSignature(buffer) {
  return ZIP_SIGNATURES.some((signature) => startsWith(buffer, signature));
}

function looksLikeDocxArchive(buffer) {
  if (!hasZipSignature(buffer)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024 * 1024)).toString('latin1');
  return sample.includes('[Content_Types].xml')
    && (sample.includes('word/document.xml') || sample.includes('word/'));
}

function typeFromMime(mimeType = '') {
  const mime = compact(mimeType).toLowerCase();
  if (mime.includes('pdf')) return CV_DOCUMENT_TYPES.PDF;
  if (mime.includes('wordprocessingml.document')) return CV_DOCUMENT_TYPES.DOCX;
  if (mime === 'application/msword') return CV_DOCUMENT_TYPES.DOC;
  return CV_DOCUMENT_TYPES.UNKNOWN;
}

function typeFromExtension(fileName = '') {
  const extension = path.extname(compact(fileName)).toLowerCase();
  if (extension === '.pdf') return CV_DOCUMENT_TYPES.PDF;
  if (extension === '.docx') return CV_DOCUMENT_TYPES.DOCX;
  if (extension === '.doc') return CV_DOCUMENT_TYPES.DOC;
  return CV_DOCUMENT_TYPES.UNKNOWN;
}

function signatureType(buffer) {
  if (startsWith(buffer, PDF_SIGNATURE)) return CV_DOCUMENT_TYPES.PDF;
  if (startsWith(buffer, OLE_SIGNATURE)) return CV_DOCUMENT_TYPES.DOC;
  if (looksLikeDocxArchive(buffer)) return CV_DOCUMENT_TYPES.DOCX;
  return CV_DOCUMENT_TYPES.UNKNOWN;
}

export function detectCvDocumentMetadata(buffer, options = {}) {
  const bySignature = signatureType(buffer);
  const byMime = typeFromMime(options.mimeType);
  const byExtension = typeFromExtension(options.fileName);
  const byMetadata = byMime.kind !== 'unknown' ? byMime : byExtension;
  const detected = bySignature.kind !== 'unknown' ? bySignature : byMetadata;
  const declaredKinds = [byMime.kind, byExtension.kind].filter((kind) => kind !== 'unknown');

  return {
    ...detected,
    source: bySignature.kind !== 'unknown'
      ? 'signature'
      : (byMetadata.kind !== 'unknown' ? 'metadata' : 'unknown'),
    signatureKind: bySignature.kind,
    mimeKind: byMime.kind,
    extensionKind: byExtension.kind,
    metadataKind: byMetadata.kind,
    metadataConflict: byMime.kind !== 'unknown'
      && byExtension.kind !== 'unknown'
      && byMime.kind !== byExtension.kind,
    metadataMismatch: bySignature.kind !== 'unknown'
      && declaredKinds.some((kind) => kind !== bySignature.kind)
  };
}

function safeBaseName(value = '') {
  return compact(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["'`\\/<>:|?*]+/g, '-')
    .replace(/[^\x20-\x7e]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim()
    .replace(/^[. -]+|[. -]+$/g, '');
}

export function buildHeaderSafeCvFilename(fileName = '', detected = CV_DOCUMENT_TYPES.UNKNOWN) {
  const raw = compact(fileName).normalize('NFC') || 'hoja-de-vida';
  const currentExtension = path.extname(raw);
  const base = path.basename(raw, currentExtension);
  const safeBase = safeBaseName(base) || 'hoja-de-vida';
  const extension = detected?.extension || currentExtension.toLowerCase();
  return `${safeBase}${extension}`.slice(0, 180);
}

export function normalizeStoredCvFilename(fileName = '', detected = CV_DOCUMENT_TYPES.UNKNOWN) {
  const raw = compact(fileName).normalize('NFC') || 'hoja-de-vida';
  const currentExtension = path.extname(raw);
  const base = path.basename(raw, currentExtension)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '-')
    .trim() || 'hoja-de-vida';
  return `${base}${detected?.extension || currentExtension.toLowerCase()}`.slice(0, 220);
}

export function assessExtractedCvText(text = '') {
  const normalized = compact(text);
  if (!normalized) {
    return {
      useful: false,
      reason: 'empty',
      length: 0,
      wordCount: 0,
      alphanumericRatio: 0,
      replacementRatio: 0
    };
  }

  const characters = [...normalized];
  const alphanumeric = characters.filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  const replacements = characters.filter((character) => (
    character === '\uFFFD'
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(character)
  )).length;
  const words = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}._%+@/-]*/gu) || [];
  const alphanumericRatio = alphanumeric / characters.length;
  const replacementRatio = replacements / characters.length;
  const useful = normalized.length >= 80
    && words.length >= 12
    && alphanumericRatio >= 0.35
    && replacementRatio <= 0.02;

  return {
    useful,
    reason: useful ? 'useful' : 'low_quality',
    length: normalized.length,
    wordCount: words.length,
    alphanumericRatio,
    replacementRatio
  };
}
