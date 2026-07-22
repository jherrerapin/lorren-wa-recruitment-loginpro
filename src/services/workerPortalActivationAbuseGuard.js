const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_MAX_ENTRIES = 5_000;
const MAX_KEY_LENGTH = 200;

function requirePositiveInteger(value, fieldName) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${fieldName}_invalid`);
  }
  return normalized;
}

function normalizeAttemptKey(value) {
  const normalized = String(value || '').trim();
  return (normalized || 'unknown').slice(0, MAX_KEY_LENGTH);
}

function requireNow(nowFn) {
  const now = Number(nowFn());
  if (!Number.isFinite(now) || now < 0) {
    throw new Error('worker_portal_activation_guard_now_invalid');
  }
  return now;
}

export function createWorkerPortalActivationAbuseGuard({
  windowMs = DEFAULT_WINDOW_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  nowFn = Date.now
} = {}) {
  const normalizedWindowMs = requirePositiveInteger(windowMs, 'worker_portal_activation_guard_window_ms');
  const normalizedMaxAttempts = requirePositiveInteger(maxAttempts, 'worker_portal_activation_guard_max_attempts');
  const normalizedMaxEntries = requirePositiveInteger(maxEntries, 'worker_portal_activation_guard_max_entries');
  if (typeof nowFn !== 'function') throw new Error('worker_portal_activation_guard_now_fn_required');

  const attempts = new Map();

  function pruneExpired(now) {
    for (const [key, bucket] of attempts.entries()) {
      if (bucket.resetAt <= now) attempts.delete(key);
    }
  }

  function evictOldestEntry() {
    let oldestKey = null;
    let oldestSeenAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of attempts.entries()) {
      if (bucket.lastSeenAt < oldestSeenAt) {
        oldestKey = key;
        oldestSeenAt = bucket.lastSeenAt;
      }
    }
    if (oldestKey !== null) attempts.delete(oldestKey);
  }

  function consume(rawKey) {
    const now = requireNow(nowFn);
    const key = normalizeAttemptKey(rawKey);
    pruneExpired(now);

    let bucket = attempts.get(key);
    if (!bucket) {
      while (attempts.size >= normalizedMaxEntries) evictOldestEntry();
      bucket = {
        count: 0,
        resetAt: now + normalizedWindowMs,
        lastSeenAt: now
      };
      attempts.set(key, bucket);
    }

    bucket.count += 1;
    bucket.lastSeenAt = now;

    return {
      allowed: bucket.count <= normalizedMaxAttempts,
      remaining: Math.max(0, normalizedMaxAttempts - bucket.count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      resetAt: bucket.resetAt
    };
  }

  return Object.freeze({
    consume,
    getSize: () => attempts.size,
    hasKey: (rawKey) => attempts.has(normalizeAttemptKey(rawKey))
  });
}

export const WORKER_PORTAL_ACTIVATION_GUARD_DEFAULTS = Object.freeze({
  windowMs: DEFAULT_WINDOW_MS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  maxEntries: DEFAULT_MAX_ENTRIES
});
