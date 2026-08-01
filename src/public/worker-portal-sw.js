'use strict';

const PORTAL_PATH = '/operaciones/portal';
const PORTAL_CACHE_KEY = '/operaciones/portal';
const CACHE_NAME = 'lorren-worker-portal-shell-v7';
const STATIC_ASSETS = [
  '/operaciones/portal/offline.js',
  '/operaciones/portal/manifest.webmanifest',
  '/operaciones/portal/icon.svg',
  '/public/worker-biometric.js',
  '/public/worker-biometric-core.js',
  '/public/worker-biometric-mobile.js',
  '/public/worker-portal-biometric-flow.js',
  '/public/worker-portal-offline-v2.js',
  '/public/worker-portal-offline-controller.js'
];
const DB_NAME = 'lorren-worker-portal-v1';
const DB_VERSION = 1;
const QUEUE_STORE = 'arrivalQueue';
const RECEIPT_STORE = 'arrivalReceipts';
const SYNC_TAG = 'lorren-worker-arrivals';
const MAX_QUEUE_AGE_MS = 72 * 60 * 60 * 1000;
const MARK_TYPES = new Set(['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);
const MARK_ENDPOINTS = Object.freeze({
  ARRIVAL: 'llegada',
  BREAK_START: 'inicio-almuerzo',
  BREAK_END: 'fin-almuerzo',
  DEPARTURE: 'salida'
});

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error || new Error('indexeddb_request_failed')), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error || new Error('indexeddb_transaction_aborted')), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error || new Error('indexeddb_transaction_failed')), { once: true });
  });
}

function normalizeMarkType(value) {
  const normalized = String(value || 'ARRIVAL').trim().toUpperCase();
  return MARK_TYPES.has(normalized) ? normalized : 'ARRIVAL';
}

function normalizeRecord(record) {
  return { ...record, markType: normalizeMarkType(record?.markType) };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(QUEUE_STORE)) {
        const queue = database.createObjectStore(QUEUE_STORE, { keyPath: 'idempotencyKey' });
        queue.createIndex('assignmentId', 'assignmentId', { unique: false });
        queue.createIndex('queuedAt', 'queuedAt', { unique: false });
      }
      if (!database.objectStoreNames.contains(RECEIPT_STORE)) {
        const receipts = database.createObjectStore(RECEIPT_STORE, { keyPath: 'idempotencyKey' });
        receipts.createIndex('assignmentId', 'assignmentId', { unique: false });
        receipts.createIndex('completedAt', 'completedAt', { unique: false });
      }
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error || new Error('indexeddb_open_failed')), { once: true });
  });
}

async function readQueue() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(QUEUE_STORE, 'readonly');
    const records = await requestPromise(transaction.objectStore(QUEUE_STORE).getAll());
    await transactionDone(transaction);
    return (Array.isArray(records) ? records : []).map(normalizeRecord);
  } finally {
    database.close();
  }
}

async function putQueueRecord(record) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(QUEUE_STORE, 'readwrite');
    transaction.objectStore(QUEUE_STORE).put(record);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function completeQueueRecord(record, receipt) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([QUEUE_STORE, RECEIPT_STORE], 'readwrite');
    transaction.objectStore(QUEUE_STORE).delete(record.idempotencyKey);
    transaction.objectStore(RECEIPT_STORE).put({
      idempotencyKey: record.idempotencyKey,
      assignmentId: record.assignmentId,
      markType: record.markType,
      capturedAt: record.clientCapturedAt,
      queuedAt: record.queuedAt,
      completedAt: new Date().toISOString(),
      ...receipt
    });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage(message));
}

function offlineFallbackResponse() {
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Portal del Auxiliar · Lórren</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(100%,480px);background:#fff;border:1px solid #dfe4ea;border-radius:20px;padding:26px}h1{margin:0 0 10px}.status{margin-top:18px;padding:14px;border-radius:12px;background:#fff6df;color:#76520b;font-weight:700}</style></head><body><main class="card"><h1>Portal aún no preparado</h1><div class="status">Abre el portal una vez con conexión en este teléfono. Después podrás registrar la jornada sin internet.</div></main></body></html>`, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}

async function cacheActivePortal() {
  const response = await fetch(PORTAL_PATH, {
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'text/html' }
  });
  const mode = response.headers.get('X-Lorren-Worker-Portal-Mode');
  const cache = await caches.open(CACHE_NAME);
  if (response.ok && mode === 'active') {
    await cache.put(PORTAL_CACHE_KEY, response.clone());
    await notifyClients({ type: 'PORTAL_CACHED' });
    return true;
  }
  if (mode === 'inactive') await cache.delete(PORTAL_CACHE_KEY);
  return false;
}

