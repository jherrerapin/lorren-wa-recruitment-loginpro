import { deleteObjectFromR2, isStorageConfigured, uploadBufferToR2 } from './storage.js';

const MAX_ATTENDANCE_EVIDENCE_BYTES = 3 * 1024 * 1024;
const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
});
const MARK_PATHS = Object.freeze({ ARRIVAL: 'arrival', DEPARTURE: 'departure' });

function requireSafeIdentifier(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}_required`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(normalized)) throw new Error(`${label}_invalid`);
  return normalized;
}

function normalizeEvidenceFile(file) {
  if (!file) return null;
  if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new Error('attendance_evidence_file_invalid');
  }
  if (file.buffer.length > MAX_ATTENDANCE_EVIDENCE_BYTES) {
    throw new Error('attendance_evidence_file_too_large');
  }
  const mimeType = typeof file.mimetype === 'string' ? file.mimetype.toLowerCase() : '';
  const extension = MIME_EXTENSIONS[mimeType];
  if (!extension) throw new Error('attendance_evidence_mime_not_allowed');
  return { buffer: file.buffer, mimeType, extension };
}

function normalizeMarkType(value) {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : 'ARRIVAL';
  if (!MARK_PATHS[normalized]) throw new Error('attendance_evidence_mark_type_invalid');
  return normalized;
}

export function buildAttendanceEvidenceStorageKey(input = {}) {
  const workerId = requireSafeIdentifier(input.workerId, 'attendance_evidence_worker_id');
  const assignmentId = requireSafeIdentifier(input.assignmentId, 'attendance_evidence_assignment_id');
  const idempotencyKey = requireSafeIdentifier(input.idempotencyKey, 'attendance_evidence_idempotency_key');
  const extension = requireSafeIdentifier(input.extension, 'attendance_evidence_extension');
  const markType = normalizeMarkType(input.markType);
  return `attendance/${workerId}/${assignmentId}/${MARK_PATHS[markType]}/${idempotencyKey}.${extension}`;
}

function isObjectAlreadyPresentError(error) {
  return error?.$metadata?.httpStatusCode === 412
    || error?.name === 'PreconditionFailed'
    || error?.Code === 'PreconditionFailed';
}

export async function storeAttendanceEvidence(input = {}) {
  const file = normalizeEvidenceFile(input.file);
  if (!file) return { storageKey: null, mimeType: null, created: false };
  if (!isStorageConfigured()) throw new Error('attendance_evidence_storage_unavailable');

  const storageKey = buildAttendanceEvidenceStorageKey({
    workerId: input.workerId,
    assignmentId: input.assignmentId,
    idempotencyKey: input.idempotencyKey,
    extension: file.extension,
    markType: input.markType
  });

  try {
    await uploadBufferToR2(storageKey, file.buffer, file.mimeType, { ifNoneMatch: '*' });
    return { storageKey, mimeType: file.mimeType, created: true };
  } catch (error) {
    if (isObjectAlreadyPresentError(error)) {
      return { storageKey, mimeType: file.mimeType, created: false };
    }
    throw error;
  }
}

export function storeAttendanceArrivalEvidence(input = {}) {
  return storeAttendanceEvidence({ ...input, markType: 'ARRIVAL' });
}

export function storeAttendanceDepartureEvidence(input = {}) {
  return storeAttendanceEvidence({ ...input, markType: 'DEPARTURE' });
}

export async function discardAttendanceEvidence(evidence) {
  if (!evidence?.created || !evidence.storageKey) return;
  await deleteObjectFromR2(evidence.storageKey);
}

export const discardAttendanceArrivalEvidence = discardAttendanceEvidence;
export const discardAttendanceDepartureEvidence = discardAttendanceEvidence;

export { MAX_ATTENDANCE_EVIDENCE_BYTES };
