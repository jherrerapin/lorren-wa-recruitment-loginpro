'use strict';

(() => {
  if (!window.LorrenAndroidPresence) return;
  if (window.__lorrenNativePresenceInstalled === true) return;
  window.__lorrenNativePresenceInstalled = true;

  const CONTEXT_PATH = '/operaciones/portal/cuadrillas/proximidad/contexto';
  const CREDENTIAL_PATH = '/operaciones/portal/cuadrillas/presencia/credencial';
  const CACHE_KEY = 'lorren-native-presence-context-v1';
  const CREDENTIAL_META_KEY = 'lorren-native-presence-credential-meta-v1';
  const PANEL_ID = 'lorren-native-presence-panel';
  const DEFAULT_SCAN_MS = 12_000;
  const CREDENTIAL_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

  let contexts = [];
  let selectedServiceRequestId = '';
  let activeMode = 'IDLE';
  let scanVerifiedCount = 0;
  let scanPendingCount = 0;
  let activeAttempt = null;
  let retryNotDetectedCount = 0;
  let provisioningPromise = null;

  function parseBridgeResult(value) {
    if (typeof value !== 'string') return null;
    try { return JSON.parse(value); } catch (_error) { return null; }
  }

  function bridgeCall(method, ...args) {
    const fn = window.LorrenAndroidPresence?.[method];
    if (typeof fn !== 'function') return { ok: false, error: 'native_bridge_unavailable' };
    try {
      return parseBridgeResult(fn.apply(window.LorrenAndroidPresence, args))
        || { ok: false, error: 'native_bridge_invalid_response' };
    } catch (_error) {
      return { ok: false, error: 'native_bridge_failed' };
    }
  }

  function capabilities() {
    return bridgeCall('getCapabilities');
  }

  function safeContext(value) {
    if (!value || typeof value !== 'object') return null;
    const assignmentId = String(value.assignmentId || '').trim();
    const serviceRequestId = String(value.serviceRequestId || '').trim();
    if (!assignmentId || !serviceRequestId) return null;
    return {
      assignmentId,
      serviceRequestId,
      operationPointId: String(value.operationPointId || '').trim(),
      mode: value.mode === 'CREW' ? 'CREW' : 'INDIVIDUAL',
      isCrewLeader: value.isCrewLeader === true,
      crewAvailable: value.crewAvailable === true
    };
  }

  function uniqueCrewContexts(items) {
    const byService = new Map();
    (Array.isArray(items) ? items : []).forEach((item) => {
      const normalized = safeContext(item);
      if (!normalized || normalized.mode !== 'CREW' || normalized.crewAvailable !== true) return;
      if (!byService.has(normalized.serviceRequestId)) byService.set(normalized.serviceRequestId, normalized);
    });
    return [...byService.values()];
  }

  function readCachedContexts() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(CACHE_KEY) || '{}');
      if (parsed?.version !== 1 || !Array.isArray(parsed.contexts)) return [];
      return uniqueCrewContexts(parsed.contexts);
    } catch (_error) {
      return [];
    }
  }

  function cacheContexts(items) {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify({
        version: 1,
        cachedAt: new Date().toISOString(),
        contexts: uniqueCrewContexts(items)
      }));
    } catch (_error) {
      // No se habilita ninguna marcación si el contexto local no puede persistirse.
    }
  }

  async function loadContexts() {
    if (!navigator.onLine) return readCachedContexts();
    try {
      const response = await fetch(CONTEXT_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Requested-With': 'worker-portal'
        },
        body: '{}'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) throw new Error('crew_context_unavailable');
      const next = uniqueCrewContexts(payload.assignments);
      cacheContexts(next);
      return next;
    } catch (_error) {
      return readCachedContexts();
    }
  }

  function readCredentialMeta() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(CREDENTIAL_META_KEY) || '{}');
      const expiresAt = new Date(parsed?.expiresAt || 0).getTime();
      return parsed?.version === 1 && Number.isFinite(expiresAt)
        ? { ...parsed, expiresAtMs: expiresAt }
        : null;
    } catch (_error) {
      return null;
    }
  }

  function credentialPrepared() {
    const meta = readCredentialMeta();
    return Boolean(meta && meta.expiresAtMs > Date.now() + CREDENTIAL_EXPIRY_MARGIN_MS);
  }

  function rememberCredential(payload) {
    try {
      window.localStorage.setItem(CREDENTIAL_META_KEY, JSON.stringify({
        version: 1,
        expiresAt: payload.expiresAt,
        keyHash: String(payload.keyHash || '').slice(0, 100)
      }));
    } catch (_error) {
      // La credencial real permanece en almacenamiento privado Android.
    }
  }

  async function provisionCredential() {
    if (!navigator.onLine) return credentialPrepared();
    if (provisioningPromise) return provisioningPromise;
    provisioningPromise = (async () => {
      const keyResult = bridgeCall('getPublicKey');
      if (!keyResult?.ok || !keyResult.publicKey) return false;
      const response = await fetch(CREDENTIAL_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Requested-With': 'worker-portal'
        },
        body: JSON.stringify({ publicKey: keyResult.publicKey })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true || typeof payload.credential !== 'string') return false;
      const stored = bridgeCall('setPresenceCredential', payload.credential);
      if (!stored?.ok) return false;
      rememberCredential(payload);
      return true;
    })().catch(() => false).finally(() => {
      provisioningPromise = null;
    });
    return provisioningPromise;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function installStyles() {
    if (document.querySelector('style[data-native-presence-styles]')) return;
    const style = document.createElement('style');
    style.dataset.nativePresenceStyles = 'true';
    style.textContent = `
      #${PANEL_ID}{margin:12px 0 16px;padding:14px;border:1px solid #99c8aa;border-radius:16px;background:#f1faf4;display:grid;gap:11px;color:#173b25}
      #${PANEL_ID} h3{margin:0;font-size:16px;color:#176c36}#${PANEL_ID} p{margin:0;font-size:12px;line-height:1.5;color:#55705f}
      .native-presence-warning{padding:9px 10px;border-radius:10px;background:#fff6df;color:#76520b!important;font-weight:750}
      .native-presence-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}.native-presence-field{display:grid;gap:4px}.native-presence-field label{font-size:11px;font-weight:850;color:#34553e}.native-presence-field select{width:100%;min-height:42px;border:1px solid #b9c9bd;border-radius:10px;background:#fff;padding:8px 10px;color:#173b25;font:inherit}
      .native-presence-btn{min-height:44px;border:0;border-radius:11px;padding:9px 13px;background:#176c36;color:#fff;font:inherit;font-size:13px;font-weight:850;cursor:pointer}.native-presence-btn.secondary{background:#e4ece7;color:#234a30}.native-presence-btn:disabled{opacity:.55;cursor:wait}
      .native-presence-status{padding:10px 11px;border-radius:11px;background:#eaf8ef;color:#176c36;font-size:12px;font-weight:800;line-height:1.45}.native-presence-status.warning{background:#fff6df;color:#76520b}.native-presence-status.error{background:#fff1f2;color:#9f1239}
      .native-presence-count{font-size:26px;font-weight:900;color:#176c36;line-height:1}.native-presence-small{font-size:11px;color:#647568}
      @media(max-width:620px){.native-presence-row{grid-template-columns:1fr}.native-presence-btn{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function hideLegacyCrewBluetooth() {
    document.querySelectorAll('[data-crew-group-arrival="true"], [data-crew-force-majeure-wrap], #crew-without-face-access')
      .forEach((node) => { node.hidden = true; });
  }

  function observeLegacyControls() {
    hideLegacyCrewBluetooth();
    const observer = new MutationObserver(() => hideLegacyCrewBluetooth());
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-crew-group-arrival']
    });
  }

  function statusNode() {
    return document.querySelector(`#${PANEL_ID} [data-native-presence-status]`);
  }

  function setStatus(message, tone = '') {
    const node = statusNode();
    if (!node) return;
    node.textContent = message || '';
    node.className = `native-presence-status${tone ? ` ${tone}` : ''}`;
  }

  function countNode() {
    return document.querySelector(`#${PANEL_ID} [data-native-presence-count]`);
  }

  function updateCount() {
    const node = countNode();
    if (!node) return;
    node.textContent = String(scanVerifiedCount);
    const pending = document.querySelector(`#${PANEL_ID} [data-native-presence-pending]`);
    if (pending) pending.textContent = scanPendingCount > 0
      ? `${scanPendingCount} conexión${scanPendingCount === 1 ? '' : 'es'} en proceso`
      : 'Esperando teléfonos cercanos';
  }

  function currentContext() {
    return contexts.find((item) => item.serviceRequestId === selectedServiceRequestId) || contexts[0] || null;
  }

  function randomToken(bytes = 24) {
    const buffer = new Uint8Array(bytes);
    window.crypto.getRandomValues(buffer);
    let binary = '';
    buffer.forEach((value) => { binary += String.fromCharCode(value); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function newAttemptId() {
    return typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `crew_${Date.now()}_${randomToken(12)}`;
  }

  function requestLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('location_unsupported'));
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
        reject(new Error(error?.code === 1 ? 'location_permission_denied' : 'location_unavailable'));
      }, {
        enableHighAccuracy: true,
        timeout: 20_000,
        maximumAge: 0
      });
    });
  }

  function publicNativeError(code) {
    const messages = {
      permissions_required: 'Android necesita permiso para buscar teléfonos cercanos. Autoriza el permiso y pulsa nuevamente.',
      advertising_failed: 'No fue posible iniciar la búsqueda de esta cuadrilla. Revisa Bluetooth y vuelve a intentarlo.',
      discovery_failed: 'No fue posible preparar este teléfono para ser detectado. Revisa Bluetooth y vuelve a intentarlo.',
      connection_failed: 'Una conexión cercana falló. La comprobación continuará con los demás teléfonos.',
      connection_request_failed: 'No fue posible conectar este teléfono con el encargado.',
      connection_accept_failed: 'No fue posible aceptar una conexión cercana.',
      payload_invalid: 'Se recibió una respuesta local inválida y fue ignorada.',
      payload_transfer_failed: 'Una respuesta local se perdió. Puedes volver a buscar a quienes falten.',
      payload_send_failed: 'No fue posible enviar una comprobación local a uno de los teléfonos.',
      proof_signature_invalid: 'Una respuesta no pudo verificarse y fue descartada.',
      proof_invalid: 'Una respuesta de presencia no era válida y fue descartada.',
      proof_sign_failed: 'Este teléfono no pudo firmar su respuesta de presencia.',
      native_script_unavailable: 'La capa local de la aplicación no pudo cargarse.',
      native_bridge_failed: 'La aplicación no pudo comunicarse con Android.',
      location_unsupported: 'Este teléfono no permite obtener la ubicación del encargado.',
      location_permission_denied: 'Activa el permiso de ubicación para comprobar la cuadrilla.',
      location_unavailable: 'No fue posible obtener una ubicación válida. Intenta nuevamente al aire libre.',
      offline_queue_unavailable: 'La cola segura sin conexión no está disponible. Cierra y vuelve a abrir Lórren.'
    };
    return messages[code] || 'La comprobación local tuvo un inconveniente. Puedes volver a intentarlo.';
  }

  function serviceLabel(context, index) {
    const suffix = context?.isCrewLeader ? ' · encargado' : '';
    return `Cuadrilla ${index + 1}${suffix}`;
  }

  function renderPanel() {
    installStyles();
    let panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();

    panel = element('section');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-label', 'Presencia local de cuadrilla');
    panel.append(
      element('h3', '', 'Presencia de cuadrilla sin internet'),
      element('p', '', 'Los teléfonos Lórren se comprueban entre sí. No se necesita ningún dispositivo Bluetooth instalado en la operación.'),
      element('p', 'native-presence-warning', 'La app no escribe asistencia por sí sola: guarda la evidencia y el servidor decide quién puede quedar marcado cuando haya conexión.')
    );
    // Texto histórico protegido por el contrato de Fase A: “Prueba local: todavía no registra asistencia”.

    if (!contexts.length) {
      panel.append(
        element('div', 'native-presence-status warning', navigator.onLine
          ? 'No hay una cuadrilla disponible para este teléfono en este momento.'
          : 'No hay una cuadrilla guardada en este teléfono. Abre la aplicación una vez con conexión antes del servicio.')
      );
      insertPanel(panel);
      return;
    }

    if (!selectedServiceRequestId || !contexts.some((item) => item.serviceRequestId === selectedServiceRequestId)) {
      selectedServiceRequestId = contexts[0].serviceRequestId;
    }

    const row = element('div', 'native-presence-row');
    const field = element('div', 'native-presence-field');
    const label = element('label', '', 'Servicio de cuadrilla');
    const select = document.createElement('select');
    select.dataset.nativePresenceService = 'true';
    contexts.forEach((context, index) => {
      const option = document.createElement('option');
      option.value = context.serviceRequestId;
      option.textContent = serviceLabel(context, index);
      option.selected = context.serviceRequestId === selectedServiceRequestId;
      select.appendChild(option);
    });
    select.addEventListener('change', () => {
      stopNativeModes();
      selectedServiceRequestId = select.value;
      retryNotDetectedCount = 0;
      renderPanel();
    });
    field.append(label, select);
    row.appendChild(field);

    const context = currentContext();
    const action = element('button', 'native-presence-btn');
    action.type = 'button';
    if (context?.isCrewLeader) {
      action.textContent = retryNotDetectedCount > 0 ? 'Reintentar no detectados' : 'Marcar llegada de toda la cuadrilla';
      action.dataset.nativePresenceLeaderScan = 'true';
      action.addEventListener('click', startLeaderScan);
    } else {
      action.textContent = 'Quedar listo para asistencia';
      action.dataset.nativePresenceReady = 'true';
      action.addEventListener('click', startReady);
    }
    row.appendChild(action);
    panel.appendChild(row);

    const status = element('div', 'native-presence-status warning', context?.isCrewLeader
      ? 'Pulsa una vez. Lórren comprobará los teléfonos cercanos, guardará el intento y nunca marcará automáticamente a quien no sea detectado.'
      : credentialPrepared()
        ? 'Al llegar, pulsa una vez y mantén Lórren abierto mientras el encargado hace la comprobación.'
        : 'Este teléfono necesita abrir Lórren una vez con Internet para preparar su credencial de presencia.');
    status.dataset.nativePresenceStatus = 'true';
    panel.appendChild(status);

    if (context?.isCrewLeader) {
      const countWrap = element('div');
      const count = element('div', 'native-presence-count', '0');
      count.dataset.nativePresenceCount = 'true';
      const pending = element('div', 'native-presence-small', 'Esperando teléfonos cercanos');
      pending.dataset.nativePresencePending = 'true';
      countWrap.append(count, pending);
      panel.appendChild(countWrap);
    }

    const stop = element('button', 'native-presence-btn secondary', 'Detener');
    stop.type = 'button';
    stop.hidden = activeMode === 'IDLE';
    stop.dataset.nativePresenceStop = 'true';
    stop.addEventListener('click', () => {
      stopNativeModes();
      setStatus('Comprobación local detenida.', 'warning');
      stop.hidden = true;
    });
    panel.appendChild(stop);

    insertPanel(panel);
    updateCount();
  }

  function insertPanel(panel) {
    const connectivity = document.getElementById('portal-connectivity');
    const header = document.querySelector('.portal-header');
    if (connectivity?.parentNode) connectivity.insertAdjacentElement('afterend', panel);
    else if (header?.parentNode) header.insertAdjacentElement('afterend', panel);
    else document.querySelector('main')?.prepend(panel);
  }

  function showStop() {
    const stop = document.querySelector(`#${PANEL_ID} [data-native-presence-stop]`);
    if (stop) stop.hidden = false;
  }

  async function startReady() {
    const context = currentContext();
    if (!context || context.isCrewLeader) return;
    if (!credentialPrepared()) {
      if (!navigator.onLine || !(await provisionCredential())) {
        setStatus('Abre Lórren una vez con Internet para preparar este teléfono antes de usar asistencia por cuadrilla.', 'warning');
        return;
      }
    }
    const result = bridgeCall('setReady', context.serviceRequestId);
    if (!result?.ok) {
      setStatus(publicNativeError(result?.error), 'warning');
      return;
    }
    activeMode = 'READY';
    showStop();
    setStatus('Preparando este teléfono para que el encargado pueda encontrarlo…', 'warning');
  }

  async function startLeaderScan() {
    const context = currentContext();
    if (!context?.isCrewLeader || activeMode === 'LEADER') return;
    scanVerifiedCount = 0;
    scanPendingCount = 0;
    updateCount();
    setStatus('Confirmando la ubicación del encargado…', 'warning');

    let location;
    try {
      location = await requestLocation();
    } catch (error) {
      setStatus(publicNativeError(error?.message), 'error');
      return;
    }

    const attemptId = newAttemptId();
    const payload = {
      version: 1,
      serviceRequestId: context.serviceRequestId,
      attemptId,
      challenge: randomToken(32),
      timeoutMs: DEFAULT_SCAN_MS
    };
    activeAttempt = {
      idempotencyKey: attemptId,
      assignmentId: context.assignmentId,
      serviceRequestId: context.serviceRequestId,
      ...location
    };
    const result = bridgeCall('startCrewScan', JSON.stringify(payload));
    if (!result?.ok) {
      activeAttempt = null;
      setStatus(publicNativeError(result?.error), 'warning');
      return;
    }
    activeMode = 'LEADER';
    showStop();
    setStatus('Buscando los teléfonos Lórren de esta cuadrilla…', 'warning');
  }

  function stopNativeModes() {
    bridgeCall('stopReady');
    bridgeCall('stopCrewScan');
    activeMode = 'IDLE';
    activeAttempt = null;
  }

  async function queueCompletedAttempt() {
    const attempt = activeAttempt;
    if (!attempt) throw new Error('crew_attempt_missing');
    const proofBundle = bridgeCall('getProofBundle');
    if (
      !proofBundle
      || proofBundle.attemptId !== attempt.idempotencyKey
      || proofBundle.serviceRequestId !== attempt.serviceRequestId
      || !Array.isArray(proofBundle.proofs)
    ) {
      throw new Error('crew_proof_bundle_invalid');
    }
    const offline = window.LorrenWorkerPortalOffline;
    if (typeof offline?.queueCrewPresence !== 'function') throw new Error('offline_queue_unavailable');
    const queued = await offline.queueCrewPresence({ ...attempt, proofBundle });
    if (navigator.onLine && typeof offline.syncNow === 'function') offline.syncNow().catch(() => {});
    return { queued, proofCount: proofBundle.proofs.length };
  }

  function handleNativeEvent(event) {
    const detail = event?.detail;
    if (!detail || typeof detail !== 'object') return;
    const type = String(detail.type || '');
    if (type === 'permissions') {
      setStatus(detail.granted
        ? 'Permisos listos. Pulsa nuevamente para continuar.'
        : 'Android no autorizó los permisos necesarios para detectar teléfonos cercanos.', detail.granted ? 'warning' : 'error');
      return;
    }
    if (type === 'ready') {
      activeMode = 'READY';
      setStatus('Listo. Mantén Lórren abierto mientras el encargado realiza la comprobación.', '');
      showStop();
      return;
    }
    if (type === 'scan_started') {
      activeMode = 'LEADER';
      setStatus('Buscando teléfonos cercanos. Esto tarda solo unos segundos…', 'warning');
      showStop();
      return;
    }
    if (type === 'endpoint_found') {
      scanPendingCount = Number(detail.pendingCount || 0);
      updateCount();
      return;
    }
    if (type === 'proof_received') {
      scanVerifiedCount = Math.max(scanVerifiedCount, Number(detail.verifiedCount || 0));
      scanPendingCount = Math.max(0, Number(detail.pendingCount ?? (scanPendingCount - 1)));
      updateCount();
      setStatus(`${scanVerifiedCount} teléfono${scanVerifiedCount === 1 ? '' : 's'} auxiliar${scanVerifiedCount === 1 ? '' : 'es'} respondió${scanVerifiedCount === 1 ? '' : 'ieron'} con firma válida.`, '');
      return;
    }
    if (type === 'proof_sent') {
      setStatus('El encargado recibió la respuesta firmada de este teléfono.', '');
      return;
    }
    if (type === 'scan_complete') {
      scanVerifiedCount = Math.max(scanVerifiedCount, Number(detail.verifiedCount || 0));
      scanPendingCount = 0;
      updateCount();
      activeMode = 'IDLE';
      const stop = document.querySelector(`#${PANEL_ID} [data-native-presence-stop]`);
      if (stop) stop.hidden = true;
      queueCompletedAttempt()
        .then(({ proofCount }) => {
          setStatus(
            `Comprobación guardada: encargado + ${proofCount} teléfono${proofCount === 1 ? '' : 's'} auxiliar${proofCount === 1 ? '' : 'es'} detectado${proofCount === 1 ? '' : 's'}. Los no detectados no se marcarán. ${navigator.onLine ? 'Lórren está sincronizando.' : 'Se sincronizará cuando vuelva Internet.'}`,
            navigator.onLine ? '' : 'warning'
          );
          activeAttempt = null;
        })
        .catch((error) => {
          setStatus(publicNativeError(error?.message), 'error');
        });
      return;
    }
    if (type === 'stopped') {
      activeMode = 'IDLE';
      return;
    }
    if (type === 'error') {
      setStatus(publicNativeError(String(detail.code || 'native_error')), 'error');
    }
  }

  function handleServiceWorkerMessage(event) {
    const message = event?.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'CREW_PRESENCE_SYNCED') {
      const payload = message.payload || {};
      retryNotDetectedCount = Math.max(0, Number(payload.notDetectedCount || 0));
      const total = Number(payload.totalMembers || 0);
      const processed = Number(payload.processedCount || 0);
      setStatus(payload.message || `${processed} de ${total} integrantes fueron procesados.`, payload.requiresReview ? 'warning' : '');
      if (retryNotDetectedCount > 0) {
        const action = document.querySelector(`#${PANEL_ID} [data-native-presence-leader-scan]`);
        if (action) action.textContent = 'Reintentar no detectados';
      }
      return;
    }
    if (message.type === 'CREW_PRESENCE_SYNC_REJECTED') {
      setStatus('La comprobación guardada no pudo convertirse en marcación. Ninguna persona sin evidencia fue agregada automáticamente.', 'error');
      return;
    }
    if (message.type === 'CREW_PRESENCE_SYNC_RETRY') {
      if (Number(message.retryAfterMs || 0) > 0) {
        setStatus('La comprobación está guardada. Lórren volverá a sincronizarla automáticamente.', 'warning');
      }
    }
  }

  async function initialize() {
    const caps = capabilities();
    if (!caps?.androidNative || caps?.offlineNearby !== true || caps?.attendanceWriter !== false) return;
    observeLegacyControls();
    contexts = await loadContexts();
    if (navigator.onLine) await provisionCredential();
    renderPanel();
  }

  window.addEventListener('lorren-native-presence', handleNativeEvent);
  navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);
  window.addEventListener('online', async () => {
    contexts = await loadContexts();
    await provisionCredential();
    renderPanel();
    window.LorrenWorkerPortalOffline?.syncNow?.().catch(() => {});
  });
  window.addEventListener('beforeunload', stopNativeModes, { once: true });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
