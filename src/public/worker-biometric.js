'use strict';

const BIOMETRIC_ASSET_RELEASE = '20260811-worker-portal-biometric-v9';
const WORKER_PORTAL_USER_AGENT = String(window.navigator.userAgent || '');
const LOAD_WORKER_PORTAL_HANDOFF = /Android/i.test(WORKER_PORTAL_USER_AGENT);

window.LorrenBiometricAssetRelease = BIOMETRIC_ASSET_RELEASE;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const message = event?.data;
    if (message?.type !== 'PORTAL_SHELL_UPDATED') return;

    const cacheName = String(message.cacheName || 'current');
    const reloadKey = `lorren-shell-reloaded:${cacheName}`;
    if (window.sessionStorage.getItem(reloadKey) === 'true') return;

    window.sessionStorage.setItem(reloadKey, 'true');
    window.location.reload();
  });

  navigator.serviceWorker.getRegistration('/operaciones/portal')
    .then((registration) => registration?.update?.())
    .catch(() => {});
}

(() => {
  const PORTAL_PATH_PATTERN = /^\/operaciones\/portal\/?$/;
  const CONTEXT_PATH = '/operaciones/portal/cuadrillas/proximidad/contexto';
  if (!PORTAL_PATH_PATTERN.test(window.location.pathname)) return;

  let contextReady = false;
  let contextLoadPromise = null;
  let protocol = null;
  let contextsByAssignment = new Map();
  const bypassOnce = new WeakSet();

  function statusElement() {
    let status = document.querySelector('[data-crew-bluetooth-status]');
    if (status) return status;
    const connectivity = document.getElementById('portal-connectivity');
    if (!connectivity?.parentElement) return null;
    status = document.createElement('div');
    status.dataset.crewBluetoothStatus = 'true';
    status.className = 'status crew-bluetooth-status';
    status.hidden = true;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'assertive');
    connectivity.insertAdjacentElement('afterend', status);
    return status;
  }

  function setCrewBluetoothStatus(message, tone = 'warning') {
    const status = statusElement();
    if (!status) return;
    status.hidden = !message;
    status.className = `status crew-bluetooth-status ${tone}`.trim();
    status.textContent = message || '';
  }

  function crewContextError(message) {
    const error = new Error(message);
    error.crewBluetoothCode = message;
    return error;
  }

  function normalizedProtocol(payload) {
    const serviceUuid = String(payload?.protocol?.serviceUuid || '').trim().toLowerCase();
    const operationCharacteristicUuid = String(payload?.protocol?.operationCharacteristicUuid || '').trim().toLowerCase();
    if (!serviceUuid || !operationCharacteristicUuid) throw crewContextError('crew_bluetooth_protocol_unavailable');
    return { serviceUuid, operationCharacteristicUuid };
  }

  async function loadCrewProximityContexts() {
    if (!navigator.onLine) {
      contextReady = false;
      return false;
    }
    if (contextLoadPromise) return contextLoadPromise;
    contextReady = false;
    contextLoadPromise = fetch(CONTEXT_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'worker-portal'
      },
      body: '{}'
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw crewContextError('crew_bluetooth_context_unavailable');
        protocol = normalizedProtocol(payload);
        const nextContexts = new Map();
        (Array.isArray(payload.assignments) ? payload.assignments : []).forEach((item) => {
          const assignmentId = String(item?.assignmentId || '').trim();
          if (!assignmentId) return;
          nextContexts.set(assignmentId, {
            assignmentId,
            operationPointId: String(item?.operationPointId || '').trim(),
            mode: item?.mode === 'CREW' ? 'CREW' : 'INDIVIDUAL',
            isCrewLeader: item?.isCrewLeader === true,
            crewAvailable: item?.crewAvailable === true,
            proximityRequired: item?.proximityRequired === true
          });
        });
        contextsByAssignment = nextContexts;
        contextReady = true;
        return true;
      })
      .catch(() => {
        protocol = null;
        contextsByAssignment = new Map();
        contextReady = false;
        return false;
      })
      .finally(() => {
        contextLoadPromise = null;
      });
    return contextLoadPromise;
  }

  function markButtonFromEvent(event) {
    return event.target instanceof Element
      ? event.target.closest('.mark-button[data-assignment-id][data-mark-type]')
      : null;
  }

  async function verifyCrewBluetooth(context) {
    if (!window.isSecureContext || typeof navigator.bluetooth?.requestDevice !== 'function') {
      throw crewContextError('crew_bluetooth_unsupported');
    }
    if (!protocol?.serviceUuid || !protocol?.operationCharacteristicUuid || !context.operationPointId) {
      throw crewContextError('crew_bluetooth_context_unavailable');
    }

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [protocol.serviceUuid] }]
    });
    if (!device?.gatt) throw crewContextError('crew_bluetooth_connection_failed');

    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(protocol.serviceUuid);
      const characteristic = await service.getCharacteristic(protocol.operationCharacteristicUuid);
      const value = await characteristic.readValue();
      const observedOperationPointId = new TextDecoder('utf-8').decode(value).trim();
      if (observedOperationPointId !== context.operationPointId) {
        throw crewContextError('crew_bluetooth_wrong_operation');
      }
      return true;
    } finally {
      try {
        if (device.gatt.connected) device.gatt.disconnect();
      } catch (_error) {
        // La desconexión no cambia el resultado de una lectura ya validada.
      }
    }
  }

  function publicBluetoothError(error) {
    if (error?.crewBluetoothCode === 'crew_bluetooth_unsupported') {
      return 'Este teléfono o navegador no permite usar Bluetooth desde el portal. Para una cuadrilla, usa un navegador compatible con Web Bluetooth.';
    }
    if (error?.name === 'NotFoundError') {
      return 'No se seleccionó el dispositivo Bluetooth de la operación.';
    }
    if (error?.crewBluetoothCode === 'crew_bluetooth_wrong_operation') {
      return 'El dispositivo Bluetooth seleccionado no corresponde a esta operación.';
    }
    if (error?.crewBluetoothCode === 'crew_bluetooth_context_unavailable') {
      return 'No fue posible preparar la validación Bluetooth de esta asignación. Actualiza el portal e intenta nuevamente.';
    }
    return 'No fue posible leer el dispositivo Bluetooth de la operación. Acércate e intenta nuevamente.';
  }

  document.addEventListener('click', (event) => {
    const button = markButtonFromEvent(event);
    if (!button || button.disabled || !navigator.onLine) return;
    if (bypassOnce.has(button)) {
      bypassOnce.delete(button);
      return;
    }

    const assignmentId = String(button.dataset.assignmentId || '').trim();
    if (!contextReady) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setCrewBluetoothStatus('Preparando la configuración de cuadrilla. Intenta nuevamente en un momento.', 'warning');
      loadCrewProximityContexts();
      return;
    }

    const context = contextsByAssignment.get(assignmentId);
    if (!context) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setCrewBluetoothStatus('No fue posible validar la modalidad de esta asignación. Actualiza el portal e intenta nuevamente.', 'danger');
      loadCrewProximityContexts();
      return;
    }
    if (!context.proximityRequired) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    setCrewBluetoothStatus('Selecciona el dispositivo Bluetooth de esta operación para continuar.', 'warning');

    // requestDevice se invoca desde el click original para conservar la activación del usuario.
    const verification = verifyCrewBluetooth(context);
    button.disabled = true;
    verification
      .then(() => {
        setCrewBluetoothStatus('Dispositivo Bluetooth de la operación verificado. Continuando con ubicación y rostro.', 'ok');
        bypassOnce.add(button);
        button.disabled = false;
        button.click();
      })
      .catch((error) => {
        button.disabled = false;
        setCrewBluetoothStatus(publicBluetoothError(error), 'danger');
      });
  }, { capture: true });

  window.addEventListener('online', () => loadCrewProximityContexts());
  window.addEventListener('offline', () => {
    contextReady = false;
    protocol = null;
    contextsByAssignment = new Map();
  });
  window.addEventListener('pageshow', () => loadCrewProximityContexts());
  loadCrewProximityContexts();
})();

