import { isStorageConfigured } from './storage.js';
import { storeCandidateCv } from './cvStorage.js';

function normalizeBinaryData(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isTransientDatabaseAvailabilityError(error) {
  if (!error) return false;
  if (error.code === 'P1001') return true;

  const message = String(error.message || error).toLowerCase();
  return [
    'the database system is starting up',
    'the database system is not yet accepting connections',
    'consistent recovery state has not been yet reached',
    "can't reach database server",
    'failed to connect to postgres'
  ].some((snippet) => message.includes(snippet));
}

export async function loadPendingCvMigrationCount(prisma) {
  return prisma.candidate.count({
    where: {
      cvData: { not: null },
      cvStorageKey: null
    }
  });
}

export async function migrateCandidateCvBatch(prisma, limit = 20) {
  const candidates = await prisma.candidate.findMany({
    where: {
      cvData: { not: null },
      cvStorageKey: null
    },
    select: {
      id: true,
      cvData: true,
      cvMimeType: true,
      cvOriginalName: true
    },
    take: limit,
    orderBy: { createdAt: 'asc' }
  });

  let migrated = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      await storeCandidateCv(prisma, candidate.id, normalizeBinaryData(candidate.cvData), {
        mimeType: candidate.cvMimeType || 'application/octet-stream',
        originalName: candidate.cvOriginalName || 'hoja_de_vida'
      });
      migrated += 1;
    } catch (error) {
      if (isTransientDatabaseAvailabilityError(error)) {
        console.error('[CV_STORAGE_MIGRATION_INTERRUPTED_DB_UNAVAILABLE]', candidate.id, error);
        return { found: candidates.length, migrated, failed, interrupted: true };
      }
      failed += 1;
      console.error('[CV_STORAGE_MIGRATION_FAILED]', candidate.id, error);
    }
  }

  return { found: candidates.length, migrated, failed, interrupted: false };
}

let autoCvMigrationInFlight = false;

export async function runAutoCvMigration(prisma, options = {}) {
  const enabled = options.enabled ?? (process.env.AUTO_CV_MIGRATION_ENABLED !== 'false');
  if (!enabled) {
    return { skipped: 'disabled' };
  }
  if (!isStorageConfigured()) {
    return { skipped: 'storage_not_configured' };
  }
  if (autoCvMigrationInFlight) {
    return { skipped: 'in_flight' };
  }

  const threshold = parsePositiveInt(options.threshold ?? process.env.AUTO_CV_MIGRATION_THRESHOLD, 50);
  const batchSize = parsePositiveInt(options.batchSize ?? process.env.AUTO_CV_MIGRATION_BATCH_SIZE, 20);

  const pendingCount = await loadPendingCvMigrationCount(prisma);
  if (pendingCount < threshold) {
    return { skipped: 'below_threshold', pendingCount, threshold, batchSize };
  }

  autoCvMigrationInFlight = true;
  try {
    const result = await migrateCandidateCvBatch(prisma, batchSize);
    return {
      ...result,
      pendingCount,
      threshold,
      batchSize,
      triggered: true
    };
  } finally {
    autoCvMigrationInFlight = false;
  }
}
