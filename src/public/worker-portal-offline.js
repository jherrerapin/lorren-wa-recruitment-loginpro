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

  const PORTAL_UI_STYLE = `
    body.portal-ui-ready{background:radial-gradient(circle at top right,rgba(23,108,54,.14),transparent 31rem),linear-gradient(180deg,#f4f8f5 0%,#f5f6f8 45%,#eef1f3 100%)}
    body.portal-ui-ready main{width:min(100%,720px)}
    .portal-ui-ready .portal-header{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;margin-bottom:14px;padding:23px;overflow:hidden;border-radius:24px;background:linear-gradient(135deg,#0b3b24 0%,#176c36 58%,#23834a 100%);color:#fff;box-shadow:0 18px 44px rgba(11,59,36,.2)}
    .portal-ui-ready .portal-header:after{content:"";position:absolute;width:220px;height:220px;right:-90px;top:-110px;border-radius:50%;background:rgba(255,255,255,.08)}
    .portal-ui-ready .portal-header>div,.portal-ui-ready .session-chip,.portal-next-summary{position:relative;z-index:1}
    .portal-ui-ready .portal-header .brand,.portal-ui-ready .portal-header p{color:rgba(255,255,255,.76)}
    .portal-ui-ready .portal-header h1{color:#fff}
    .portal-ui-ready .session-chip{border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.13);color:#fff;backdrop-filter:blur(8px)}
    .portal-next-summary{grid-column:1/-1;display:grid;grid-template-columns:42px 1fr;gap:12px;align-items:center;padding:13px 14px;border:1px solid rgba(255,255,255,.18);border-radius:16px;background:rgba(255,255,255,.1)}
    .portal-next-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:rgba(255,255,255,.17);font-size:20px}
    .portal-next-summary small{display:block;margin-bottom:2px;color:rgba(255,255,255,.7)}
    .portal-next-summary strong{display:block;color:#fff;font-size:14px;line-height:1.35}
    .portal-summary-panel{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin-bottom:14px;overflow:hidden;border:1px solid #dfe5e9;border-radius:18px;background:#dfe5e9;box-shadow:0 12px 34px rgba(23,33,43,.06)}
    .portal-summary-stat{padding:15px 10px;background:#fff;text-align:center}
    .portal-summary-stat span{display:block;color:#77848f;font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.05em}
    .portal-summary-stat strong{display:block;margin-top:5px;color:#23313d;font-size:20px}
    .portal-filter-panel{margin-bottom:18px;padding:17px;border:1px solid #dfe5e9;border-radius:20px;background:#fff;box-shadow:0 12px 34px rgba(23,33,43,.06)}
    .portal-filter-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:13px}
    .portal-filter-head h2{font-size:17px}.portal-filter-head p{margin-top:3px;font-size:12px}.portal-filter-result{flex:0 0 auto;color:#176c36;font-size:12px;font-weight:850}
    .portal-quick-filters{display:flex;gap:7px;margin-bottom:13px;overflow-x:auto;scrollbar-width:none}.portal-quick-filters::-webkit-scrollbar{display:none}
    .portal-quick-filter{flex:0 0 auto;padding:8px 11px;border:1px solid #d5dde2;border-radius:999px;background:#fff;color:#4b5965;font-size:12px;font-weight:800;cursor:pointer}
    .portal-quick-filter.active{border-color:#176c36;background:#eaf8ef;color:#176c36}
    .portal-filter-grid{display:grid;grid-template-columns:1fr 1fr 1.15fr auto;gap:9px;align-items:end}
    .portal-filter-field{display:grid;gap:5px;color:#687682;font-size:11px;font-weight:750}
    .portal-filter-field input,.portal-filter-field select{width:100%;min-height:42px;border:1px solid #d7dee3;border-radius:11px;padding:9px 10px;background:#fff;color:#263645}
    .portal-clear-filter{min-height:42px;border:0;border-radius:11px;padding:9px 12px;background:#edf1f3;color:#42515d;font-weight:800;cursor:pointer}
    .portal-date-groups{display:grid;gap:21px}.portal-date-group{display:grid;gap:10px}.portal-date-group[hidden],.portal-ui-card[hidden]{display:none}
    .portal-date-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 3px}.portal-date-title{display:flex;gap:10px;align-items:center}.portal-date-dot{width:9px;height:9px;border-radius:50%;background:#176c36;box-shadow:0 0 0 5px rgba(23,108,54,.11)}
    .portal-date-title h2{font-size:16px;text-transform:capitalize}.portal-group-count{color:#788590;font-size:12px;font-weight:750}
    .portal-date-list{display:grid;gap:10px}
    .portal-ui-ready .assignment-card.portal-ui-card{padding:0;overflow:hidden;border-radius:18px}
    .portal-ui-ready .assignment-card.portal-ui-card.portal-in-progress{border-color:#79b78f;box-shadow:0 14px 36px rgba(23,108,54,.12)}
    .portal-card-toggle{position:relative;display:grid;grid-template-columns:68px minmax(0,1fr) auto;gap:13px;align-items:center;width:100%;padding:15px 44px 15px 15px;border:0;background:transparent;text-align:left;cursor:pointer}
    .portal-card-toggle:after{content:"⌄";position:absolute;right:16px;top:50%;transform:translateY(-55%);color:#7a8791;font-size:20px;transition:transform .18s ease}
    .portal-ui-card.portal-expanded .portal-card-toggle:after{transform:translateY(-42%) rotate(180deg)}
    .portal-time-tile{padding:10px 6px;border-radius:13px;background:#eef7f1;color:#176c36;text-align:center;font-size:12px;font-weight:850;line-height:1.25}
    .portal-card-heading{min-width:0}.portal-card-heading strong{display:block;overflow:hidden;color:#17212b;font-size:16px;text-overflow:ellipsis;white-space:nowrap}
    .portal-card-heading small{display:block;margin-top:4px;overflow:hidden;color:#6a7782;font-size:12px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
    .portal-status-pill{padding:6px 9px;border-radius:999px;background:#eef1f3;color:#5f6d78;font-size:10px;font-weight:850;white-space:nowrap}
    .portal-status-pill.in-progress{background:#e5f6eb;color:#176c36}.portal-status-pill.completed{background:#edf2ef;color:#476153}.portal-status-pill.warning{background:#fff1ca;color:#805800}
    .portal-card-body{display:none;padding:0 16px 16px;border-top:1px solid #edf0f2}.portal-ui-card.portal-expanded .portal-card-body{display:block}
    .portal-filtered-empty{margin-top:8px}
    @media(max-width:620px){.portal-filter-grid{grid-template-columns:1fr 1fr}.portal-filter-field.portal-status-filter,.portal-clear-filter{grid-column:1/-1}}
    @media(max-width:460px){.portal-ui-ready .portal-header{grid-template-columns:1fr;padding:20px;border-radius:21px}.portal-ui-ready .session-chip{justify-self:start}.portal-summary-stat{padding:13px 7px}.portal-summary-stat strong{font-size:18px}.portal-card-toggle{grid-template-columns:61px minmax(0,1fr)}.portal-status-pill{grid-column:2;justify-self:start}}
  `;

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
  }

  function parseAssignmentDate(label) {
    const normalized = String(label || '').toLowerCase();
    const match = normalized.match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i);
    if (!match) return '';
    const months = {
      enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
      julio: '07', agosto: '08', septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12'
    };
    const month = months[match[2]];
    if (!month) return '';
    return `${match[3]}-${month}-${String(match[1]).padStart(2, '0')}`;
  }

  function bogotaDateKey(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function addDays(dateKey, days) {
    const date = new Date(`${dateKey}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function detailValue(card, label) {
    const rows = Array.from(card.querySelectorAll('.detail-row'));
    const row = rows.find((candidate) => candidate.querySelector('.detail-label')?.textContent.trim().toLowerCase() === label);
    return row?.querySelector('.detail-value')?.textContent.trim() || '';
  }

  function assignmentStatus(card) {
    if (card.classList.contains('completed')) return 'COMPLETED';
    if (card.querySelector('[data-mark-type="DEPARTURE"]')) return 'IN_PROGRESS';
    return 'PENDING';
  }

  function statusPresentation(card, status) {
    if (status === 'COMPLETED') return { label: 'Finalizada', tone: 'completed' };
    if (status === 'IN_PROGRESS' && card.querySelector('[data-mark-type="BREAK_END"]')) return { label: 'Almuerzo pendiente', tone: 'warning' };
    if (status === 'IN_PROGRESS') return { label: 'En jornada', tone: 'in-progress' };
    return { label: 'Pendiente', tone: '' };
  }

  function enhanceAssignmentCard(card, index) {
    const dateElement = card.querySelector('.assignment-date');
    const titleElement = card.querySelector('h2');
    const timeElement = card.querySelector('.assignment-time');
    const dateLabel = dateElement?.textContent.trim() || 'Fecha pendiente';
    const clientName = titleElement?.textContent.trim() || 'Cliente por confirmar';
    const timeLabel = timeElement?.textContent.trim() || 'Horario por confirmar';
    const operationName = detailValue(card, 'operación') || 'Operación por confirmar';
    const cityName = detailValue(card, 'ciudad');
    const status = assignmentStatus(card);
    const statusView = statusPresentation(card, status);
    const dateKey = parseAssignmentDate(dateLabel);

    card.classList.add('portal-ui-card');
    if (status === 'IN_PROGRESS') card.classList.add('portal-in-progress');
    card.dataset.portalDate = dateKey;
    card.dataset.portalDateLabel = dateLabel;
    card.dataset.portalStatus = status;

    const originalChildren = Array.from(card.children);
    const body = createElement('div', 'portal-card-body');
    originalChildren.forEach((child) => {
      if (child !== dateElement && child !== titleElement && child !== timeElement) body.appendChild(child);
    });
    dateElement?.remove();
    titleElement?.remove();
    timeElement?.remove();

    const toggle = createElement('button', 'portal-card-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');

    const timeTile = createElement('span', 'portal-time-tile', timeLabel.includes('–') ? timeLabel.split('–')[0].trim() : timeLabel);
    const heading = createElement('span', 'portal-card-heading');
    heading.append(createElement('strong', '', clientName));
    heading.append(createElement('small', '', [operationName, cityName].filter(Boolean).join(' · ')));
    const statusPill = createElement('span', `portal-status-pill ${statusView.tone}`.trim(), statusView.label);
    toggle.append(timeTile, heading, statusPill);
    card.prepend(toggle);
    card.append(body);

    const shouldExpand = status === 'IN_PROGRESS' || (index === 0 && status !== 'COMPLETED');
    function setExpanded(expanded) {
      card.classList.toggle('portal-expanded', expanded);
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
    toggle.addEventListener('click', () => setExpanded(!card.classList.contains('portal-expanded')));
    setExpanded(shouldExpand);
    return { card, dateKey, dateLabel, status, clientName, timeLabel, operationName };
  }

  function buildSummary(items, list) {
    const counts = {
      PENDING: items.filter((item) => item.status === 'PENDING').length,
      IN_PROGRESS: items.filter((item) => item.status === 'IN_PROGRESS').length,
      COMPLETED: items.filter((item) => item.status === 'COMPLETED').length
    };
    const summary = createElement('section', 'portal-summary-panel');
    summary.setAttribute('aria-label', 'Resumen de asignaciones');
    [
      ['Pendientes', counts.PENDING],
      ['En curso', counts.IN_PROGRESS],
      ['Finalizadas', counts.COMPLETED]
    ].forEach(([label, value]) => {
      const stat = createElement('div', 'portal-summary-stat');
      stat.append(createElement('span', '', label), createElement('strong', '', String(value)));
      summary.append(stat);
    });
    list.parentNode.insertBefore(summary, list);
  }

  function buildHeroNext(items, header) {
    const today = bogotaDateKey();
    const next = items.find((item) => item.status === 'IN_PROGRESS')
      || items.find((item) => item.status === 'PENDING' && (!item.dateKey || item.dateKey >= today))
      || items.find((item) => item.status !== 'COMPLETED');
    if (!next) return;
    const summary = createElement('div', 'portal-next-summary');
    summary.append(createElement('span', 'portal-next-icon', '⌚'));
    const copy = createElement('div');
    copy.append(
      createElement('small', '', next.status === 'IN_PROGRESS' ? 'Jornada en curso' : 'Siguiente asignación'),
      createElement('strong', '', `${next.clientName} · ${next.timeLabel}`)
    );
    summary.append(copy);
    header.append(summary);
  }

  function groupAssignments(items, sourceList) {
    const grouped = new Map();
    items.forEach((item) => {
      const key = item.dateKey || item.dateLabel || 'Fecha pendiente';
      if (!grouped.has(key)) grouped.set(key, { key, label: item.dateLabel || 'Fecha pendiente', items: [] });
      grouped.get(key).items.push(item);
    });

    const groupsContainer = createElement('section', 'portal-date-groups');
    groupsContainer.id = 'portal-assignment-groups';
    groupsContainer.setAttribute('aria-label', 'Asignaciones agrupadas por fecha');

    grouped.forEach((group) => {
      const section = createElement('section', 'portal-date-group');
      section.dataset.portalDateGroup = group.key;
      const header = createElement('header', 'portal-date-header');
      const title = createElement('div', 'portal-date-title');
      title.append(createElement('span', 'portal-date-dot'), createElement('h2', '', group.label));
      const count = createElement('span', 'portal-group-count', `${group.items.length} asignación${group.items.length === 1 ? '' : 'es'}`);
      count.dataset.portalGroupCount = 'true';
      header.append(title, count);
      const list = createElement('div', 'portal-date-list');
      group.items.forEach((item) => list.append(item.card));
      section.append(header, list);
      groupsContainer.append(section);
    });
    sourceList.replaceWith(groupsContainer);
    return groupsContainer;
  }

  function buildFilters(items, groupsContainer) {
    const panel = createElement('section', 'portal-filter-panel');
    panel.setAttribute('aria-label', 'Filtros de asignaciones');
    const head = createElement('div', 'portal-filter-head');
    const heading = createElement('div');
    heading.append(createElement('h2', '', 'Organizar asignaciones'), createElement('p', '', 'Filtra por periodo o estado.'));
    const result = createElement('span', 'portal-filter-result', `${items.length} visibles`);
    head.append(heading, result);

    const quick = createElement('div', 'portal-quick-filters');
    quick.setAttribute('role', 'group');
    quick.setAttribute('aria-label', 'Periodos rápidos');
    const presetButtons = [
      ['today', 'Hoy'],
      ['upcoming', 'Próximas'],
      ['week', '7 días'],
      ['all', 'Todas']
    ].map(([value, label]) => {
      const button = createElement('button', `portal-quick-filter${value === 'upcoming' ? ' active' : ''}`, label);
      button.type = 'button';
      button.dataset.portalPreset = value;
      quick.append(button);
      return button;
    });

    const grid = createElement('div', 'portal-filter-grid');
    const fromLabel = createElement('label', 'portal-filter-field', 'Desde');
    const fromInput = createElement('input'); fromInput.type = 'date'; fromInput.id = 'assignment-date-from'; fromLabel.append(fromInput);
    const toLabel = createElement('label', 'portal-filter-field', 'Hasta');
    const toInput = createElement('input'); toInput.type = 'date'; toInput.id = 'assignment-date-to'; toLabel.append(toInput);
    const statusLabel = createElement('label', 'portal-filter-field portal-status-filter', 'Estado');
    const statusSelect = createElement('select'); statusSelect.id = 'assignment-status-filter';
    [['', 'Todos los estados'], ['PENDING', 'Pendientes'], ['IN_PROGRESS', 'En curso'], ['COMPLETED', 'Finalizadas']].forEach(([value, label]) => {
      const option = createElement('option', '', label); option.value = value; statusSelect.append(option);
    });
    statusLabel.append(statusSelect);
    const clear = createElement('button', 'portal-clear-filter', 'Limpiar'); clear.type = 'button'; clear.id = 'clear-assignment-filters';
    grid.append(fromLabel, toLabel, statusLabel, clear);
    panel.append(head, quick, grid);
    groupsContainer.parentNode.insertBefore(panel, groupsContainer);

    const empty = createElement('section', 'empty-state portal-filtered-empty');
    empty.hidden = true;
    empty.append(createElement('h2', '', 'No hay asignaciones en este filtro'), createElement('p', 'meta', 'Cambia el periodo o limpia los filtros para ver otras fechas.'));
    groupsContainer.parentNode.insertBefore(empty, groupsContainer.nextSibling);

    function activatePreset(name) {
      presetButtons.forEach((button) => button.classList.toggle('active', button.dataset.portalPreset === name));
    }

    function applyFilters() {
      const from = fromInput.value;
      const to = toInput.value;
      const status = statusSelect.value;
      const activePreset = presetButtons.find((button) => button.classList.contains('active'))?.dataset.portalPreset || '';
      let visibleCount = 0;

      items.forEach((item) => {
        const matchesFrom = !from || !item.dateKey || item.dateKey >= from;
        const matchesTo = !to || !item.dateKey || item.dateKey <= to;
        const matchesStatus = !status || status === item.status;
        const keepActiveJourney = activePreset === 'upcoming' && item.status === 'IN_PROGRESS';
        const visible = (keepActiveJourney || (matchesFrom && matchesTo)) && matchesStatus;
        item.card.hidden = !visible;
        if (visible) visibleCount += 1;
      });

      Array.from(groupsContainer.querySelectorAll('.portal-date-group')).forEach((group) => {
        const visibleCards = Array.from(group.querySelectorAll('.portal-ui-card')).filter((card) => !card.hidden);
        group.hidden = visibleCards.length === 0;
        const counter = group.querySelector('[data-portal-group-count]');
        if (counter) counter.textContent = `${visibleCards.length} asignación${visibleCards.length === 1 ? '' : 'es'}`;
      });

      result.textContent = `${visibleCount} visible${visibleCount === 1 ? '' : 's'}`;
      empty.hidden = visibleCount !== 0;
    }

    function setPreset(name) {
      const today = bogotaDateKey();
      if (name === 'today') {
        fromInput.value = today;
        toInput.value = today;
      } else if (name === 'week') {
        fromInput.value = today;
        toInput.value = addDays(today, 6);
      } else if (name === 'upcoming') {
        fromInput.value = today;
        toInput.value = '';
      } else {
        fromInput.value = '';
        toInput.value = '';
      }
      activatePreset(name);
      applyFilters();
    }

    presetButtons.forEach((button) => button.addEventListener('click', () => setPreset(button.dataset.portalPreset)));
    fromInput.addEventListener('change', () => { activatePreset(''); applyFilters(); });
    toInput.addEventListener('change', () => { activatePreset(''); applyFilters(); });
    statusSelect.addEventListener('change', applyFilters);
    clear.addEventListener('click', () => { statusSelect.value = ''; setPreset('all'); });
    setPreset('upcoming');
  }

  function initializePortalPresentation() {
    const header = document.querySelector('.portal-header');
    const list = document.querySelector('.assignment-list');
    if (!header || !list || document.body.classList.contains('portal-ui-ready')) return;
    const cards = Array.from(list.querySelectorAll(':scope > .assignment-card'));
    if (!cards.length) return;

    const style = createElement('style');
    style.dataset.workerPortalUi = 'true';
    style.textContent = PORTAL_UI_STYLE;
    document.head.append(style);
    document.body.classList.add('portal-ui-ready');

    const items = cards.map((card, index) => enhanceAssignmentCard(card, index));
    buildHeroNext(items, header);
    buildSummary(items, list);
    const groupsContainer = groupAssignments(items, list);
    buildFilters(items, groupsContainer);
  }

  window.LorrenWorkerPortalOffline = Object.freeze({ init, queueMark, queueArrival, queueDeparture, getState, syncNow });
  initializePortalPresentation();
})();