document.write(`<script src="/public/worker-biometric-core.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-biometric-mobile.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-portal-biometric-flow.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-portal-offline.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-portal-offline-controller.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
if (LOAD_WORKER_PORTAL_HANDOFF) {
  document.write(`<script src="/public/worker-portal-session-handoff.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
}
document.write(`<script src="/public/worker-portal-install.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);

(() => {
  const PORTAL_PATH_PATTERN = /^\/operaciones\/portal\/?$/;
  const VALID_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'COMPLETED']);

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
  }

  function parseAssignmentDate(label) {
    const match = String(label || '').toLowerCase().match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i);
    if (!match) return '';
    const months = {
      enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
      julio: '07', agosto: '08', septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12'
    };
    const month = months[match[2]];
    return month ? `${match[3]}-${month}-${String(match[1]).padStart(2, '0')}` : '';
  }

  function bogotaDateKey(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function addDays(dateKey, days) {
    const date = new Date(`${dateKey}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function assignmentStatus(card) {
    if (card.classList.contains('completed')) return 'COMPLETED';
    if (card.querySelector('[data-mark-type="DEPARTURE"]')) return 'IN_PROGRESS';
    if (card.querySelector('[data-mark-type="BREAK_START"], [data-mark-type="BREAK_END"]')) return 'IN_PROGRESS';
    if (card.querySelector('[data-mark-type="ARRIVAL"]')) return 'PENDING';
    return VALID_STATUSES.has(card.dataset.portalStatus) ? card.dataset.portalStatus : 'PENDING';
  }

  function shouldPinActiveJourney(status, activePreset) {
    return status === 'IN_PROGRESS' && Boolean(activePreset);
  }

  function updateSummary(summary, items) {
    const counts = { PENDING: 0, IN_PROGRESS: 0, COMPLETED: 0 };
    items.forEach((item) => {
      item.status = assignmentStatus(item.card);
      item.card.dataset.portalStatus = item.status;
      counts[item.status] += 1;
    });
    summary.querySelectorAll('[data-portal-summary-status]').forEach((element) => {
      const nextValue = String(counts[element.dataset.portalSummaryStatus] || 0);
      if (element.textContent !== nextValue) element.textContent = nextValue;
    });
  }

  function buildDateGroups(list, items) {
    const groups = new Map();
    items.forEach((item) => {
      const key = item.dateKey || item.dateLabel;
      if (!groups.has(key)) groups.set(key, { key, label: item.dateLabel, items: [] });
      groups.get(key).items.push(item);
    });

    const container = createElement('section', 'portal-date-groups');
    container.id = 'portal-assignment-groups';
    container.setAttribute('aria-label', 'Asignaciones agrupadas por fecha');

    groups.forEach((group) => {
      const section = createElement('section', 'portal-date-group');
      section.dataset.portalDateGroup = group.key;

      const header = createElement('header', 'portal-date-header');
      const title = createElement('div', 'portal-date-title');
      title.append(createElement('span', 'portal-date-dot'), createElement('h2', '', group.label));

      const count = createElement(
        'span',
        'portal-group-count',
        `${group.items.length} asignación${group.items.length === 1 ? '' : 'es'}`
      );
      count.dataset.portalGroupCount = 'true';
      header.append(title, count);

      const dateList = createElement('div', 'portal-date-list');
      group.items.forEach((item) => dateList.append(item.card));
      section.append(header, dateList);
      container.append(section);
    });

    list.replaceWith(container);
    return container;
  }

  function initializePortalFilters() {
    if (!PORTAL_PATH_PATTERN.test(window.location.pathname)) return false;
    if (document.body.classList.contains('portal-filters-ready')) return true;

    const list = document.querySelector('.assignment-list');
    const summary = document.querySelector('.portal-filter-summary');
    const panel = document.querySelector('.portal-filter-panel');
    const empty = document.querySelector('#portal-filtered-empty');
    if (!list || !summary || !panel || !empty) return false;

    const cards = Array.from(list.children).filter((element) => element.classList?.contains('assignment-card'));
    if (!cards.length) return false;

    const fromInput = panel.querySelector('#assignment-date-from');
    const toInput = panel.querySelector('#assignment-date-to');
    const statusSelect = panel.querySelector('#assignment-status-filter');
    const clear = panel.querySelector('#clear-assignment-filters');
    const result = panel.querySelector('#assignment-filter-result');
    const presetButtons = Array.from(panel.querySelectorAll('[data-portal-preset]'));
    if (!fromInput || !toInput || !statusSelect || !clear || !result || !presetButtons.length) return false;

    const items = cards.map((card) => {
      const dateLabel = card.querySelector('.assignment-date')?.textContent.trim() || 'Fecha pendiente';
      const status = assignmentStatus(card);
      card.dataset.portalStatus = status;
      return { card, dateLabel, dateKey: parseAssignmentDate(dateLabel), status };
    });
    const groupsContainer = buildDateGroups(list, items);
    let mutationTimer = null;

    function activatePreset(name) {
      presetButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.portalPreset === name);
      });
    }

    function applyFilters() {
      const from = fromInput.value;
      const to = toInput.value;
      const status = statusSelect.value;
      const activePreset = presetButtons.find((button) => button.classList.contains('active'))?.dataset.portalPreset || '';
      let visibleCount = 0;

      items.forEach((item) => {
        item.status = assignmentStatus(item.card);
        item.card.dataset.portalStatus = item.status;
        const matchesFrom = !from || !item.dateKey || item.dateKey >= from;
        const matchesTo = !to || !item.dateKey || item.dateKey <= to;
        const matchesStatus = !status || status === item.status;
        const keepActiveJourney = shouldPinActiveJourney(item.status, activePreset);
        const visible = (keepActiveJourney || (matchesFrom && matchesTo)) && matchesStatus;
        item.card.hidden = !visible;
        if (visible) visibleCount += 1;
      });

      groupsContainer.querySelectorAll('.portal-date-group').forEach((group) => {
        const visibleCards = Array.from(group.querySelectorAll('.assignment-card')).filter((card) => !card.hidden);
        group.hidden = visibleCards.length === 0;
        const counter = group.querySelector('[data-portal-group-count]');
        if (counter) {
          const nextLabel = `${visibleCards.length} asignación${visibleCards.length === 1 ? '' : 'es'}`;
          if (counter.textContent !== nextLabel) counter.textContent = nextLabel;
        }
      });

      updateSummary(summary, items);
      const nextResult = `${visibleCount} visible${visibleCount === 1 ? '' : 's'}`;
      if (result.textContent !== nextResult) result.textContent = nextResult;
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

    presetButtons.forEach((button) => {
      button.addEventListener('click', () => setPreset(button.dataset.portalPreset));
    });
    fromInput.addEventListener('change', () => { activatePreset(''); applyFilters(); });
    toInput.addEventListener('change', () => { activatePreset(''); applyFilters(); });
    statusSelect.addEventListener('change', applyFilters);
    clear.addEventListener('click', () => { statusSelect.value = ''; setPreset('all'); });

    const observer = new MutationObserver(() => {
      window.clearTimeout(mutationTimer);
      mutationTimer = window.setTimeout(applyFilters, 0);
    });
    items.forEach(({ card }) => {
      observer.observe(card, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'data-mark-type']
      });
    });

    document.body.classList.add('portal-filters-ready');
    setPreset('today');
    return true;
  }

  function initializeWhenAvailable() {
    if (initializePortalFilters()) return;
    const root = document.querySelector('main') || document.body;
    if (!root) return;

    const observer = new MutationObserver(() => {
      if (!initializePortalFilters()) return;
      observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 10_000);
  }

  window.LorrenWorkerPortalFilters = Object.freeze({ initialize: initializePortalFilters });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeWhenAvailable, { once: true });
  } else {
    initializeWhenAvailable();
  }
  window.addEventListener('pageshow', initializeWhenAvailable);
})();
