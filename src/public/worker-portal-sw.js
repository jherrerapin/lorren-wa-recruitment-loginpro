'use strict';

const PORTAL_PATH = '/operaciones/portal';
const PORTAL_CACHE_KEY = '/operaciones/portal';
const CACHE_NAME = 'lorren-worker-portal-shell-v5';
const STATIC_ASSETS = [
  '/operaciones/portal/offline.js',
  '/operaciones/portal/manifest.webmanifest',
  '/operaciones/portal/icon.svg'
];
const DB_NAME = 'lorren-worker-portal-v1';
const DB_VERSION = 1;
const QUEUE_STORE = 'arrivalQueue';
const RECEIPT_STORE = 'arrivalReceipts';
const SYNC_TAG = 'lorren-worker-arrivals';
const MAX_QUEUE_AGE_MS = 72 * 60 * 60 * 1000;

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

function normalizeLegacyRecord(record) {
  return { ...record, markType: record?.markType === 'DEPARTURE' ? 'DEPARTURE' : 'ARRIVAL' };
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
    return (Array.isArray(records) ? records : []).map(normalizeLegacyRecord);
  } finally { database.close(); }
}

async function putQueueRecord(record) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(QUEUE_STORE, 'readwrite');
    transaction.objectStore(QUEUE_STORE).put(record);
    await transactionDone(transaction);
  } finally { database.close(); }
}

async function completeQueueRecord(record, receipt) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([QUEUE_STORE, RECEIPT_STORE], 'readwrite');
    transaction.objectStore(QUEUE_STORE).delete(record.idempotencyKey);
    transaction.objectStore(RECEIPT_STORE).put({
      idempotencyKey: record.idempotencyKey,
      assignmentId: record.assignmentId,
      markType: record.markType || 'ARRIVAL',
      capturedAt: record.clientCapturedAt,
      queuedAt: record.queuedAt,
      completedAt: new Date().toISOString(),
      ...receipt
    });
    await transactionDone(transaction);
  } finally { database.close(); }
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage(message));
}

function offlineFallbackResponse() {
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Portal del Auxiliar · Lórren</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(100%,480px);background:#fff;border:1px solid #dfe4ea;border-radius:20px;padding:26px}h1{margin:0 0 10px}p{color:#4d5b69;line-height:1.55}.status{margin-top:18px;padding:14px;border-radius:12px;background:#fff6df;color:#76520b;font-weight:700}</style></head><body><main class="card"><h1>Sin conexión</h1><div class="status">La asistencia requiere conexión.</div></main></body></html>`, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}

async function cacheActivePortal() {
  const response = await fetch(PORTAL_PATH, { credentials: 'include', cache: 'no-store', headers: { Accept: 'text/html' } });
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
  } catch { return await cache.match(PORTAL_CACHE_KEY) || offlineFallbackResponse(); }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

function buildArrivalForm(record) {
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
    const label = record.markType === 'DEPARTURE' ? 'salida' : 'llegada';
    form.set('selfie', record.selfie, `selfie-${label}-offline.${extension}`);
  }
  return form;
}

function endpointFor(record) {
  return record.markType === 'DEPARTURE'
    ? `${PORTAL_PATH}/asignaciones/${encodeURIComponent(record.assignmentId)}/salida`
    : `${PORTAL_PATH}/asignaciones/${encodeURIComponent(record.assignmentId)}/llegada`;
}

async function syncRecord(record) {
  const age = Date.now() - new Date(record.queuedAt).getTime();
  if (!Number.isFinite(age) || age > MAX_QUEUE_AGE_MS) {
    await completeQueueRecord(record, { ok: false, status: 'EXPIRED' });
    await notifyClients({ type: 'ARRIVAL_SYNC_REJECTED', idempotencyKey: record.idempotencyKey, error: 'offline_capture_expired' });
    return;
  }
  const response = await fetch(endpointFor(record), {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Requested-With': 'worker-portal' },
    body: buildArrivalForm(record)
  });
  const payload = await response.json().catch(() => ({}));
  if (response.ok && payload.ok) {
    await completeQueueRecord(record, { ok: true, status: payload.validationStatus || 'RECORDED', replayed: Boolean(payload.replayed) });
    await notifyClients({ type: 'ARRIVAL_SYNCED', idempotencyKey: record.idempotencyKey, assignmentId: record.assignmentId, markType: record.markType, payload });
    return;
  }
  const terminal = [400, 401, 403, 404, 409].includes(response.status);
  if (terminal) {
    await completeQueueRecord(record, { ok: false, status: 'REJECTED', error: payload.error || 'sync_rejected' });
    await notifyClients({ type: 'ARRIVAL_SYNC_REJECTED', idempotencyKey: record.idempotencyKey, error: payload.error || 'sync_rejected' });
    return;
  }
  record.attempts = Number(record.attempts || 0) + 1;
  record.lastError = payload.error || `http_${response.status}`;
  record.updatedAt = new Date().toISOString();
  await putQueueRecord(record);
  await notifyClients({ type: 'ARRIVAL_SYNC_RETRY', idempotencyKey: record.idempotencyKey, error: record.lastError });
  throw new Error(record.lastError);
}

async function syncQueue() {
  const queue = await readQueue();
  for (const record of queue) {
    try { await syncRecord(record); } catch { break; }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('lorren-worker-portal-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
  ]));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname === PORTAL_PATH) {
    event.respondWith(networkFirstPortal(event.request));
    return;
  }
  if (STATIC_ASSETS.includes(url.pathname)) event.respondWith(cacheFirst(event.request));
});
self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(syncQueue());
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SYNC_ARRIVALS') event.waitUntil(syncQueue());
  if (event.data?.type === 'CACHE_PORTAL') event.waitUntil(cacheActivePortal());
});
