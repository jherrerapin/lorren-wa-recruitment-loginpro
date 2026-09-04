'use strict';

const BIOMETRIC_ASSET_RELEASE = '20260814-worker-portal-biometric-v10';
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
  const FAILURE_QUEUE_KEY = 'lorren-attendance-failure-v1';
  const FAILURE_QUEUE_LIMIT = 40;
  const CAMERA_FAILURES = Object.freeze({
    NotAllowedError: { internalCode: 'camera_permission_denied', reportCode: 'client_camera_permission_denied' },
    PermissionDeniedError: { internalCode: 'camera_permission_denied', reportCode: 'client_camera_permission_denied' },
    NotReadableError: { internalCode: 'camera_in_use', reportCode: 'client_camera_in_use' },
    TrackStartError: { internalCode: 'camera_in_use', reportCode: 'client_camera_in_use' },
    NotFoundError: { internalCode: 'camera_not_found', reportCode: 'client_camera_not_found' },
    DevicesNotFoundError: { internalCode: 'camera_not_found', reportCode: 'client_camera_not_found' },
    OverconstrainedError: { internalCode: 'camera_constraints_unsupported', reportCode: 'client_camera_constraints_unsupported' },
    ConstraintNotSatisfiedError: { internalCode: 'camera_constraints_unsupported', reportCode: 'client_camera_constraints_unsupported' },
    AbortError: { internalCode: 'camera_start_aborted', reportCode: 'client_camera_start_aborted' },
    SecurityError: { internalCode: 'camera_security_blocked', reportCode: 'client_camera_security_blocked' },
    TypeError: { internalCode: 'camera_constraints_unsupported', reportCode: 'client_camera_constraints_unsupported' }
  });
  const INTERNAL_TO_REPORT = Object.freeze(Object.fromEntries(
    Object.values(CAMERA_FAILURES).map((definition) => [definition.internalCode, definition.reportCode])
  ));

  if (!PORTAL_PATH_PATTERN.test(window.location.pathname)) return;

  let lastMarkContext = null;

  function newDiagnosticAttemptId() {
    if (window.crypto?.randomUUID) return `camera_${window.crypto.randomUUID()}`;
    return `camera_${Date.now()}_${Math.random().toString(36).slice(2, 18)}`;
  }

  function failureRecordKey(record) {
    return [record?.assignmentId, record?.markType, record?.clientAttemptId, record?.errorCode].join(':');
  }

  function loadFailureQueue() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(FAILURE_QUEUE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter((record) => (
        record
        && typeof record.assignmentId === 'string'
        && typeof record.markType === 'string'
        && typeof record.clientAttemptId === 'string'
        && typeof record.errorCode === 'string'
        && typeof record.occurredAt === 'string'
      )).slice(-FAILURE_QUEUE_LIMIT) : [];
    } catch (_error) {
      return [];
    }
  }

  function queueOfflineCameraFailure(error) {
    if (navigator.onLine || !lastMarkContext?.assignmentId || !lastMarkContext?.markType) return false;
    const reportCode = INTERNAL_TO_REPORT[String(error?.message || '')];
    if (!reportCode) return false;
    const record = {
      assignmentId: lastMarkContext.assignmentId,
      markType: lastMarkContext.markType,
      clientAttemptId: newDiagnosticAttemptId(),
      errorCode: reportCode,
      occurredAt: new Date().toISOString()
    };
    try {
      const queue = loadFailureQueue();
      const key = failureRecordKey(record);
      if (!queue.some((item) => failureRecordKey(item) === key)) queue.push(record);
      window.localStorage.setItem(FAILURE_QUEUE_KEY, JSON.stringify(queue.slice(-FAILURE_QUEUE_LIMIT)));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function normalizeCameraError(error) {
    const existingCode = String(error?.message || '');
    if (INTERNAL_TO_REPORT[existingCode]) return error;
    const definition = CAMERA_FAILURES[String(error?.name || '')];
    if (!definition) return error;
    const normalized = new Error(definition.internalCode);
    normalized.name = 'LorrenCameraError';
    normalized.cause = error;
    return normalized;
  }

  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest('.mark-button[data-assignment-id][data-mark-type]')
      : null;
    if (!button) return;
    const assignmentId = String(button.dataset.assignmentId || '').trim();
    const markType = String(button.dataset.markType || '').trim().toUpperCase();
    if (!assignmentId || !markType) return;
    lastMarkContext = { assignmentId, markType };
  }, { capture: true });

  const mediaDevices = navigator.mediaDevices;
  const originalGetUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);
  if (originalGetUserMedia) {
    const wrappedGetUserMedia = async (constraints) => {
      try {
        return await originalGetUserMedia(constraints);
      } catch (error) {
        const normalized = normalizeCameraError(error);
        queueOfflineCameraFailure(normalized);
        throw normalized;
      }
    };
    try {
      mediaDevices.getUserMedia = wrappedGetUserMedia;
    } catch (_error) {
      try {
        Object.defineProperty(mediaDevices, 'getUserMedia', {
          configurable: true,
          value: wrappedGetUserMedia
        });
      } catch (_ignored) {
        // Si el navegador impide envolver la API, el flujo existente conserva el comportamiento previo.
      }
    }
  }

  window.LorrenCameraDiagnostics = Object.freeze({ normalizeCameraError });
})();

