import path from 'node:path';
import crypto from 'node:crypto';
import {
  uploadBufferToR2,
  downloadBufferFromR2,
  deleteObjectFromR2,
  isStorageConfigured
} from './storage.js';
import {
  buildHeaderSafeCvFilename,
  detectCvDocumentMetadata,
  normalizeStoredCvFilename
} from './cvDocumentMetadata.js';

function sanitizeNamePart(value = '') {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'file';
}

function normalizeResolvedCandidateMetadata(candidate, buffer) {
  if (!candidate || !Buffer.isBuffer(buffer)) return null;
  const detected = detectCvDocumentMetadata(buffer, {
    mimeType: candidate.cvMimeType,
    fileName: candidate.cvOriginalName
  });

  if (detected.kind !== 'unknown') {
    candidate.cvMimeType = detected.mimeType;
    candidate.cvOriginalName = buildHeaderSafeCvFilename(candidate.cvOriginalName, detected);
  } else if (candidate.cvOriginalName) {
    candidate.cvOriginalName = buildHeaderSafeCvFilename(candidate.cvOriginalName, detected);
  }

  Object.defineProperty(candidate, 'cvResolvedMetadata', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: detected
  });
  return detected;
}

export function candidateHasStoredCv(candidate = {}) {
  return Boolean(candidate.cvStorageKey || candidate.cvData || candidate.cvOriginalName || candidate.cvMimeType);
}

export function buildCandidateCvStorageKey(candidateId, originalName = 'hoja_de_vida') {
  const ext = path.extname(originalName || '').toLowerCase() || '.bin';
  const base = sanitizeNamePart(path.basename(originalName || 'hoja_de_vida', ext));
  const suffix = crypto.randomBytes(6).toString('hex');
  return `candidates/${candidateId}/cv/${Date.now()}-${suffix}-${base}${ext}`;
}

export async function storeCandidateCv(prisma, candidateId, buffer, options = {}) {
  const detected = detectCvDocumentMetadata(buffer, {
    mimeType: options.mimeType,
    fileName: options.originalName
  });
  const originalName = normalizeStoredCvFilename(options.originalName || 'hoja_de_vida', detected);
  const mimeType = detected.kind === 'unknown'
    ? (options.mimeType || 'application/octet-stream')
    : detected.mimeType;
  const currentCvStorageKey = options.currentCvStorageKey || null;

  if (!isStorageConfigured()) {
    return prisma.candidate.update({
      where: { id: candidateId },
      data: {
        cvData: buffer,
        cvMimeType: mimeType,
        cvOriginalName: originalName
      }
    });
  }

  const storageKey = buildCandidateCvStorageKey(candidateId, originalName);
  await uploadBufferToR2(storageKey, buffer, mimeType);

  const updatedCandidate = await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      cvStorageKey: storageKey,
      cvData: null,
      cvMimeType: mimeType,
      cvOriginalName: originalName
    }
  });

  if (currentCvStorageKey && currentCvStorageKey !== storageKey) {
    await deleteObjectFromR2(currentCvStorageKey).catch((error) => {
      console.warn('[CV_STORAGE_DELETE_OLD_FAILED]', {
        candidateId,
        currentCvStorageKey,
        error: error?.message || error
      });
    });
  }

  return updatedCandidate;
}

export async function resolveCandidateCvBuffer(candidate) {
  if (!candidate) return null;

  let buffer = null;
  if (candidate.cvStorageKey && isStorageConfigured()) {
    buffer = await downloadBufferFromR2(candidate.cvStorageKey);
  } else if (candidate.cvData) {
    buffer = Buffer.isBuffer(candidate.cvData) ? candidate.cvData : Buffer.from(candidate.cvData);
  }

  if (buffer) normalizeResolvedCandidateMetadata(candidate, buffer);
  return buffer;
}

export async function clearCandidateCvStorage(candidate = {}) {
  if (candidate.cvStorageKey) {
    await deleteObjectFromR2(candidate.cvStorageKey).catch((error) => {
      console.warn('[CV_STORAGE_DELETE_FAILED]', {
        candidateId: candidate.id,
        cvStorageKey: candidate.cvStorageKey,
        error: error?.message || error
      });
    });
  }
}
