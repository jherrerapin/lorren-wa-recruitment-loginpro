import crypto from 'node:crypto';

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 100;
const snapshots = new Map();

function compact(value = '') {
  return String(value ?? '').trim();
}

function cleanup(now = Date.now()) {
  for (const [token, entry] of snapshots.entries()) {
    if (entry.expiresAt <= now) snapshots.delete(token);
  }
  if (snapshots.size <= MAX_ENTRIES) return;
  const oldest = [...snapshots.entries()]
    .sort((left, right) => left[1].createdAt - right[1].createdAt)
    .slice(0, snapshots.size - MAX_ENTRIES);
  oldest.forEach(([token]) => snapshots.delete(token));
}

export function getCvReviewExportOwnerKey(req = {}) {
  return compact(req.sessionID)
    || compact(req.session?.user?.id)
    || compact(req.session?.userId)
    || compact(req.user?.id)
    || null;
}

export function storeCvReviewExportSnapshot(snapshot, { ownerKey } = {}) {
  const normalizedOwnerKey = compact(ownerKey);
  if (!normalizedOwnerKey) throw new TypeError('cv_review_export_owner_required');
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('cv_review_export_snapshot_required');
  cleanup();
  const token = crypto.randomUUID();
  const createdAt = Date.now();
  snapshots.set(token, {
    ownerKey: normalizedOwnerKey,
    snapshot,
    createdAt,
    expiresAt: createdAt + TTL_MS
  });
  cleanup(createdAt);
  return token;
}

export function loadCvReviewExportSnapshot(token, { ownerKey } = {}) {
  cleanup();
  const normalizedToken = compact(token);
  const normalizedOwnerKey = compact(ownerKey);
  if (!normalizedToken || !normalizedOwnerKey) return null;
  const entry = snapshots.get(normalizedToken);
  if (!entry || entry.ownerKey !== normalizedOwnerKey) return null;
  return entry.snapshot;
}

export function removeCvReviewExportSnapshot(token, { ownerKey } = {}) {
  const normalizedToken = compact(token);
  const normalizedOwnerKey = compact(ownerKey);
  const entry = snapshots.get(normalizedToken);
  if (!entry || entry.ownerKey !== normalizedOwnerKey) return false;
  return snapshots.delete(token);
}

export const CV_REVIEW_EXPORT_TTL_MS = TTL_MS;
