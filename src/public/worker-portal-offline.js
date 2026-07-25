(() => {
  'use strict';

  const DB_NAME = 'lorren-worker-portal-v1';
  const DB_VERSION = 1;
  const QUEUE_STORE = 'arrivalQueue';
  const RECEIPT_STORE = 'arrivalReceipts';
  const SYNC_TAG = 'lorren-worker-arrivals';
  const MAX_SELFIE_BYTES = 3 * 1024 * 1024;
  const MAX_QUEUE_AGE_MS = 72 * 60 * 60 * 1000;
  const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const MARK_TYPES = new Set(['ARRIVAL', 'DEPARTURE']);
  let serviceWorkerRegistration = null;
  let stateListener = null;

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
    return { ...record, markType: MARK_TYPES.has(record?.markType) ? record.markType : 'ARRIVAL' };
  }

  function openDatabase() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('indexeddb_unavailable'));
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
      request.addEventListener('blocked', () => reject(new Error('indexeddb_upgrade_blocked')), { once: true });
    });
  }

  async function readAll(storeName) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, 'readonly');
      const result = await requestPromise(transaction.objectStore(storeName).getAll());
      await transactionDone(transaction);
      return (Array.isArray(result) ? result : []).map(normalizeLegacyRecord);
    } finally { database.close(); }
  }

  async function putRecord(storeName, record) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(record);
      await transactionDone(transaction);
      return record;
    } finally { database.close(); }
  }

  async function deleteRecord(storeName, key) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).delete(key);
      await transactionDone(transaction);
    } finally { database.close(); }
  }

  async function cleanupExpiredLocalData() {
    const now = Date.now();
    const [queue, receipts] = await Promise.all([readAll(QUEUE_STORE), readAll(RECEIPT_STORE)]);
    await Promise.all([
      ...queue.filter((record) => now - new Date(record.queuedAt || 0).getTime() > MAX_QUEUE_AGE_MS).map((record) => deleteRecord(QUEUE_STORE, record.idempotencyKey)),
      ...receipts.filter((record) => now - new Date(record.completedAt || 0).getTime() > 30 * 24 * 60 * 60 * 1000).map((record) => deleteRecord(RECEIPT_STORE, record.idempotencyKey))
    ]);
  }

  function validateQueuePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('offline_mark_payload_invalid');
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(String(payload.idempotencyKey || ''))) throw new Error('offline_mark_idempotency_invalid');
    if (!String(payload.assignmentId || '').trim()) throw new Error('offline_mark_assignment_invalid');
    const markType = String(payload.markType || 'ARRIVAL').toUpperCase();
    if (!MARK_TYPES.has(markType)) throw new Error('offline_mark_type_invalid');
    for (const [field, min, max] of [['latitude', -90, 90], ['longitude', -180, 180], ['accuracyMeters', 0, 100000]]) {
      const value = Number(payload[field]);
      if (!Number.isFinite(value) || value < min || value > max) throw new Error(`offline_mark_${field}_invalid`);
    }
    if (Number.isNaN(new Date(payload.clientCapturedAt).getTime())) throw new Error('offline_mark_captured_at_invalid');
    if (payload.selfie) {
      if (!(payload.selfie instanceof Blob) || !ALLOWED_IMAGE_TYPES.has(payload.selfie.type) || payload.selfie.size > MAX_SELFIE_BYTES) throw new Error('offline_mark_selfie_invalid');
      if (payload.photoConsent !== true) throw new Error('offline_mark_photo_consent_required');
    }
    return markType;
  }

  async function requestPersistentStorage() {
    if (!navigator.storage?.persist) return false;
    try { return await navigator.storage.persist(); } catch { return false; }
  }

  function postToServiceWorker(message) {
    const target = serviceWorkerRegistration?.active || serviceWorkerRegistration?.waiting || navigator.serviceWorker?.controller;
    target?.postMessage(message);
  }

  async function registerBackgroundSync() {
    const registration = serviceWorkerRegistration || await navigator.serviceWorker?.ready;
    if (!registration) return false;
    serviceWorkerRegistration = registration;
    if ('sync' in registration) {
      try { await registration.sync.register(SYNC_TAG); return true; } catch { /* fallback below */ }
    }
    postToServiceWorker({ type: 'SYNC_ARRIVALS' });
    return false;
  }

  async function queueMark(payload) {
    const markType = validateQueuePayload(payload);
    const persistentStorageAvailable = await requestPersistentStorage();
    const now = new Date().toISOString();
    const record = {
      idempotencyKey: payload.idempotencyKey,
      assignmentId: String(payload.assignmentId),
      markType,
      latitude: Number(payload.latitude),
      longitude: Number(payload.longitude),
      accuracyMeters: Number(payload.accuracyMeters),
      clientCapturedAt: new Date(payload.clientCapturedAt).toISOString(),
      photoConsent: payload.photoConsent === true,
      selfie: payload.selfie || null,
      captureMode: 'OFFLINE_WEB',
      persistentStorageAvailable,
      queuedAt: now,
      updatedAt: now,
      attempts: 0,
      state: 'PENDING',
      lastError: null
    };
    await putRecord(QUEUE_STORE, record);
    await registerBackgroundSync();
    await emitState();
    return record;
  }

  function queueArrival(payload) {
    return queueMark({ ...payload, markType: 'ARRIVAL' });
  }

  function queueDeparture(payload) {
    return queueMark({ ...payload, markType: 'DEPARTURE' });
  }

  async function getState() {
    const [queue, receipts] = await Promise.all([readAll(QUEUE_STORE), readAll(RECEIPT_STORE)]);
    return {
      queue: queue.sort((left, right) => String(left.queuedAt).localeCompare(String(right.queuedAt))),
      receipts: receipts.sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))
    };
  }

  async function emitState(extra = {}) {
    if (typeof stateListener !== 'function') return;
    try { stateListener({ ...(await getState()), online: navigator.onLine, ...extra }); }
    catch (error) { stateListener({ queue: [], receipts: [], online: navigator.onLine, error: error?.message || 'offline_state_failed', ...extra }); }
  }

  async function syncNow() {
    await registerBackgroundSync();
    postToServiceWorker({ type: 'SYNC_ARRIVALS' });
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    serviceWorkerRegistration = await navigator.serviceWorker.register('/operaciones/portal/service-worker.js', { scope: '/operaciones/portal' });
    serviceWorkerRegistration = await navigator.serviceWorker.ready;
    postToServiceWorker({ type: 'CACHE_PORTAL' });
    return serviceWorkerRegistration;
  }

  function handleServiceWorkerMessage(event) {
    const message = event?.data;
    if (!message || typeof message !== 'object') return;
    if (['ARRIVAL_QUEUE_UPDATED', 'ARRIVAL_SYNCED', 'ARRIVAL_SYNC_REJECTED', 'ARRIVAL_SYNC_RETRY', 'PORTAL_CACHED'].includes(message.type)) emitState({ event: message });
  }

  async function init(options = {}) {
    stateListener = typeof options.onStateChange === 'function' ? options.onStateChange : null;
    await cleanupExpiredLocalData().catch(() => {});
    await registerServiceWorker().catch(() => null);
    navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);
    window.addEventListener('online', () => { emitState(); postToServiceWorker({ type: 'CACHE_PORTAL' }); syncNow().catch(() => {}); });
    window.addEventListener('offline', () => emitState());
    await emitState();
    if (navigator.onLine) await syncNow().catch(() => {});
    return getState();
  }

  window.LorrenWorkerPortalOffline = Object.freeze({ init, queueMark, queueArrival, queueDeparture, getState, syncNow });
})();
