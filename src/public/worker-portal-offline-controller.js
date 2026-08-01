'use strict';

(() => {
  if (window.location.pathname !== '/operaciones/portal') return;

  const offlineApi = window.LorrenWorkerPortalOffline;
  if (!offlineApi) return;

  const connectivityBar = document.getElementById('portal-connectivity');
  const connectivityTitle = document.getElementById('connectivity-title');
  const dialog = document.getElementById('mark-dialog');
  const title = document.getElementById('mark-title');
  const resultBox = document.getElementById('mark-result');
  const locationStatus = document.getElementById('location-status');
  const cameraStep = document.getElementById('camera-step');
  const cameraVideo = document.getElementById('camera-video');
  const photoPreview = document.getElementById('photo-preview');
  const photoConsentWrap = document.getElementById('photo-consent-wrap');
  const photoConsent = document.getElementById('photo-consent');
  const submitButton = document.getElementById('submit-mark');
  const closeButton = document.getElementById('close-mark');
  const cancelButton = document.getElementById('cancel-mark');

  if (!dialog || !resultBox || !locationStatus || !submitButton) return;

  const MARK_STAGE = Object.freeze({ ARRIVAL: 1, BREAK_START: 2, BREAK_END: 3, DEPARTURE: 4 });
  const LABELS = Object.freeze({
    ARRIVAL: 'llegada',
    BREAK_START: 'inicio de almuerzo',
    BREAK_END: 'fin de almuerzo',
    DEPARTURE: 'salida'
  });

  let active = false;
  let stream = null;
  let locationEvidence = null;
  let assignmentId = null;
  let markType = null;
  let lastQueueSize = null;
  let reloadScheduled = false;

  function setStatus(message, tone = 'neutral') {
    resultBox.hidden = false;
    resultBox.className = `status mark-status ${tone === 'neutral' ? '' : tone}`.trim();
    resultBox.textContent = message;
  }

  function showDialog() {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function hideDialog() {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function stopCamera() {
    stream?.getTracks?.().forEach((track) => track.stop());
    stream = null;
    if (cameraVideo) {
      cameraVideo.srcObject = null;
      cameraVideo.hidden = true;
    }
  }

  function resetPreview() {
    if (!photoPreview) return;
    const current = photoPreview.src;
    if (current?.startsWith('blob:')) URL.revokeObjectURL(current);
    photoPreview.removeAttribute('src');
    photoPreview.hidden = true;
  }

  function closeOfflineDialog() {
    if (!active) return;
    active = false;
    stopCamera();
    resetPreview();
    locationEvidence = null;
    assignmentId = null;
    markType = null;
    if (photoConsent) photoConsent.checked = false;
    hideDialog();
  }

  function updateSubmitState() {
    submitButton.disabled = !active || !locationEvidence || !stream || photoConsent?.checked !== true;
  }

  async function startCamera() {
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera_unavailable');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 720 },
        height: { ideal: 960 }
      }
    });
    const track = stream.getVideoTracks?.()[0];
    if (!track || track.readyState !== 'live') throw new Error('camera_unavailable');
    cameraVideo.srcObject = stream;
    cameraVideo.hidden = false;
    await cameraVideo.play();
    updateSubmitState();
  }

  function requestLocation() {
    if (!navigator.geolocation) {
      locationStatus.textContent = 'Este navegador no permite obtener la ubicación.';
      setStatus('No fue posible preparar la marcación sin conexión.', 'danger');
      return;
    }
    locationStatus.textContent = 'Solicitando ubicación actual…';
    navigator.geolocation.getCurrentPosition((position) => {
      if (!active) return;
      locationEvidence = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy,
        clientCapturedAt: new Date(position.timestamp || Date.now()).toISOString()
      };
      locationStatus.textContent = `Ubicación lista · precisión ${Math.round(position.coords.accuracy)} m`;
      updateSubmitState();
    }, (error) => {
      if (!active) return;
      locationEvidence = null;
      locationStatus.textContent = error?.code === 1
        ? 'Permiso de ubicación rechazado.'
        : 'No fue posible obtener la ubicación.';
      setStatus('Activa la ubicación para guardar la marcación.', 'warning');
      updateSubmitState();
    }, {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 0
    });
  }

  function newIdempotencyKey() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `offline_${Date.now()}_${Math.random().toString(36).slice(2, 18)}`;
  }

  function captureSelfie() {
    if (!cameraVideo?.videoWidth || !cameraVideo?.videoHeight) throw new Error('camera_frame_unavailable');
    const canvas = document.createElement('canvas');
    const maxWidth = 720;
    const scale = Math.min(1, maxWidth / cameraVideo.videoWidth);
    canvas.width = Math.max(1, Math.round(cameraVideo.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(cameraVideo.videoHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('camera_frame_unavailable');
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) reject(new Error('camera_frame_unavailable'));
        else resolve(blob);
      }, 'image/jpeg', 0.82);
    });
  }

  function createMarkButton(type, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mark-button${type.startsWith('BREAK_') ? ' break' : type === 'DEPARTURE' ? ' departure' : ''}`;
    button.dataset.assignmentId = assignmentId || '';
    button.dataset.markType = type;
    button.textContent = type === 'ARRIVAL'
      ? 'Registrar llegada'
      : type === 'BREAK_START'
        ? 'Iniciar almuerzo'
        : type === 'BREAK_END'
          ? 'Finalizar almuerzo'
          : 'Registrar salida';
    button.disabled = disabled;
    return button;
  }

  function baselineStage(card) {
    if (!card) return 0;
    if (card.classList.contains('completed')) return 4;
    if (card.querySelector('[data-mark-type="BREAK_END"]')) return 2;
    if (card.querySelector('[data-mark-type="BREAK_START"]')) return 1;
    if (card.querySelector('[data-mark-type="ARRIVAL"]')) return 0;
    if (card.querySelector('[data-mark-type="DEPARTURE"]')) return 3;
    return 4;
  }

  function renderStage(targetAssignmentId, stage) {
    const card = [...document.querySelectorAll('[data-assignment-card]')]
      .find((candidate) => String(candidate.dataset.assignmentCard || '') === String(targetAssignmentId));
    const grid = card?.querySelector('.action-grid');
    if (!card || !grid || stage <= baselineStage(card)) return;
    assignmentId = String(targetAssignmentId);
    grid.replaceChildren();
    if (stage === 1) {
      grid.append(createMarkButton('BREAK_START'), createMarkButton('DEPARTURE'));
    } else if (stage === 2) {
      grid.append(createMarkButton('BREAK_END'), createMarkButton('DEPARTURE', true));
    } else if (stage === 3) {
      grid.append(createMarkButton('DEPARTURE'));
    } else {
      const done = document.createElement('button');
      done.type = 'button';
      done.className = 'mark-button';
      done.disabled = true;
      done.textContent = 'Jornada finalizada';
      grid.append(done);
      card.classList.add('completed');
    }
    assignmentId = null;
  }

  function stateStage(records) {
    const stages = new Map();
    const sorted = [...records].sort((left, right) => {
      const leftDate = String(left.clientCapturedAt || left.capturedAt || left.queuedAt || left.completedAt || '');
      const rightDate = String(right.clientCapturedAt || right.capturedAt || right.queuedAt || right.completedAt || '');
      return leftDate.localeCompare(rightDate);
    });
    for (const record of sorted) {
      const id = String(record.assignmentId || '');
      const stage = MARK_STAGE[String(record.markType || '').toUpperCase()] || 0;
      if (id && stage) stages.set(id, Math.max(stages.get(id) || 0, stage));
    }
    return stages;
  }

  function enableOfflineButtons() {
    if (navigator.onLine) return;
    document.querySelectorAll('.mark-button[data-mark-type]').forEach((button) => {
      if (!button.hasAttribute('data-server-disabled')) button.disabled = false;
    });
  }

  async function hydrateLocalState(state) {
    const records = [...(state?.receipts || []), ...(state?.queue || [])];
    for (const [id, stage] of stateStage(records)) renderStage(id, stage);
    enableOfflineButtons();
  }

  function renderConnectivity(state = {}) {
    const online = navigator.onLine;
    connectivityBar?.classList.toggle('offline', !online);
    if (connectivityTitle) {
      const pending = Array.isArray(state.queue) ? state.queue.length : 0;
      connectivityTitle.textContent = online
        ? (pending ? `Con conexión · sincronizando ${pending}` : 'Con conexión')
        : (pending ? `Sin conexión · ${pending} marcación${pending === 1 ? '' : 'es'} guardada${pending === 1 ? '' : 's'}` : 'Sin conexión · puedes marcar');
    }
  }

  function maybeReloadAfterSync(state = {}) {
    if (!navigator.onLine || reloadScheduled) return;
    const queueSize = Array.isArray(state.queue) ? state.queue.length : 0;
    if (lastQueueSize !== null && lastQueueSize > 0 && queueSize === 0) {
      reloadScheduled = true;
      window.setTimeout(() => window.location.reload(), 450);
    }
    lastQueueSize = queueSize;
  }

  async function openOfflineDialog(button) {
    if (navigator.onLine || button.hasAttribute('data-server-disabled')) return;
    active = true;
    assignmentId = String(button.dataset.assignmentId || '');
    markType = String(button.dataset.markType || '').toUpperCase();
    locationEvidence = null;
    stopCamera();
    resetPreview();
    if (photoConsent) photoConsent.checked = false;
    title.textContent = `Guardar ${LABELS[markType] || 'marcación'} sin conexión`;
    submitButton.textContent = `Guardar ${LABELS[markType] || 'marcación'}`;
    submitButton.disabled = true;
    cameraStep.hidden = false;
    photoConsentWrap.hidden = false;
    dialog.dataset.flowState = 'offline';
    locationStatus.textContent = 'Solicitando ubicación actual…';
    setStatus('Sin conexión: se guardarán la hora, la ubicación y una selfie para sincronizarlas después.', 'warning');
    showDialog();
    requestLocation();
    window.setTimeout(() => photoConsent?.focus({ preventScroll: true }), 0);
  }

  async function handleConsentChange(event) {
    if (!active || navigator.onLine) return;
    event.stopImmediatePropagation();
    if (!photoConsent.checked) {
      stopCamera();
      setStatus('Autoriza la captura para guardar la marcación sin conexión.', 'warning');
      updateSubmitState();
      return;
    }
    setStatus('Abriendo cámara frontal…', 'neutral');
    try {
      await startCamera();
      setStatus('Mira de frente. La selfie quedará guardada únicamente para validar esta marcación.', 'neutral');
    } catch {
      stopCamera();
      setStatus('No fue posible abrir la cámara frontal.', 'danger');
      photoConsent.checked = false;
    }
    updateSubmitState();
  }

  async function submitOfflineMark(event) {
    if (!active || navigator.onLine) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!assignmentId || !markType || !locationEvidence || photoConsent?.checked !== true) return;
    submitButton.disabled = true;
    submitButton.textContent = 'Guardando…';
    try {
      const selfie = await captureSelfie();
      stopCamera();
      if (photoPreview) {
        resetPreview();
        photoPreview.src = URL.createObjectURL(selfie);
        photoPreview.hidden = false;
      }
      const record = await offlineApi.queueMark({
        idempotencyKey: newIdempotencyKey(),
        assignmentId,
        markType,
        latitude: locationEvidence.latitude,
        longitude: locationEvidence.longitude,
        accuracyMeters: locationEvidence.accuracyMeters,
        clientCapturedAt: locationEvidence.clientCapturedAt,
        photoConsent: true,
        selfie
      });
      renderStage(record.assignmentId, MARK_STAGE[record.markType]);
      setStatus('Marcación guardada en este teléfono. Se enviará automáticamente cuando vuelva la conexión.', 'ok');
      submitButton.textContent = 'Guardada';
      window.setTimeout(closeOfflineDialog, 1100);
    } catch (error) {
      setStatus(error?.message === 'offline_mark_selfie_invalid'
        ? 'La captura fue demasiado grande. Intenta nuevamente.'
        : 'No fue posible guardar la marcación en el teléfono.', 'danger');
      submitButton.disabled = false;
      submitButton.textContent = `Guardar ${LABELS[markType] || 'marcación'}`;
      if (photoConsent?.checked && !stream) startCamera().catch(() => {});
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('.mark-button[data-mark-type]');
    if (!button || navigator.onLine) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openOfflineDialog(button).catch(() => setStatus('No fue posible preparar la marcación.', 'danger'));
  }, true);

  photoConsent?.addEventListener('change', handleConsentChange, true);
  submitButton.addEventListener('click', submitOfflineMark, true);
  closeButton?.addEventListener('click', (event) => {
    if (!active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeOfflineDialog();
  }, true);
  cancelButton?.addEventListener('click', (event) => {
    if (!active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeOfflineDialog();
  }, true);
  dialog.addEventListener('cancel', (event) => {
    if (!active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeOfflineDialog();
  }, true);

  const disabledObserver = new MutationObserver(() => enableOfflineButtons());
  disabledObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['disabled'] });

  window.addEventListener('offline', () => {
    renderConnectivity();
    window.setTimeout(enableOfflineButtons, 0);
  });
  window.addEventListener('online', () => {
    if (active) closeOfflineDialog();
    renderConnectivity();
    offlineApi.syncNow().catch(() => {});
  });

  offlineApi.init({
    onStateChange: (state) => {
      renderConnectivity(state);
      hydrateLocalState(state).catch(() => {});
      maybeReloadAfterSync(state);
    }
  }).then((state) => {
    renderConnectivity(state);
    return hydrateLocalState(state);
  }).catch(() => {
    renderConnectivity();
    enableOfflineButtons();
  });
})();