async function networkFirstPortal(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    const mode = response.headers.get('X-Lorren-Worker-Portal-Mode');
    if (response.ok && mode === 'active') await cache.put(PORTAL_CACHE_KEY, response.clone());
    else if (mode === 'inactive') await cache.delete(PORTAL_CACHE_KEY);
    return response;
  } catch {
    return await cache.match(PORTAL_CACHE_KEY) || offlineFallbackResponse();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(new Request(new URL(request.url).pathname), response.clone());
  return response;
}

function buildMarkForm(record) {
  const form = new FormData();
  form.set('idempotencyKey', record.idempotencyKey);
  form.set('latitude', String(record.latitude));
  form.set('longitude', String(record.longitude));
  form.set('accuracyMeters', String(record.accuracyMeters));
  form.set('clientCapturedAt', record.clientCapturedAt);
  form.set('captureMode', 'OFFLINE_WEB');
  form.set('persistentStorageAvailable', record.persistentStorageAvailable === true ? 'true' : 'false');
  form.set('photoConsent', record.selfie && record.photoConsent ? 'true' : 'false');
  if (record.selfie instanceof Blob) {
    const extension = record.selfie.type === 'image/png' ? 'png' : record.selfie.type === 'image/webp' ? 'webp' : 'jpg';
    const label = MARK_ENDPOINTS[record.markType] || 'marcacion';
    form.set('selfie', record.selfie, `selfie-${label}-offline.${extension}`);
  }
  return form;
}

function terminalRejection(status, error) {
  if (status === 400 || status === 404) return true;
  return status === 409 && [
    'arrival_already_registered',
    'arrival_window_not_open',
    'departure_already_registered',
    'departure_arrival_required',
    'departure_before_arrival',
    'departure_break_end_required',
    'break_arrival_required',
    'break_after_departure',
    'break_already_started',
    'break_start_required',
    'break_already_completed',
    'break_end_before_start',
    'offline_capture_expired',
    'assignment_not_available',
    'attendance_not_enabled',
    'outside_operation_range',
    'operation_geofence_required',
    'location_accuracy_insufficient',
    'biometric_verification_required'
  ].includes(error);
}

function isAlreadyRecorded(error) {
  return [
    'arrival_already_registered',
    'departure_already_registered',
    'break_already_started',
    'break_already_completed'
  ].includes(error);
}

