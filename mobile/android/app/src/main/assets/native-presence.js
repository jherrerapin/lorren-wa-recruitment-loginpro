'use strict';

(() => {
  if (!window.LorrenAndroidPresence) return;
  if (window.__lorrenNativePresenceInstalled === true) return;
  window.__lorrenNativePresenceInstalled = true;

  const CONTEXT_PATH = '/operaciones/portal/cuadrillas/proximidad/contexto';
  const CREDENTIAL_PATH = '/operaciones/portal/cuadrillas/presencia/credencial';
  const CACHE_KEY = 'lorren-native-presence-context-v1';
  const PANEL_ID = 'lorren-native-presence-panel';
  const DEFAULT_SCAN_MS = 6_000;
  const AUTO_RETRY_DELAY_MS = 1_500;
  const AUXILIARY_REARM_DELAY_MS = 250;
  const PHONE_EXCEPTION_REASON = 'NO_PHONE_AVAILABLE';
  const MARK_TYPES = new Set(['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);
  const TRANSIENT_SCAN_ERRORS = new Set([
    'connection_failed',
    'connection_request_failed',
    'connection_accept_failed',
    'payload_transfer_failed',
    'payload_send_failed'
  ]);
  const NATIVE_START_ERRORS = new Set([
    'advertising_failed',
    'advertising_unsupported',
    'discovery_failed',
    'permissions_required',
    'bluetooth_disabled',
    'bluetooth_unavailable',
    'nearby_radio_error',
    'nearby_in_use',
    'nearby_state_conflict',
    'native_presence_credential_required'
  ]);

  let contexts = [];
  let selectedServiceRequestId = '';
  let activeMode = 'IDLE';
  let scanVerifiedCount = 0;
  let scanPendingCount = 0;
  let activeAttempt = null;
  let retryNotDetectedCount = 0;
  let retryMarkType = '';
  let hasCompletedLeaderScan = false;
  let scanTransientFailureCount = 0;
  let autoRetryRemaining = 1;
  let autoRetryTimer = null;
  let auxiliaryRearmTimer = null;
  let provisioningPromise = null;
  let pendingPhoneExceptionWorkerId = '';
  let pendingCompletedScan = null;
  const phoneExceptionsByService = new Map();
  const serverMemberStatusesByScope = new Map();
  const localQueuedMarksByService = new Map();

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

  function credentialPrepared() {
    return capabilities()?.presenceCredentialReady === true;
  }

  function normalizeMarkType(value) {
    const markType = String(value || '').trim().toUpperCase();
    return MARK_TYPES.has(markType) ? markType : null;
  }

  function markInfo(markType) {
    return ({
      ARRIVAL: {
        action: 'Marcar entrada de la cuadrilla',
        retry: 'Reintentar entrada pendiente',
        noun: 'entrada',
        title: 'Entrada'
      },
      BREAK_START: {
        action: 'Iniciar almuerzo de la cuadrilla',
        retry: 'Reintentar inicio de almuerzo',
        noun: 'inicio de almuerzo',
        title: 'Inicio de almuerzo'
      },
      BREAK_END: {
        action: 'Finalizar almuerzo de la cuadrilla',
        retry: 'Reintentar regreso de almuerzo',
        noun: 'regreso de almuerzo',
        title: 'Fin de almuerzo'
      },
      DEPARTURE: {
        action: 'Registrar salida de la cuadrilla',
        retry: 'Reintentar salida pendiente',
        noun: 'salida',
        title: 'Salida'
      }
    })[normalizeMarkType(markType) || 'ARRIVAL'];
  }

  function safeIsoDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function safeAttendance(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      arrivalAt: safeIsoDate(input.arrivalAt),
      breakStartAt: safeIsoDate(input.breakStartAt),
      breakEndAt: safeIsoDate(input.breakEndAt),
      departureAt: safeIsoDate(input.departureAt)
    };
  }

  function safeMember(value) {
    if (!value || typeof value !== 'object') return null;
    const assignmentId = String(value.assignmentId || '').trim();
    const workerId = String(value.workerId || '').trim();
    if (!assignmentId || !workerId) return null;
    const attendance = safeAttendance(value.attendance);
    return {
      assignmentId,
      workerId,
      displayName: String(value.displayName || 'Auxiliar').trim().slice(0, 160) || 'Auxiliar',
      arrivalReported: value.arrivalReported === true || Boolean(attendance.arrivalAt),
      attendance,
      isLeader: value.isLeader === true
    };
  }

  function safeContext(value) {
    if (!value || typeof value !== 'object') return null;
    const assignmentId = String(value.assignmentId || '').trim();
    const serviceRequestId = String(value.serviceRequestId || '').trim();
    if (!assignmentId || !serviceRequestId) return null;
    const isCrewLeader = value.isCrewLeader === true;
    return {
      assignmentId,
      serviceRequestId,
      operationPointId: String(value.operationPointId || '').trim(),
      operationPointName: String(value.operationPointName || '').trim().slice(0, 160),
      serviceDate: String(value.serviceDate || '').trim().slice(0, 10),
      startTime: String(value.startTime || '').trim().slice(0, 16),
      endTime: String(value.endTime || '').trim().slice(0, 16),
      mode: value.mode === 'CREW' ? 'CREW' : 'INDIVIDUAL',
      isCrewLeader,
      crewAvailable: value.crewAvailable === true,
      members: isCrewLeader
        ? (Array.isArray(value.members) ? value.members.map(safeMember).filter(Boolean) : [])
        : []
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
      return stored?.ok === true && credentialPrepared();
    })().catch(() => false).finally(() => {
      provisioningPromise = null;
    });
    return provisioningPromise;
  }

  function queuedMarkSet(serviceRequestId) {
    if (!localQueuedMarksByService.has(serviceRequestId)) {
      localQueuedMarksByService.set(serviceRequestId, new Set());
    }
    return localQueuedMarksByService.get(serviceRequestId);
  }

  function rememberQueuedMark(serviceRequestId, markType) {
    const normalized = normalizeMarkType(markType);
    if (serviceRequestId && normalized) queuedMarkSet(serviceRequestId).add(normalized);
  }

  function forgetQueuedMark(serviceRequestId, markType) {
    const normalized = normalizeMarkType(markType);
    if (!serviceRequestId || !normalized) return;
    queuedMarkSet(serviceRequestId).delete(normalized);
  }

  async function hydrateLocalQueuedMarks() {
    localQueuedMarksByService.clear();
    const offline = window.LorrenWorkerPortalOffline;
    if (typeof offline?.getState !== 'function') return;
    try {
      const state = await offline.getState();
      (Array.isArray(state?.crewQueue) ? state.crewQueue : []).forEach((record) => {
        const serviceRequestId = String(record?.serviceRequestId || '').trim();
        const markType = normalizeMarkType(record?.proofBundle?.markType) || 'ARRIVAL';
        if (serviceRequestId) rememberQueuedMark(serviceRequestId, markType);
      });
    } catch (_error) {
      // El backend sigue siendo la autoridad; este estado solo optimiza la etapa visible offline.
    }
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
      .native-presence-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;align-items:end}.native-presence-field{display:grid;gap:4px}.native-presence-field label{font-size:11px;font-weight:850;color:#34553e}.native-presence-field select{width:100%;min-height:42px;border:1px solid #b9c9bd;border-radius:10px;background:#fff;padding:8px 10px;color:#173b25;font:inherit}
      .native-presence-actions{display:grid;gap:7px}.native-presence-btn{min-height:44px;border:0;border-radius:11px;padding:9px 13px;background:#176c36;color:#fff;font:inherit;font-size:13px;font-weight:850;cursor:pointer}.native-presence-btn.secondary{background:#e4ece7;color:#234a30}.native-presence-btn:disabled{opacity:.55;cursor:wait}
      .native-presence-status{padding:10px 11px;border-radius:11px;background:#eaf8ef;color:#176c36;font-size:12px;font-weight:800;line-height:1.45}.native-presence-status.warning{background:#fff6df;color:#76520b}.native-presence-status.error{background:#fff1f2;color:#9f1239}
      .native-presence-count{font-size:26px;font-weight:900;color:#176c36;line-height:1}.native-presence-small{font-size:11px;color:#647568}
      .native-presence-members{display:grid;gap:7px}.native-presence-member{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:10px 11px;border:1px solid #d6e4da;border-radius:12px;background:#fff}.native-presence-member-copy{min-width:0}.native-presence-member-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:850;color:#173b25}.native-presence-member-role{display:block;margin-top:2px;font-size:10px;color:#718078}.native-presence-member-history{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.native-presence-member-mark{display:inline-flex;padding:4px 6px;border-radius:8px;background:#eaf8ef;color:#176c36;font-size:9px;font-weight:850;white-space:nowrap}.native-presence-member-side{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap}.native-presence-badge{display:inline-flex;align-items:center;min-height:28px;padding:5px 8px;border-radius:999px;font-size:10px;font-weight:900;white-space:nowrap}.native-presence-badge.verified,.native-presence-badge.registered{background:#eaf8ef;color:#176c36}.native-presence-badge.self{background:#edf1f4;color:#384954}.native-presence-badge.pending{background:#fff6df;color:#76520b}.native-presence-badge.no-phone{background:#fff0e6;color:#934b12}.native-presence-member-action{min-height:30px;border:0;border-radius:9px;padding:6px 8px;background:#edf1f4;color:#384954;font:inherit;font-size:10px;font-weight:850;cursor:pointer}.native-presence-confirm{grid-column:1/-1;display:grid;gap:7px;padding-top:7px;border-top:1px solid #e3e9e5}.native-presence-confirm-copy{font-size:11px;color:#68490c}.native-presence-confirm-actions{display:flex;gap:7px}.native-presence-confirm-actions button{flex:1;min-height:34px;border:0;border-radius:9px;padding:7px;font:inherit;font-size:10px;font-weight:850;cursor:pointer}.native-presence-confirm-yes{background:#a65b17;color:#fff}.native-presence-confirm-no{background:#edf1f4;color:#384954}
      @media(max-width:620px){.native-presence-row{grid-template-columns:1fr}.native-presence-btn{width:100%}.native-presence-member{grid-template-columns:minmax(0,1fr)}.native-presence-member-side{justify-content:flex-start}}
    `;
    document.head.appendChild(style);
  }

  function currentContext() {
    return contexts.find((item) => item.serviceRequestId === selectedServiceRequestId) || contexts[0] || null;
  }

  function hideIndividualCrewMarks() {
    const context = currentContext();
    if (!context) return;
    document.querySelectorAll('.mark-button[data-assignment-id][data-mark-type]').forEach((button) => {
      const markType = normalizeMarkType(button.dataset.markType);
      if (
        markType
        && String(button.dataset.assignmentId || '') === context.assignmentId
        && !button.hidden
      ) button.hidden = true;
    });
  }

  function hideLegacyCrewBluetooth() {
    document.querySelectorAll('[data-crew-group-arrival="true"], [data-crew-force-majeure-wrap], #crew-without-face-access, [data-crew-bluetooth-status]')
      .forEach((node) => { if (!node.hidden) node.hidden = true; });
    hideIndividualCrewMarks();
  }

  function observeLegacyControls() {
    hideLegacyCrewBluetooth();
    const observer = new MutationObserver(() => hideLegacyCrewBluetooth());
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-crew-group-arrival', 'data-assignment-id', 'data-mark-type', 'hidden', 'disabled']
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
      : scanVerifiedCount > 0
        ? `${scanVerifiedCount} respuesta${scanVerifiedCount === 1 ? '' : 's'} recibida${scanVerifiedCount === 1 ? '' : 's'}`
        : 'Aún sin respuestas';
  }

  function domCrewMarkActions(context) {
    if (!context?.isCrewLeader) return [];
    const seen = new Set();
    const actions = [];
    document.querySelectorAll('.mark-button[data-assignment-id][data-mark-type]').forEach((button) => {
      if (String(button.dataset.assignmentId || '') !== context.assignmentId) return;
      const markType = normalizeMarkType(button.dataset.markType);
      if (!markType || seen.has(markType) || button.disabled) return;
      seen.add(markType);
      actions.push(markType);
    });
    return actions;
  }

  function optimisticOfflineActions(context) {
    if (navigator.onLine) return null;
    const queued = queuedMarkSet(context.serviceRequestId);
    if (!queued.size) return null;
    if (queued.has('DEPARTURE')) return [];
    if (queued.has('BREAK_END')) return ['DEPARTURE'];
    if (queued.has('BREAK_START')) return ['BREAK_END', 'DEPARTURE'];
    if (queued.has('ARRIVAL')) return ['BREAK_START', 'DEPARTURE'];
    return null;
  }

  function onlineQueuedMarkType(context) {
    if (!navigator.onLine || !context?.serviceRequestId) return null;
    const queued = queuedMarkSet(context.serviceRequestId);
    return domCrewMarkActions(context).find((markType) => queued.has(markType))
      || [...queued].map(normalizeMarkType).find(Boolean)
      || null;
  }

  function availableCrewMarkActions(context) {
    if (!context?.isCrewLeader) return [];
    if (retryNotDetectedCount > 0 && normalizeMarkType(retryMarkType)) return [retryMarkType];
    if (onlineQueuedMarkType(context)) return [];
    return optimisticOfflineActions(context) ?? domCrewMarkActions(context);
  }

  function activePresentationMarkType(context) {
    return normalizeMarkType(activeAttempt?.markType)
      || normalizeMarkType(retryMarkType)
      || onlineQueuedMarkType(context)
      || availableCrewMarkActions(context)[0]
      || 'ARRIVAL';
  }

  function phoneExceptionSet(serviceRequestId) {
    if (!phoneExceptionsByService.has(serviceRequestId)) {
      phoneExceptionsByService.set(serviceRequestId, new Set());
    }
    return phoneExceptionsByService.get(serviceRequestId);
  }

  function statusScopeKey(serviceRequestId, markType) {
    return `${serviceRequestId}:${normalizeMarkType(markType) || 'ARRIVAL'}`;
  }

  function serverStatusMap(serviceRequestId, markType) {
    const key = statusScopeKey(serviceRequestId, markType);
    if (!serverMemberStatusesByScope.has(key)) serverMemberStatusesByScope.set(key, new Map());
    return serverMemberStatusesByScope.get(key);
  }

  function persistedMarkAt(member, markType) {
    const attendance = member?.attendance || {};
    return ({
      ARRIVAL: attendance.arrivalAt,
      BREAK_START: attendance.breakStartAt,
      BREAK_END: attendance.breakEndAt,
      DEPARTURE: attendance.departureAt
    })[normalizeMarkType(markType) || 'ARRIVAL'] || null;
  }

  function memberHasPersistedMark(member, markType) {
    return Boolean(persistedMarkAt(member, markType));
  }

  function formatPersistedMarkTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(date);
  }

  function memberStatus(context, member, markType) {
    const normalizedMark = normalizeMarkType(markType) || 'ARRIVAL';
    if (memberHasPersistedMark(member, normalizedMark)) return 'REGISTERED';
    const serverStatus = serverStatusMap(context.serviceRequestId, normalizedMark).get(member.workerId);
    if (serverStatus === 'VERIFIED' || serverStatus === 'REGISTERED') return serverStatus;
    if (member.isLeader) return 'LEADER_DEVICE';
    if (serverStatus) return serverStatus;
    if (normalizedMark === 'ARRIVAL' && phoneExceptionSet(context.serviceRequestId).has(member.workerId)) {
      return 'NO_PHONE_REVIEW';
    }
    return 'PENDING';
  }

  function expectedAuxiliaryProofCount(context, markType) {
    if (!context?.isCrewLeader || !Array.isArray(context.members)) return 0;
    return context.members.filter((member) => (
      !member.isLeader && memberStatus(context, member, markType) === 'PENDING'
    )).length;
  }

  function pendingAuxiliaryCount(context, markType) {
    if (!context?.isCrewLeader || !Array.isArray(context.members)) return 0;
    return context.members.filter((member) => (
      !member.isLeader && memberStatus(context, member, markType) === 'PENDING'
    )).length;
  }

  function memberStatusPresentation(status, markType) {
    if (status === 'VERIFIED') return { label: '✓ Detectado', className: 'verified' };
    if (status === 'REGISTERED') return { label: '✓ Registrado', className: 'registered' };
    if (status === 'LEADER_DEVICE') return { label: 'Este teléfono', className: 'self' };
    if (status === 'NO_PHONE_REVIEW') return { label: 'Sin teléfono · por revisar', className: 'no-phone' };
    return { label: `Por detectar · ${markInfo(markType).noun}`, className: 'pending' };
  }

  function setMemberServerStatuses(serviceRequestId, markType, statuses) {
    const map = serverStatusMap(serviceRequestId, markType);
    const phoneSet = phoneExceptionSet(serviceRequestId);
    (Array.isArray(statuses) ? statuses : []).forEach((item) => {
      const workerId = String(item?.workerId || '').trim();
      const status = String(item?.status || '').trim().toUpperCase();
      if (!workerId || !['VERIFIED', 'REGISTERED', 'NO_PHONE_REVIEW', 'PENDING'].includes(status)) return;
      const previous = map.get(workerId);
      if (status === 'PENDING' && ['VERIFIED', 'REGISTERED'].includes(previous)) return;
      if (status === 'VERIFIED' && previous === 'REGISTERED') return;
      map.set(workerId, status);
      if (normalizeMarkType(markType) === 'ARRIVAL') {
        if (status === 'NO_PHONE_REVIEW') phoneSet.add(workerId);
        else if (status === 'VERIFIED' || status === 'REGISTERED') phoneSet.delete(workerId);
      }
    });
  }

  function appendMemberHistory(copy, member) {
    const history = element('div', 'native-presence-member-history');
    const rows = [
      ['ARRIVAL', member?.attendance?.arrivalAt],
      ['BREAK_START', member?.attendance?.breakStartAt],
      ['BREAK_END', member?.attendance?.breakEndAt],
      ['DEPARTURE', member?.attendance?.departureAt]
    ];
    rows.forEach(([markType, at]) => {
      const time = formatPersistedMarkTime(at);
      if (!time) return;
      history.appendChild(element('span', 'native-presence-member-mark', `${markInfo(markType).title} · ${time}`));
    });
    if (history.childNodes.length) copy.appendChild(history);
  }

  function renderCrewMembers(panel, context, markType) {
    if (!context?.isCrewLeader || !Array.isArray(context.members) || !context.members.length) return;
    const normalizedMark = normalizeMarkType(markType) || 'ARRIVAL';
    const list = element('div', 'native-presence-members');
    list.setAttribute('aria-label', 'Integrantes de la cuadrilla');
    context.members.forEach((member) => {
      const status = memberStatus(context, member, normalizedMark);
      const presentation = memberStatusPresentation(status, normalizedMark);
      const row = element('div', 'native-presence-member');
      row.dataset.nativePresenceMember = member.workerId;
      const copy = element('div', 'native-presence-member-copy');
      copy.append(
        element('strong', 'native-presence-member-name', member.displayName),
        element('span', 'native-presence-member-role', member.isLeader ? 'Encargado' : 'Auxiliar')
      );
      appendMemberHistory(copy, member);
      const side = element('div', 'native-presence-member-side');
      side.appendChild(element('span', `native-presence-badge ${presentation.className}`, presentation.label));

      if (
        normalizedMark === 'ARRIVAL'
        && hasCompletedLeaderScan
        && !member.isLeader
        && status === 'PENDING'
      ) {
        const button = element('button', 'native-presence-member-action', 'Reportar sin teléfono');
        button.type = 'button';
        button.dataset.nativePresenceNoPhone = member.workerId;
        button.addEventListener('click', () => {
          pendingPhoneExceptionWorkerId = member.workerId;
          renderPanel();
        });
        side.appendChild(button);
      } else if (!member.isLeader && status === 'NO_PHONE_REVIEW') {
        const restore = element('button', 'native-presence-member-action', 'Ya tiene teléfono');
        restore.type = 'button';
        restore.addEventListener('click', () => {
          phoneExceptionSet(context.serviceRequestId).delete(member.workerId);
          serverStatusMap(context.serviceRequestId, 'ARRIVAL').set(member.workerId, 'PENDING');
          pendingPhoneExceptionWorkerId = '';
          retryNotDetectedCount = Math.max(1, retryNotDetectedCount);
          retryMarkType = 'ARRIVAL';
          hasCompletedLeaderScan = true;
          renderPanel();
          setStatus('Este auxiliar volverá a comprobarse en el próximo intento.', 'warning');
        });
        side.appendChild(restore);
      }
      row.append(copy, side);

      if (
        normalizedMark === 'ARRIVAL'
        && pendingPhoneExceptionWorkerId === member.workerId
        && status === 'PENDING'
      ) {
        const confirm = element('div', 'native-presence-confirm');
        confirm.appendChild(element('div', 'native-presence-confirm-copy', '¿Confirmar que está presente pero no tiene su teléfono?'));
        const actions = element('div', 'native-presence-confirm-actions');
        const yes = element('button', 'native-presence-confirm-yes', 'Confirmar sin teléfono');
        yes.type = 'button';
        yes.addEventListener('click', () => {
          phoneExceptionSet(context.serviceRequestId).add(member.workerId);
          serverStatusMap(context.serviceRequestId, 'ARRIVAL').delete(member.workerId);
          pendingPhoneExceptionWorkerId = '';
          renderPanel();
          setStatus('Quedará como “Sin teléfono · por revisar” al confirmar esta entrada.', 'warning');
        });
        const no = element('button', 'native-presence-confirm-no', 'Cancelar');
        no.type = 'button';
        no.addEventListener('click', () => {
          pendingPhoneExceptionWorkerId = '';
          renderPanel();
        });
        actions.append(yes, no);
        confirm.appendChild(actions);
        row.appendChild(confirm);
      }
      list.appendChild(row);
    });
    panel.appendChild(list);
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

  function publicNativeError(code) {
    const messages = {
      permissions_required: 'Autoriza los permisos solicitados por Android para continuar.',
      native_presence_credential_required: 'Este teléfono necesita conectarse una vez para preparar o renovar su credencial de asistencia.',
      bluetooth_disabled: 'Bluetooth está apagado. Actívalo para continuar.',
      bluetooth_unavailable: 'Este teléfono no tiene Bluetooth disponible para verificar la cuadrilla.',
      advertising_failed: 'No fue posible iniciar la señal Bluetooth del encargado. Intenta nuevamente.',
      advertising_unsupported: 'Este teléfono no soporta la función Bluetooth requerida para actuar como encargado de cuadrilla.',
      discovery_failed: 'No fue posible iniciar la escucha Bluetooth para la marcación. Intenta nuevamente.',
      connection_failed: 'Una conexión cercana falló. La comprobación continuará con los demás teléfonos.',
      connection_request_failed: 'No fue posible conectar con uno de los teléfonos cercanos.',
      connection_accept_failed: 'No fue posible aceptar una conexión cercana.',
      payload_invalid: 'Se recibió una respuesta local inválida y fue ignorada.',
      payload_transfer_failed: 'Una respuesta local se perdió. Puedes volver a buscar a quienes falten.',
      payload_send_failed: 'No fue posible enviar una comprobación local a uno de los teléfonos.',
      proof_signature_invalid: 'Una respuesta no pudo verificarse y fue descartada.',
      proof_invalid: 'Una respuesta de presencia no era válida y fue descartada.',
      proof_sign_failed: 'Este teléfono no pudo firmar su respuesta de presencia.',
      native_script_unavailable: 'La capa local de la aplicación no pudo cargarse.',
      native_bridge_failed: 'La aplicación no pudo comunicarse con Android.',
      native_location_unavailable: 'Android no pudo obtener una ubicación válida del encargado.',
      native_location_proof_failed: 'Android no pudo firmar la ubicación del encargado.',
      mock_location_detected: 'Android detectó una ubicación simulada. La marcación de cuadrilla no puede continuar.',
      offline_queue_unavailable: 'La cola segura sin conexión no está disponible. Cierra y vuelve a abrir Lórren.'
    };
    return messages[code] || 'La comprobación local tuvo un inconveniente. Puedes volver a intentarlo.';
  }

  function displayServiceDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
    return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
  }

  function serviceLabel(context) {
    const operation = String(context?.operationPointName || '').trim() || 'Servicio de cuadrilla';
    const date = displayServiceDate(context?.serviceDate);
    const startTime = String(context?.startTime || '').trim();
    const details = [operation, date, startTime].filter(Boolean).join(' · ');
    const suffix = context?.isCrewLeader ? ' · encargado' : '';
    return `${details}${suffix}`;
  }

  function markRetryAvailable(markType) {
    const normalized = normalizeMarkType(markType) || 'ARRIVAL';
    hasCompletedLeaderScan = true;
    retryMarkType = normalized;
    const action = document.querySelector(`#${PANEL_ID} [data-native-presence-leader-scan="${normalized}"]`);
    if (action) action.textContent = markInfo(normalized).retry;
  }

  function clearAutoRetry() {
    if (autoRetryTimer !== null) window.clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
  }

  function clearAuxiliaryRearm() {
    if (auxiliaryRearmTimer !== null) window.clearTimeout(auxiliaryRearmTimer);
    auxiliaryRearmTimer = null;
  }

  function scheduleAuxiliaryRearm() {
    clearAuxiliaryRearm();
    auxiliaryRearmTimer = window.setTimeout(() => {
      auxiliaryRearmTimer = null;
      ensureAuxiliaryReady(true).catch(() => {});
    }, AUXILIARY_REARM_DELAY_MS);
  }

  function resetLeaderAttemptState() {
    pendingPhoneExceptionWorkerId = '';
    retryNotDetectedCount = 0;
    retryMarkType = '';
    hasCompletedLeaderScan = false;
    autoRetryRemaining = 1;
    scanVerifiedCount = 0;
    scanPendingCount = 0;
  }

  function renderPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
    if (!contexts.length) return;
    installStyles();

    panel = element('section');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-label', 'Marcación de cuadrilla');
    panel.appendChild(element('h3', '', 'Marcación de cuadrilla'));

    if (!selectedServiceRequestId || !contexts.some((item) => item.serviceRequestId === selectedServiceRequestId)) {
      selectedServiceRequestId = contexts[0].serviceRequestId;
    }

    const row = element('div', 'native-presence-row');
    const field = element('div', 'native-presence-field');
    const label = element('label', '', 'Servicio de cuadrilla');
    const select = document.createElement('select');
    select.dataset.nativePresenceService = 'true';
    contexts.forEach((context) => {
      const option = document.createElement('option');
      option.value = context.serviceRequestId;
      option.textContent = serviceLabel(context);
      option.selected = context.serviceRequestId === selectedServiceRequestId;
      select.appendChild(option);
    });
    select.addEventListener('change', () => {
      stopNativeModes();
      selectedServiceRequestId = select.value;
      resetLeaderAttemptState();
      renderPanel();
      scheduleAuxiliaryRearm();
    });
    field.append(label, select);
    row.appendChild(field);

    const context = currentContext();
    const waitingServerMarkType = onlineQueuedMarkType(context);
    const markActions = availableCrewMarkActions(context);
    if (context?.isCrewLeader) {
      const actions = element('div', 'native-presence-actions');
      markActions.forEach((markType) => {
        const action = element('button', 'native-presence-btn');
        action.type = 'button';
        action.textContent = retryNotDetectedCount > 0 && retryMarkType === markType
          ? markInfo(markType).retry
          : markInfo(markType).action;
        action.dataset.nativePresenceLeaderScan = markType;
        action.disabled = activeMode === 'LEADER';
        action.addEventListener('click', () => startLeaderScan(markType, false));
        actions.appendChild(action);
      });
      row.appendChild(actions);
    }
    panel.appendChild(row);

    const presentationMarkType = activePresentationMarkType(context);
    const offlineQueued = !navigator.onLine && queuedMarkSet(context?.serviceRequestId || '').size > 0;
    const status = element('div', 'native-presence-status warning', context?.isCrewLeader
      ? waitingServerMarkType
        ? `${markInfo(waitingServerMarkType).title} enviada · esperando confirmación del servidor. La siguiente marcación se habilitará cuando quede registrada.`
        : offlineQueued
          ? 'Hay marcaciones guardadas sin conexión y pendientes de sincronizar. Puedes continuar localmente; se confirmarán cuando vuelva Internet.'
          : markActions.length
            ? `Listo para ${markInfo(presentationMarkType).noun}.`
            : 'No hay una marcación de cuadrilla disponible en este momento.'
      : credentialPrepared()
        ? 'Preparando Bluetooth para la marcación…'
        : 'Conéctate una vez para preparar este teléfono.');
    status.dataset.nativePresenceStatus = 'true';
    panel.appendChild(status);

    if (context?.isCrewLeader) {
      renderCrewMembers(panel, context, presentationMarkType);
      const countWrap = element('div');
      const count = element('div', 'native-presence-count', '0');
      count.dataset.nativePresenceCount = 'true';
      const pending = element('div', 'native-presence-small', 'Aún sin respuestas');
      pending.dataset.nativePresencePending = 'true';
      countWrap.append(count, pending);
      panel.appendChild(countWrap);

      const stop = element('button', 'native-presence-btn secondary', 'Detener');
      stop.type = 'button';
      stop.hidden = activeMode === 'IDLE';
      stop.dataset.nativePresenceStop = 'true';
      stop.addEventListener('click', () => {
        stopNativeModes();
        setStatus('Marcación detenida.', 'warning');
        stop.hidden = true;
      });
      panel.appendChild(stop);
    }

    insertPanel(panel);
    hideIndividualCrewMarks();
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

  async function ensureAuxiliaryReady(forceRestart = false) {
    const context = currentContext();
    if (!context || context.isCrewLeader) return;
    if (document.visibilityState === 'hidden') return;
    if (forceRestart && ['PREPARING', 'READY'].includes(activeMode)) {
      bridgeCall('stopReady');
      activeMode = 'IDLE';
    }
    if (['PREPARING', 'READY'].includes(activeMode)) return;
    await startReady();
  }

  async function startReady() {
    const context = currentContext();
    if (!context || context.isCrewLeader || ['PREPARING', 'READY'].includes(activeMode)) return;
    activeMode = 'PREPARING';
    setStatus('Preparando Bluetooth para la marcación…', 'warning');
    if (navigator.onLine && !credentialPrepared()) await provisionCredential();
    const result = bridgeCall('setReady', context.serviceRequestId);
    if (!result?.ok) {
      activeMode = 'IDLE';
      setStatus(publicNativeError(result?.error), 'warning');
      return;
    }
    setStatus('Activando escucha Bluetooth…', 'warning');
  }

  async function startLeaderScan(markType, automaticRetry = false) {
    const context = currentContext();
    const normalizedMark = normalizeMarkType(markType);
    if (!context?.isCrewLeader || !normalizedMark || activeMode === 'LEADER') return;
    clearAutoRetry();
    pendingPhoneExceptionWorkerId = '';
    pendingCompletedScan = null;
    retryMarkType = normalizedMark;
    if (normalizedMark !== 'ARRIVAL') phoneExceptionSet(context.serviceRequestId).clear();
    if (!automaticRetry) {
      autoRetryRemaining = 1;
      retryNotDetectedCount = 0;
      hasCompletedLeaderScan = false;
    }
    scanTransientFailureCount = 0;
    scanVerifiedCount = 0;
    scanPendingCount = 0;
    updateCount();

    const attemptId = newAttemptId();
    const expectedProofCount = expectedAuxiliaryProofCount(context, normalizedMark);
    const payload = {
      version: 1,
      serviceRequestId: context.serviceRequestId,
      attemptId,
      challenge: `lorren-mark-v1:${normalizedMark}:${randomToken(32)}`,
      timeoutMs: DEFAULT_SCAN_MS,
      expectedProofCount
    };
    activeAttempt = {
      idempotencyKey: attemptId,
      assignmentId: context.assignmentId,
      serviceRequestId: context.serviceRequestId,
      markType: normalizedMark,
      expectedProofCount
    };
    if (navigator.onLine && !credentialPrepared()) await provisionCredential();
    const result = bridgeCall('startCrewScan', JSON.stringify(payload));
    if (!result?.ok) {
      activeAttempt = null;
      setStatus(publicNativeError(result?.error), 'warning');
      return;
    }
    activeMode = 'LEADER';
    renderPanel();
    showStop();
    setStatus(
      automaticRetry
        ? `Reintentando automáticamente la ${markInfo(normalizedMark).noun} para quienes faltan…`
        : `Buscando señales de la cuadrilla para ${markInfo(normalizedMark).noun}…`,
      'warning'
    );
  }

  function stopNativeModes() {
    clearAutoRetry();
    clearAuxiliaryRearm();
    bridgeCall('stopReady');
    bridgeCall('stopCrewScan');
    activeMode = 'IDLE';
    activeAttempt = null;
    pendingCompletedScan = null;
  }

  function nativeLocationFromBundle(proofBundle) {
    const proof = proofBundle?.leaderLocationProof;
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
      throw new Error('native_location_unavailable');
    }
    if (proof.isMock === true) throw new Error('mock_location_detected');
    const latitude = Number(proof.latitude);
    const longitude = Number(proof.longitude);
    const accuracyMeters = Number(proof.accuracyMeters);
    const capturedAtMs = Number(proof.capturedAt);
    if (
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || !Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > 100_000
      || !Number.isFinite(capturedAtMs) || capturedAtMs <= 0
    ) throw new Error('native_location_unavailable');
    return {
      latitude,
      longitude,
      accuracyMeters,
      clientCapturedAt: new Date(capturedAtMs).toISOString()
    };
  }

  function readProofBundle(attempt) {
    const proofBundle = bridgeCall('getProofBundle');
    if (
      !attempt
      || !proofBundle
      || proofBundle.attemptId !== attempt.idempotencyKey
      || proofBundle.serviceRequestId !== attempt.serviceRequestId
      || !Array.isArray(proofBundle.proofs)
    ) {
      throw new Error('crew_proof_bundle_invalid');
    }
    return proofBundle;
  }

  async function queueCompletedAttempt(proofBundle) {
    const attempt = activeAttempt;
    if (!attempt) throw new Error('crew_attempt_missing');
    const bundle = proofBundle || readProofBundle(attempt);
    bundle.markType = attempt.markType;
    bundle.phoneExceptions = attempt.markType === 'ARRIVAL'
      ? [...phoneExceptionSet(attempt.serviceRequestId)].map((workerId) => ({
          workerId,
          reason: PHONE_EXCEPTION_REASON
        }))
      : [];
    const nativeLocation = nativeLocationFromBundle(bundle);
    const offline = window.LorrenWorkerPortalOffline;
    if (typeof offline?.queueCrewPresence !== 'function') throw new Error('offline_queue_unavailable');
    const queued = await offline.queueCrewPresence({ ...attempt, ...nativeLocation, proofBundle: bundle });
    rememberQueuedMark(attempt.serviceRequestId, attempt.markType);
    if (navigator.onLine && typeof offline.syncNow === 'function') offline.syncNow().catch(() => {});
    return { queued, proofCount: bundle.proofs.length, markType: attempt.markType };
  }

  function finishCompletedScan(completion) {
    if (!completion || !activeAttempt) return;
    const completionMarkType = normalizeMarkType(completion.markType || activeAttempt.markType) || 'ARRIVAL';
    let proofBundle;
    try {
      proofBundle = readProofBundle(activeAttempt);
    } catch (error) {
      pendingCompletedScan = null;
      activeAttempt = null;
      setStatus(publicNativeError(error?.message), 'error');
      return;
    }
    const proofCount = proofBundle.proofs.length;
    const noAuxiliaryDetected = completion.expectedProofCount > 0 && proofCount === 0;
    if (noAuxiliaryDetected) {
      const pendingCount = completion.expectedProofCount;
      activeAttempt = null;
      pendingCompletedScan = null;
      retryNotDetectedCount = pendingCount;
      retryMarkType = completionMarkType;
      hasCompletedLeaderScan = true;
      renderPanel();
      if (autoRetryRemaining > 0) {
        autoRetryRemaining -= 1;
        setStatus(
          `No se detectó ningún auxiliar para la ${markInfo(completionMarkType).noun}. Reintentando automáticamente una vez…`,
          'warning'
        );
        autoRetryTimer = window.setTimeout(() => {
          autoRetryTimer = null;
          startLeaderScan(completionMarkType, true);
        }, AUTO_RETRY_DELAY_MS);
        return;
      }
      setStatus(
        `No se detectó ningún auxiliar. La ${markInfo(completionMarkType).noun} no se guardó; vuelve a intentarlo cuando sus teléfonos estén disponibles.`,
        'error'
      );
      markRetryAvailable(completionMarkType);
      return;
    }

    queueCompletedAttempt(proofBundle)
      .then(({ proofCount: queuedProofCount }) => {
        activeAttempt = null;
        pendingCompletedScan = null;
        retryNotDetectedCount = Math.max(0, completion.expectedProofCount - queuedProofCount);
        const incomplete = retryNotDetectedCount > 0;
        hasCompletedLeaderScan = incomplete;
        retryMarkType = incomplete ? completionMarkType : '';
        renderPanel();
        if (incomplete && autoRetryRemaining > 0) {
          autoRetryRemaining -= 1;
          setStatus(
            `Faltan respuestas para la ${markInfo(completionMarkType).noun}. Lórren reintentará automáticamente una vez.`,
            'warning'
          );
          autoRetryTimer = window.setTimeout(() => {
            autoRetryTimer = null;
            startLeaderScan(completionMarkType, true);
          }, AUTO_RETRY_DELAY_MS);
          return;
        }
        setStatus(
          navigator.onLine
            ? `${markInfo(completionMarkType).title} de cuadrilla enviada; esperando confirmación del servidor.`
            : `${markInfo(completionMarkType).title} de cuadrilla guardada sin conexión; pendiente de sincronizar cuando vuelva Internet.`,
          'warning'
        );
        if (incomplete) markRetryAvailable(completionMarkType);
      })
      .catch((error) => {
        if (error?.message === 'native_location_unavailable' && activeAttempt) {
          pendingCompletedScan = completion;
          setStatus(
            `Teléfonos comprobados. Esperando la mejor ubicación del encargado para guardar la ${markInfo(completionMarkType).noun}…`,
            'warning'
          );
          return;
        }
        pendingCompletedScan = null;
        setStatus(publicNativeError(error?.message), 'error');
      });
  }

  function handleNativeEvent(event) {
    const detail = event?.detail;
    if (!detail || typeof detail !== 'object') return;
    const type = String(detail.type || '');
    if (type === 'permissions') {
      const context = currentContext();
      if (detail.granted && context && !context.isCrewLeader) {
        setStatus('Permisos listos. Preparando Bluetooth…', 'warning');
        scheduleAuxiliaryRearm();
      } else {
        setStatus(detail.granted
          ? 'Permisos listos. Pulsa nuevamente para continuar.'
          : 'Android no autorizó los permisos necesarios para detectar teléfonos cercanos.', detail.granted ? 'warning' : 'error');
      }
      return;
    }
    if (type === 'bluetooth') {
      const context = currentContext();
      if (detail.enabled && context && !context.isCrewLeader) {
        setStatus('Bluetooth listo. Preparando escucha local…', 'warning');
        scheduleAuxiliaryRearm();
      } else {
        setStatus(detail.enabled
          ? 'Bluetooth listo. Pulsa nuevamente para continuar.'
          : 'Bluetooth sigue apagado. Actívalo para continuar.', detail.enabled ? 'warning' : 'error');
      }
      return;
    }
    if (type === 'ready') {
      const context = currentContext();
      if (!context || context.isCrewLeader) return;
      activeMode = 'READY';
      setStatus('Bluetooth listo. Esperando la marcación del encargado.', '');
      showStop();
      return;
    }
    if (type === 'scan_started') {
      activeMode = 'LEADER';
      const markType = normalizeMarkType(activeAttempt?.markType) || 'ARRIVAL';
      setStatus(`Buscando señales de la cuadrilla para ${markInfo(markType).noun}…`, 'warning');
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
      setStatus(`${scanVerifiedCount} respuesta${scanVerifiedCount === 1 ? '' : 's'} recibida${scanVerifiedCount === 1 ? '' : 's'}.`, '');
      return;
    }
    if (type === 'proof_sent') {
      setStatus('Presencia enviada al encargado para esta marcación.', '');
      return;
    }
    if (type === 'native_location_ready') {
      if (pendingCompletedScan && activeAttempt) {
        const completion = pendingCompletedScan;
        const markType = normalizeMarkType(completion.markType || activeAttempt.markType) || 'ARRIVAL';
        pendingCompletedScan = null;
        setStatus(`Ubicación lista. Guardando la ${markInfo(markType).noun} de la cuadrilla…`, 'warning');
        finishCompletedScan(completion);
      }
      return;
    }
    if (type === 'scan_complete') {
      scanVerifiedCount = Math.max(scanVerifiedCount, Number(detail.verifiedCount || 0));
      scanPendingCount = 0;
      updateCount();
      activeMode = 'IDLE';
      const markType = normalizeMarkType(activeAttempt?.markType) || 'ARRIVAL';
      const stop = document.querySelector(`#${PANEL_ID} [data-native-presence-stop]`);
      if (stop) stop.hidden = true;
      const completion = {
        markType,
        transientFailures: scanTransientFailureCount,
        expectedProofCount: Math.max(0, Number(activeAttempt?.expectedProofCount ?? detail.expectedProofCount ?? 0))
      };
      pendingCompletedScan = completion;
      finishCompletedScan(completion);
      return;
    }
    if (type === 'stopped') {
      if (activeMode !== 'PREPARING') activeMode = 'IDLE';
      if (activeMode === 'IDLE') pendingCompletedScan = null;
      return;
    }
    if (type === 'error') {
      const code = String(detail.code || 'native_error');
      if (activeMode === 'LEADER' && TRANSIENT_SCAN_ERRORS.has(code)) scanTransientFailureCount += 1;
      if (NATIVE_START_ERRORS.has(code)) {
        activeMode = 'IDLE';
        activeAttempt = null;
        pendingCompletedScan = null;
        renderPanel();
      } else if (pendingCompletedScan && ['native_location_unavailable', 'native_location_proof_failed'].includes(code)) {
        pendingCompletedScan = null;
      }
      setStatus(publicNativeError(code), TRANSIENT_SCAN_ERRORS.has(code) ? 'warning' : 'error');
    }
  }

  async function handleServiceWorkerMessage(event) {
    const message = event?.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'CREW_PRESENCE_SYNCED') {
      const payload = message.payload || {};
      const serviceRequestId = String(payload.serviceRequestId || selectedServiceRequestId || '').trim();
      const markType = normalizeMarkType(payload.markType) || 'ARRIVAL';
      forgetQueuedMark(serviceRequestId, markType);
      if (serviceRequestId) setMemberServerStatuses(serviceRequestId, markType, payload.memberStatuses);
      if (navigator.onLine) contexts = await loadContexts();
      const context = contexts.find((item) => item.serviceRequestId === serviceRequestId) || currentContext();
      retryNotDetectedCount = pendingAuxiliaryCount(context, markType);
      retryMarkType = retryNotDetectedCount > 0 ? markType : '';
      hasCompletedLeaderScan = retryNotDetectedCount > 0;
      pendingPhoneExceptionWorkerId = '';
      renderPanel();
      setStatus(`${markInfo(markType).title} de cuadrilla confirmada por el servidor. ${payload.message || ''}`.trim(), payload.requiresReview ? 'warning' : '');
      if (retryNotDetectedCount > 0) markRetryAvailable(markType);
      if (navigator.onLine) window.setTimeout(() => window.location.reload(), 500);
      return;
    }
    if (message.type === 'CREW_PRESENCE_SYNC_REJECTED') {
      const serviceRequestId = String(message.serviceRequestId || message.payload?.serviceRequestId || selectedServiceRequestId || '').trim();
      const queuedMarkType = [...queuedMarkSet(serviceRequestId)].map(normalizeMarkType).find(Boolean) || null;
      const markType = normalizeMarkType(message.payload?.markType)
        || queuedMarkType
        || normalizeMarkType(retryMarkType)
        || 'ARRIVAL';
      forgetQueuedMark(serviceRequestId, markType);
      renderPanel();
      setStatus(`No fue posible registrar la ${markInfo(markType).noun} de la cuadrilla. La marca no quedó confirmada; puedes intentarlo nuevamente.`, 'error');
      return;
    }
    if (message.type === 'CREW_PRESENCE_SYNC_RETRY') {
      if (Number(message.retryAfterMs || 0) > 0) {
        const markType = normalizeMarkType(retryMarkType) || onlineQueuedMarkType(currentContext()) || 'ARRIVAL';
        setStatus(`La ${markInfo(markType).noun} de cuadrilla sigue enviada pero aún no está confirmada. Lórren la reintentará automáticamente.`, 'warning');
      }
    }
  }

  async function initialize() {
    const caps = capabilities();
    if (!caps?.androidNative || caps?.offlineNearby !== true || caps?.attendanceWriter !== false) return;
    observeLegacyControls();
    contexts = await loadContexts();
    await hydrateLocalQueuedMarks();
    if (navigator.onLine && !credentialPrepared()) await provisionCredential();
    renderPanel();
    await ensureAuxiliaryReady();
  }

  window.addEventListener('lorren-native-presence', handleNativeEvent);
  navigator.serviceWorker?.addEventListener('message', (event) => {
    handleServiceWorkerMessage(event).catch(() => {});
  });
  window.addEventListener('online', async () => {
    contexts = await loadContexts();
    if (!credentialPrepared()) await provisionCredential();
    await hydrateLocalQueuedMarks();
    renderPanel();
    await ensureAuxiliaryReady();
    window.LorrenWorkerPortalOffline?.syncNow?.().catch(() => {});
  });
  window.addEventListener('offline', () => {
    renderPanel();
    ensureAuxiliaryReady().catch(() => {});
  });
  window.addEventListener('focus', scheduleAuxiliaryRearm);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleAuxiliaryRearm();
  });
  window.addEventListener('beforeunload', stopNativeModes, { once: true });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
