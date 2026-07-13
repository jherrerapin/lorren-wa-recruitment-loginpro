import { isCvMimeTypeAllowed } from './cvFlow.js';
import { fetchMediaMetadata, downloadMedia } from './media.js';
import { storeCandidateCv } from './cvStorage.js';

export function isSupportedGatedCvDocument(message = {}) {
  if (message?.type !== 'document') return false;
  const document = message.document || {};
  if (!document.id) return false;
  return isCvMimeTypeAllowed(document.mime_type || '', document.filename || 'hoja_de_vida');
}

export async function captureGatedCvDocument({
  prisma,
  candidateId,
  message,
  fetchMetadata = fetchMediaMetadata,
  download = downloadMedia,
  storeCv = storeCandidateCv
} = {}) {
  if (!prisma?.candidate?.findUnique || !candidateId) {
    return { captured: false, reason: 'candidate_not_ready' };
  }
  if (!isSupportedGatedCvDocument(message)) {
    return { captured: false, reason: 'unsupported_document' };
  }

  const document = message.document || {};
  const filename = document.filename || 'hoja_de_vida';
  const mimeType = document.mime_type || 'application/octet-stream';
  const currentCandidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { cvStorageKey: true }
  });
  if (!currentCandidate) return { captured: false, reason: 'candidate_not_found' };

  const metadata = await fetchMetadata(document.id);
  if (!metadata?.url) return { captured: false, reason: 'media_url_missing' };
  const buffer = await download(metadata.url);
  if (!buffer || buffer.length === 0) {
    return { captured: false, reason: 'download_failed' };
  }

  await storeCv(prisma, candidateId, buffer, {
    mimeType,
    originalName: filename,
    currentCvStorageKey: currentCandidate.cvStorageKey || null
  });

  return {
    captured: true,
    reason: 'cv_saved_during_gate',
    filename,
    mimeType,
    sizeBytes: buffer.length
  };
}