async function syncRecord(rawRecord) {
  const record = normalizeRecord(rawRecord);
  const queuedAt = new Date(record.queuedAt || 0).getTime();
  if (!Number.isFinite(queuedAt) || Date.now() - queuedAt > MAX_QUEUE_AGE_MS) {
    await completeQueueRecord(record, {
      state: 'REJECTED',
      error: 'offline_capture_expired',
      message: 'La marcación offline venció antes de sincronizarse.'
    });
    await notifyClients({
      type: 'ARRIVAL_SYNC_REJECTED',
      assignmentId: record.assignmentId,
      markType: record.markType,
      error: 'offline_capture_expired'
    });
    return { retry: false, sessionRequired: false, blockAssignment: true };
  }

  const inProgress = {
    ...record,
    state: 'SYNCING',
    attempts: Number(record.attempts || 0) + 1,
    updatedAt: new Date().toISOString(),
    lastError: null
  };
  await putQueueRecord(inProgress);
  await notifyClients({
    type: 'ARRIVAL_QUEUE_UPDATED',
    assignmentId: record.assignmentId,
    markType: record.markType,
    state: 'SYNCING'
  });

  const endpoint = MARK_ENDPOINTS[record.markType];
  let response;
  try {
    response = await fetch(`${PORTAL_PATH}/asignaciones/${encodeURIComponent(record.assignmentId)}/${endpoint}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'worker-portal' },
      body: buildMarkForm(record)
    });
  } catch (error) {
    await putQueueRecord({
      ...inProgress,
      state: 'PENDING',
      lastError: 'network_unavailable',
      updatedAt: new Date().toISOString()
    });
    await notifyClients({
      type: 'ARRIVAL_SYNC_RETRY',
      assignmentId: record.assignmentId,
      markType: record.markType,
      error: 'network_unavailable'
    });
    return { retry: true, sessionRequired: false, blockAssignment: true, error };
  }

  const payload = await response.json().catch(() => ({}));
  if (response.ok && payload.ok) {
    const state = payload.requiresReview ? 'REVIEW_REQUIRED' : 'SYNCED';
    await completeQueueRecord(record, {
      state,
      validationStatus: payload.validationStatus || null,
      attendanceStatus: payload.attendanceStatus || null,
      punctualityStatus: payload.punctualityStatus || null,
      workedMinutes: payload.workedMinutes ?? null,
      message: payload.message || 'Marcación sincronizada.'
    });
    await notifyClients({
      type: 'ARRIVAL_SYNCED',
      assignmentId: record.assignmentId,
      markType: record.markType,
      state,
      payload
    });
    return { retry: false, sessionRequired: false, blockAssignment: false };
  }

  if (response.status === 401) {
    await putQueueRecord({
      ...inProgress,
      state: 'SESSION_REQUIRED',
      lastError: payload.error || 'portal_session_required',
      updatedAt: new Date().toISOString()
    });
    await notifyClients({
      type: 'ARRIVAL_SYNC_RETRY',
      assignmentId: record.assignmentId,
      markType: record.markType,
      error: 'portal_session_required'
    });
    return { retry: false, sessionRequired: true, blockAssignment: true };
  }

  if (terminalRejection(response.status, payload.error)) {
    const alreadyRecorded = isAlreadyRecorded(payload.error);
    await completeQueueRecord(record, {
      state: alreadyRecorded ? 'ALREADY_RECORDED' : 'REJECTED',
      error: payload.error || 'mark_rejected',
      message: alreadyRecorded
        ? 'La marcación ya estaba registrada en Lórren.'
        : 'La marcación offline fue rechazada por el servidor.'
    });
    await notifyClients({
      type: 'ARRIVAL_SYNC_REJECTED',
      assignmentId: record.assignmentId,
      markType: record.markType,
      error: payload.error || 'mark_rejected'
    });
    return { retry: false, sessionRequired: false, blockAssignment: !alreadyRecorded };
  }

  await putQueueRecord({
    ...inProgress,
    state: 'PENDING',
    lastError: payload.error || `http_${response.status}`,
    updatedAt: new Date().toISOString()
  });
  await notifyClients({
    type: 'ARRIVAL_SYNC_RETRY',
    assignmentId: record.assignmentId,
    markType: record.markType,
    error: payload.error || `http_${response.status}`
  });
  return { retry: response.status >= 500, sessionRequired: false, blockAssignment: true };
}

async function syncQueue({ throwOnRetry = false } = {}) {
  const records = (await readQueue()).sort((left, right) => String(left.queuedAt).localeCompare(String(right.queuedAt)));
  const blockedAssignments = new Set();
  let shouldRetry = false;
  for (const record of records) {
    const assignmentId = String(record.assignmentId || '');
    if (blockedAssignments.has(assignmentId)) continue;
    const result = await syncRecord(record);
    shouldRetry = shouldRetry || result.retry;
    if (result.blockAssignment) blockedAssignments.add(assignmentId);
    if (result.sessionRequired) break;
  }
  if (throwOnRetry && shouldRetry) throw new Error('arrival_sync_retry_required');
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then((cache) => cache.addAll(STATIC_ASSETS))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((names) => Promise.all(
      names
        .filter((name) => name.startsWith('lorren-worker-portal-') && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    )),
    self.clients.claim()
  ]));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && (url.pathname === PORTAL_PATH || url.pathname === `${PORTAL_PATH}/`)) {
    event.respondWith(networkFirstPortal(request));
    return;
  }
  if (STATIC_ASSETS.includes(url.pathname)) event.respondWith(cacheFirst(request));
});

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(syncQueue({ throwOnRetry: true }));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SYNC_ARRIVALS') {
    event.waitUntil(syncQueue().catch(() => {}));
    return;
  }
  if (event.data?.type === 'CACHE_PORTAL') event.waitUntil(cacheActivePortal().catch(() => false));
});