(() => {
  const PORTAL_PATH_PATTERN = /^\/operaciones\/portal\/?$/;
  const CONTEXT_PATH = '/operaciones/portal/cuadrillas/proximidad/contexto';
  const CREW_IDEMPOTENCY_PREFIX = 'lorren-crew-arrival:';
  const CREW_FORCE_MAJEURE_PREFIX = 'lorren-crew-force-majeure:';
  if (!PORTAL_PATH_PATTERN.test(window.location.pathname)) return;
  if (window.LorrenAndroidPresence || /LorrenNative\/1/.test(WORKER_PORTAL_USER_AGENT)) return;

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

  function isCrewGroupArrival(context, button) {
    return button?.dataset?.markType === 'ARRIVAL'
      && context?.mode === 'CREW'
      && context?.isCrewLeader === true
      && context?.crewAvailable === true;
  }

  function crewStorageKey(assignmentId) {
    return `${CREW_IDEMPOTENCY_PREFIX}${String(assignmentId || '').trim()}`;
  }

  function crewForceMajeureStorageKey(assignmentId) {
    return `${CREW_FORCE_MAJEURE_PREFIX}${String(assignmentId || '').trim()}`;
  }

  function storedCrewIdempotencyKey(assignmentId) {
    return window.sessionStorage.getItem(crewStorageKey(assignmentId)) || '';
  }

  function storedCrewForceMajeure(assignmentId) {
    const value = window.sessionStorage.getItem(crewForceMajeureStorageKey(assignmentId));
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  }

  function newCrewIdempotencyKey() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `crew_${Date.now()}_${Math.random().toString(36).slice(2, 18)}`;
  }

  function crewIdempotencyKey(assignmentId) {
    const current = storedCrewIdempotencyKey(assignmentId);
    if (current) return current;
    const created = newCrewIdempotencyKey();
    window.sessionStorage.setItem(crewStorageKey(assignmentId), created);
    return created;
  }

  function crewForceMajeureValue(assignmentId, requested) {
    const stored = storedCrewForceMajeure(assignmentId);
    if (stored !== null) return stored;
    const value = requested === true;
    window.sessionStorage.setItem(crewForceMajeureStorageKey(assignmentId), value ? 'true' : 'false');
    return value;
  }

  function clearCrewAttempt(assignmentId) {
    window.sessionStorage.removeItem(crewStorageKey(assignmentId));
    window.sessionStorage.removeItem(crewForceMajeureStorageKey(assignmentId));
  }

  function forceMajeureControl(button) {
    return button?.closest('.action-grid')?.querySelector('[data-crew-force-majeure]') || null;
  }

  function ensureForceMajeureControl(button) {
    const grid = button?.closest('.action-grid');
    if (!grid) return null;
    let wrap = grid.querySelector('[data-crew-force-majeure-wrap]');
    if (!wrap) {
      wrap = document.createElement('label');
      wrap.dataset.crewForceMajeureWrap = 'true';
      wrap.style.cssText = 'display:flex;gap:10px;align-items:flex-start;padding:11px 12px;border:1px solid #d9c98d;border-radius:11px;background:#fff9e9;color:#68490c;font-size:13px;line-height:1.35;font-weight:700;';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.crewForceMajeure = 'true';
      input.style.cssText = 'width:20px;height:20px;margin:0;flex:0 0 auto;';
      const copy = document.createElement('span');
      copy.textContent = 'Fuerza mayor: uno o más auxiliares están sin celular en este momento.';
      wrap.append(input, copy);
      grid.append(wrap);
    }
    const input = wrap.querySelector('[data-crew-force-majeure]');
    const stored = storedCrewForceMajeure(button?.dataset?.assignmentId);
    if (input && stored !== null) input.checked = stored;
    wrap.hidden = !navigator.onLine;
    return input;
  }

  function assignmentCard(assignmentId) {
    return [...document.querySelectorAll('[data-assignment-card]')]
      .find((card) => String(card.dataset.assignmentCard || '') === String(assignmentId)) || null;
  }

  function serverDisabledButton(button) {
    if (!button) return true;
    if (button.hasAttribute('data-server-disabled') || button.hasAttribute('data-offline-disabled')) return true;
    const biometricFlowLoaded = Boolean(document.documentElement.dataset.lorrenBiometricFlow);
    return !biometricFlowLoaded && button.disabled;
  }

  function ensureCrewGroupButton(context) {
    const card = assignmentCard(context.assignmentId);
    if (!card || card.classList.contains('completed')) return null;
    const grid = card.querySelector('.action-grid');
    if (!grid) return null;

    let button = grid.querySelector(`.mark-button[data-assignment-id="${context.assignmentId}"][data-mark-type="ARRIVAL"]`);
    if (!button && storedCrewIdempotencyKey(context.assignmentId)) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'mark-button';
      button.dataset.assignmentId = context.assignmentId;
      button.dataset.markType = 'ARRIVAL';
      button.dataset.crewGroupInjected = 'true';
      grid.prepend(button);
    }
    if (!button || serverDisabledButton(button)) return null;

    button.dataset.crewGroupArrival = 'true';
    button.textContent = button.dataset.crewGroupInjected === 'true'
      ? 'Completar llegada de la cuadrilla'
      : 'Marcar llegada de toda la cuadrilla';
    ensureForceMajeureControl(button);
    if (navigator.onLine && button.dataset.crewBusy !== 'true') button.disabled = false;
    return button;
  }

  function offerCrewWithoutFaceAccess() {
    const groupButtons = [...document.querySelectorAll('[data-crew-group-arrival="true"]')]
      .filter((button) => !button.hasAttribute('data-server-disabled'));
    const dialog = document.getElementById('enrollment-dialog');
    const actions = dialog?.querySelector('.dialog-actions');
    if (!dialog || !actions) return;

    let accessButton = document.getElementById('crew-without-face-access');
    if (!groupButtons.length) {
      if (accessButton) accessButton.hidden = true;
      return;
    }
    if (!accessButton) {
      accessButton = document.createElement('button');
      accessButton.type = 'button';
      accessButton.id = 'crew-without-face-access';
      accessButton.className = 'secondary-button';
      accessButton.textContent = 'Marcar cuadrilla sin rostro';
      accessButton.addEventListener('click', () => {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
        decorateCrewGroupArrivals();
        document.querySelector('[data-crew-group-arrival="true"]')?.focus({ preventScroll: true });
      });
      actions.append(accessButton);
    }
    accessButton.hidden = false;
  }

  function decorateCrewGroupArrivals() {
    contextsByAssignment.forEach((context) => {
      if (context.mode !== 'CREW' || context.isCrewLeader !== true || context.crewAvailable !== true) return;
      ensureCrewGroupButton(context);
    });
    offerCrewWithoutFaceAccess();
  }

  function clearCrewGroupOnlineUi() {
    document.querySelectorAll('[data-crew-group-arrival="true"]').forEach((button) => {
      const wrap = button.closest('.action-grid')?.querySelector('[data-crew-force-majeure-wrap]');
      if (button.dataset.crewGroupInjected === 'true') button.remove();
      else button.textContent = 'Registrar llegada';
      if (wrap) wrap.hidden = true;
    });
    const accessButton = document.getElementById('crew-without-face-access');
    if (accessButton) accessButton.hidden = true;
  }

  async function loadCrewProximityContexts() {
    if (!navigator.onLine) {
      contextReady = false;
      clearCrewGroupOnlineUi();
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
        decorateCrewGroupArrivals();
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
      return observedOperationPointId;
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

  function requestCrewLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(crewContextError('crew_location_unsupported'));
        return;
      }
      navigator.geolocation.getCurrentPosition((position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          clientCapturedAt: new Date(position.timestamp || Date.now()).toISOString()
        });
      }, (error) => {
        const code = error?.code === 1 ? 'crew_location_permission_denied' : 'crew_location_unavailable';
        reject(crewContextError(code));
      }, {
        enableHighAccuracy: true,
        timeout: 20_000,
        maximumAge: 0
      });
    });
  }

  function crewGroupPublicError(error) {
    const code = String(error?.crewBluetoothCode || error?.code || error?.message || 'crew_group_failed');
    const messages = {
      crew_location_unsupported: 'Este teléfono no permite obtener la ubicación.',
      crew_location_permission_denied: 'Activa el permiso de ubicación para marcar la cuadrilla.',
      crew_location_unavailable: 'No fue posible obtener una ubicación válida. Intenta nuevamente.',
      outside_operation_range: 'El responsable debe estar dentro del rango de la operación.',
      operation_geofence_required: 'La operación no tiene una geocerca válida configurada.',
      location_accuracy_insufficient: 'La precisión del GPS no es suficiente. Intenta nuevamente al aire libre.',
      crew_group_not_available: 'La llegada grupal ya no está disponible para esta asignación.',
      crew_group_online_required: 'La llegada grupal necesita conexión.',
      portal_session_required: 'Tu sesión del portal venció.',
      assignment_not_available: 'La asignación ya no está disponible para marcar.',
      arrival_already_registered: 'El responsable ya tenía una llegada previa distinta. No se marcó al resto de la cuadrilla.'
    };
    return messages[code] || 'No fue posible registrar la llegada de la cuadrilla.';
  }

  async function submitCrewGroupArrival(button, context, observedOperationPointId) {
    try {
      setCrewBluetoothStatus('Bluetooth verificado. Obteniendo la ubicación del responsable…', 'warning');
      const location = await requestCrewLocation();
      const form = new FormData();
      form.set('idempotencyKey', crewIdempotencyKey(context.assignmentId));
      form.set('latitude', String(location.latitude));
      form.set('longitude', String(location.longitude));
      form.set('accuracyMeters', String(location.accuracyMeters));
      form.set('clientCapturedAt', location.clientCapturedAt);
      form.set('captureMode', 'ONLINE_WEB');

      const forceMajeure = crewForceMajeureValue(
        context.assignmentId,
        forceMajeureControl(button)?.checked === true
      );
      setCrewBluetoothStatus('Ubicación válida. Registrando la llegada de toda la cuadrilla…', 'warning');
      const response = await fetch(
        `/operaciones/portal/asignaciones/${encodeURIComponent(context.assignmentId)}/llegada`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'X-Requested-With': 'worker-portal',
            'X-Lorren-Crew-Group': 'true',
            'X-Lorren-Crew-Operation-Point-Id': observedOperationPointId,
            'X-Lorren-Crew-Force-Majeure': forceMajeure ? 'true' : 'false'
          },
          body: form
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        if (['arrival_already_registered', 'crew_group_not_available'].includes(payload.error)) {
          clearCrewAttempt(context.assignmentId);
        }
        const error = new Error(payload.error || 'crew_group_failed');
        error.code = payload.error;
        throw error;
      }
      const retryNeeded = payload.requiresReview === true
        || Number(payload.failedCount || 0) > 0
        || Number(payload.reviewPendingCount || 0) > 0;
      if (!retryNeeded) clearCrewAttempt(context.assignmentId);
      const message = payload.crewGroup !== true && payload.requiresReview === true
        ? 'La llegada del responsable quedó pendiente de revisión. No se marcó al resto de la cuadrilla.'
        : (payload.message || 'Llegada de cuadrilla registrada.');
      setCrewBluetoothStatus(message, retryNeeded ? 'warning' : 'ok');
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      delete button.dataset.crewBusy;
      button.disabled = false;
      setCrewBluetoothStatus(crewGroupPublicError(error), 'danger');
    }
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
    const groupArrival = isCrewGroupArrival(context, button);
    if (groupArrival) button.dataset.crewBusy = 'true';
    const verification = verifyCrewBluetooth(context);
    button.disabled = true;
    verification
      .then((observedOperationPointId) => {
        if (groupArrival) {
          setCrewBluetoothStatus('Dispositivo Bluetooth verificado. La llegada grupal no requiere reconocimiento facial.', 'ok');
          return submitCrewGroupArrival(button, context, observedOperationPointId);
        }
        setCrewBluetoothStatus('Dispositivo Bluetooth de la operación verificado. Continuando con ubicación y rostro.', 'ok');
        bypassOnce.add(button);
        button.disabled = false;
        button.click();
        return null;
      })
      .catch((error) => {
        delete button.dataset.crewBusy;
        button.disabled = false;
        setCrewBluetoothStatus(publicBluetoothError(error), 'danger');
      });
  }, { capture: true });

  const crewButtonObserver = new MutationObserver((mutations) => {
    if (!navigator.onLine) return;
    mutations.forEach((mutation) => {
      const button = mutation.target;
      if (!(button instanceof HTMLButtonElement) || button.dataset.crewGroupArrival !== 'true') return;
      if (button.hasAttribute('data-server-disabled') || button.hasAttribute('data-offline-disabled')) return;
      if (button.dataset.crewBusy === 'true') return;
      if (button.disabled) button.disabled = false;
    });
    offerCrewWithoutFaceAccess();
  });
  crewButtonObserver.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'open']
  });

  window.addEventListener('online', () => loadCrewProximityContexts());
  window.addEventListener('offline', () => {
    contextReady = false;
    protocol = null;
    contextsByAssignment = new Map();
    clearCrewGroupOnlineUi();
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
