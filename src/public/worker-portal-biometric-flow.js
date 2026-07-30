'use strict';

(() => {
  if (window.location.pathname !== '/operaciones/portal') return;

  const biometricApi = window.LorrenWorkerBiometric || null;
  const markButtons = [...document.querySelectorAll('.mark-button[data-mark-type]')];
  const connectivityBar = document.getElementById('portal-connectivity');
  const connectivityTitle = document.getElementById('connectivity-title');

  const enrollmentDialog = document.getElementById('enrollment-dialog');
  const enrollmentVideo = document.getElementById('enrollment-video');
  const enrollmentStatus = document.getElementById('enrollment-status');
  const enrollmentConsent = document.getElementById('enrollment-consent');
  const startEnrollmentButton = document.getElementById('start-enrollment');

  const dialog = document.getElementById('mark-dialog');
  const title = document.getElementById('mark-title');
  const closeMarkButton = document.getElementById('close-mark');
  const locationStatus = document.getElementById('location-status');
  const cameraStep = document.getElementById('camera-step');
  const biometricInstruction = document.getElementById('biometric-instruction');
  const cameraVideo = document.getElementById('camera-video');
  const photoPreview = document.getElementById('photo-preview');
  const photoConsentWrap = document.getElementById('photo-consent-wrap');
  const photoConsent = document.getElementById('photo-consent');
  const retryBiometricButton = document.getElementById('retry-biometric');
  const submitButton = document.getElementById('submit-mark');
  const cancelMarkButton = document.getElementById('cancel-mark');
  const resultBox = document.getElementById('mark-result');

  if (!dialog || !resultBox || !submitButton) return;

  const MAX_AUTOMATIC_ATTEMPTS = 2;
  const FLOW_VERSION = '2026-07-30-single-controller-v1';

  let biometricReady = false;
  let enrollmentStream = null;
  let cameraStream = null;
  let photoUrl = null;
  let runToken = 0;
  let verificationInProgress = false;

  const state = {
    assignmentId: null,
    markType: null,
    locationEvidence: null,
    photoBlob: null,
    idempotencyKey: null,
    biometricChallenge: null,
    biometricVerified: false
  };

  const isBiometricMark = () => state.markType === 'ARRIVAL' || state.markType === 'DEPARTURE';
  const endpointFor = (type) => ({
    ARRIVAL: 'llegada',
    BREAK_START: 'inicio-almuerzo',
    BREAK_END: 'fin-almuerzo',
    DEPARTURE: 'salida'
  })[type];
  const labelFor = (type) => ({
    ARRIVAL: 'llegada',
    BREAK_START: 'inicio de almuerzo',
    BREAK_END: 'fin de almuerzo',
    DEPARTURE: 'salida'
  })[type] || 'marcación';

  function newIdempotencyKey() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${String(state.markType || 'mark').toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
  }

  function showModal(target) {
    if (typeof target?.showModal === 'function') target.showModal();
    else target?.setAttribute('open', '');
  }

  function closeModal(target) {
    if (typeof target?.close === 'function') target.close();
    else target?.removeAttribute('open');
  }

  function stopStream(stream) {
    stream?.getTracks?.().forEach((track) => track.stop());
  }

  function stopCamera() {
    stopStream(cameraStream);
    cameraStream = null;
    if (cameraVideo) {
      cameraVideo.srcObject = null;
      cameraVideo.hidden = true;
    }
  }

  function clearPhoto() {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null;
    state.photoBlob = null;
    if (photoPreview) {
      photoPreview.removeAttribute('src');
      photoPreview.hidden = true;
    }
  }

  function setStatus(message, tone = 'neutral') {
    resultBox.hidden = false;
    resultBox.className = `status mark-status ${tone === 'neutral' ? '' : tone}`.trim();
    resultBox.textContent = message;
  }

  function setInstruction(message) {
    if (biometricInstruction) biometricInstruction.textContent = message;
    setStatus(message, 'neutral');
  }

  function publicErrorMessage(error) {
    const code = String(error?.message || '');
    const messages = {
      camera_unavailable: 'No fue posible abrir la cámara frontal.',
      camera_stream_unavailable: 'La cámara no entregó imagen. Cierra otras aplicaciones que puedan estar usándola.',
      biometric_runtime_unavailable: 'El reconocimiento facial no pudo cargarse. Revisa la conexión.',
      biometric_capture_timeout: 'No se obtuvo una captura estable dentro del tiempo disponible.',
      biometric_challenge_not_completed: 'No se confirmó el movimiento solicitado.',
      biometric_descriptor_unavailable: 'No se pudieron leer correctamente los rasgos del rostro.',
      biometric_descriptor_inconsistent: 'La imagen cambió demasiado durante la validación.',
      biometric_verification_rejected: 'El rostro no coincide con el registrado.',
      attendance_biometric_antispoof_low: 'No se confirmó un rostro real.',
      attendance_biometric_liveness_low: 'No se confirmó el movimiento solicitado.',
      biometric_enrollment_required: 'Debes registrar nuevamente tu rostro antes de marcar.',
      portal_session_required: 'Tu sesión del portal venció.',
      assignment_not_available: 'La asignación ya no está disponible para marcar.',
      biometric_request_invalid: 'No fue posible preparar la validación facial.'
    };
    return messages[code] || 'No fue posible confirmar tu identidad.';
  }

  function updateSubmitState() {
    submitButton.disabled = !navigator.onLine
      || !state.locationEvidence
      || (isBiometricMark() && (!state.biometricVerified || !state.photoBlob || !photoConsent?.checked));
  }

  function setButtonsReady(ready) {
    biometricReady = ready;
    markButtons.forEach((button) => {
      const serverDisabled = button.hasAttribute('data-server-disabled');
      if (!serverDisabled) button.disabled = !ready;
    });
  }

  markButtons.forEach((button) => {
    if (button.disabled) button.setAttribute('data-server-disabled', 'true');
    button.disabled = true;
  });

  async function portalBiometricRequest(path, body = {}) {
    const response = await fetch(`/operaciones/portal/biometria/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'worker-portal'
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      const error = new Error(payload.error || 'biometric_request_failed');
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function loadBiometricStatus() {
    try {
      const status = await portalBiometricRequest('estado');
      if (status.enrolled) {
        setButtonsReady(true);
        return;
      }
      setButtonsReady(false);
      showModal(enrollmentDialog);
      enrollmentConsent?.focus({ preventScroll: true });
    } catch {
      setButtonsReady(false);
      if (enrollmentStatus) {
        enrollmentStatus.textContent = 'No fue posible validar el registro facial. Recarga la página.';
        enrollmentStatus.className = 'status danger';
      }
      showModal(enrollmentDialog);
      if (startEnrollmentButton) startEnrollmentButton.disabled = true;
    }
  }

  async function enrollFace() {
    if (!enrollmentConsent?.checked) {
      if (enrollmentStatus) {
        enrollmentStatus.textContent = 'Debes autorizar el registro facial.';
        enrollmentStatus.className = 'status warning';
      }
      enrollmentConsent?.focus({ preventScroll: true });
      return;
    }

    if (!startEnrollmentButton || !enrollmentStatus || !enrollmentVideo) return;
    startEnrollmentButton.disabled = true;
    enrollmentConsent.disabled = true;
    enrollmentStatus.textContent = 'Abriendo cámara…';
    enrollmentStatus.className = 'status';

    try {
      if (!navigator.onLine || !biometricApi) throw new Error('camera_unavailable');
      await biometricApi.prepare?.();
      enrollmentStream = await biometricApi.startCamera(enrollmentVideo);
      const capture = await biometricApi.captureEnrollment({
        video: enrollmentVideo,
        onStatus: (message) => { enrollmentStatus.textContent = message; }
      });
      await portalBiometricRequest('registrar', {
        descriptor: capture.descriptor,
        realScore: capture.realScore,
        liveScore: capture.liveScore,
        modelVersion: capture.modelVersion,
        consentAccepted: true
      });
      enrollmentStatus.textContent = 'Rostro registrado.';
      enrollmentStatus.className = 'status ok';
      stopStream(enrollmentStream);
      enrollmentStream = null;
      enrollmentVideo.srcObject = null;
      setButtonsReady(true);
      window.setTimeout(() => closeModal(enrollmentDialog), 500);
    } catch (error) {
      stopStream(enrollmentStream);
      enrollmentStream = null;
      enrollmentVideo.srcObject = null;
      enrollmentVideo.hidden = true;
      enrollmentStatus.textContent = publicErrorMessage(error);
      enrollmentStatus.className = 'status danger';
      startEnrollmentButton.disabled = false;
      enrollmentConsent.disabled = false;
    }
  }

  function requestLocation(localRunToken) {
    if (!navigator.geolocation) {
      setStatus('Este navegador no permite obtener la ubicación.', 'danger');
      return;
    }

    locationStatus.textContent = 'Solicitando ubicación…';
    navigator.geolocation.getCurrentPosition((position) => {
      if (localRunToken !== runToken || !dialog.open) return;
      state.locationEvidence = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy,
        clientCapturedAt: new Date(position.timestamp || Date.now()).toISOString()
      };
      locationStatus.textContent = `Ubicación lista · precisión ${Math.round(position.coords.accuracy)} m`;
      updateSubmitState();
    }, (error) => {
      if (localRunToken !== runToken || !dialog.open) return;
      locationStatus.textContent = error?.code === 1
        ? 'Permiso de ubicación rechazado.'
        : 'No fue posible obtener la ubicación.';
      setStatus('Activa la ubicación para continuar.', 'warning');
    }, {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 0
    });
  }

  async function requestBiometricChallenge() {
    state.idempotencyKey = newIdempotencyKey();
    const payload = await portalBiometricRequest('desafio', {
      assignmentId: state.assignmentId,
      markType: state.markType,
      idempotencyKey: state.idempotencyKey
    });
    if (!payload.challenge) throw new Error('biometric_challenge_failed');
    state.biometricChallenge = payload.challenge;
    return payload.challenge;
  }

  async function verifyBiometric(capture) {
    return portalBiometricRequest('verificar', {
      assignmentId: state.assignmentId,
      markType: state.markType,
      idempotencyKey: state.idempotencyKey,
      challengeToken: state.biometricChallenge?.token,
      challengeAction: capture.challengeAction,
      challengeCompleted: capture.challengeCompleted,
      descriptor: capture.descriptor,
      realScore: capture.realScore,
      liveScore: capture.liveScore,
      modelVersion: capture.modelVersion,
      consentAccepted: photoConsent?.checked === true
    });
  }

  function setVerifiedPhoto(blob) {
    clearPhoto();
    state.photoBlob = blob;
    photoUrl = URL.createObjectURL(blob);
    photoPreview.src = photoUrl;
    photoPreview.hidden = false;
    cameraVideo.hidden = true;
    stopCamera();
    retryBiometricButton.hidden = true;
    updateSubmitState();
  }

  async function runSingleVerificationAttempt(localRunToken, attemptNumber) {
    if (localRunToken !== runToken || !dialog.open) throw new Error('biometric_flow_cancelled');
    stopCamera();
    clearPhoto();
    state.biometricVerified = false;
    updateSubmitState();

    setStatus(
      attemptNumber === 1 ? 'Preparando reconocimiento facial…' : 'Segundo intento automático…',
      'neutral'
    );

    if (!biometricApi || !navigator.onLine) throw new Error('camera_unavailable');
    await biometricApi.prepare?.();

    const challenge = await requestBiometricChallenge();
    const stream = await biometricApi.startCamera(cameraVideo);

    if (localRunToken !== runToken || !dialog.open) {
      stopStream(stream);
      throw new Error('biometric_flow_cancelled');
    }

    cameraStream = stream;
    cameraVideo.hidden = false;
    state.biometricChallenge = challenge;

    const capture = await biometricApi.captureVerification({
      video: cameraVideo,
      challenge,
      onStatus: (message) => {
        if (localRunToken !== runToken || !dialog.open) return;
        setInstruction(message);
      }
    });

    if (localRunToken !== runToken || !dialog.open) throw new Error('biometric_flow_cancelled');
    setStatus('Comparando con el rostro registrado…', 'neutral');
    const verification = await verifyBiometric(capture);
    if (verification.verified !== true) throw new Error('biometric_verification_rejected');

    state.biometricVerified = true;
    setVerifiedPhoto(capture.photoBlob);
    setInstruction('Identidad verificada.');
    setStatus('Identidad verificada. Ya puedes registrar la marcación.', 'ok');
    submitButton.focus({ preventScroll: true });
  }

  async function runAutomaticVerification() {
    if (verificationInProgress || !dialog.open || !isBiometricMark()) return;
    if (!photoConsent?.checked) {
      setStatus('Autoriza el uso de la cámara para comenzar.', 'warning');
      photoConsent?.focus({ preventScroll: true });
      return;
    }

    const localRunToken = runToken;
    verificationInProgress = true;
    retryBiometricButton.hidden = true;
    photoConsent.disabled = true;
    dialog.dataset.flowState = 'verifying';

    let lastError = null;
    try {
      for (let attempt = 1; attempt <= MAX_AUTOMATIC_ATTEMPTS; attempt += 1) {
        try {
          await runSingleVerificationAttempt(localRunToken, attempt);
          return;
        } catch (error) {
          lastError = error;
          stopCamera();
          if (String(error?.message || '') === 'biometric_flow_cancelled') return;
          if (attempt < MAX_AUTOMATIC_ATTEMPTS) {
            setStatus('La primera lectura no concluyó. Reintentando automáticamente…', 'warning');
            await new Promise((resolve) => window.setTimeout(resolve, 500));
          }
        }
      }

      state.biometricVerified = false;
      clearPhoto();
      setStatus(`${publicErrorMessage(lastError)} Puedes intentar nuevamente.`, 'danger');
      retryBiometricButton.hidden = false;
      retryBiometricButton.focus({ preventScroll: true });
    } finally {
      verificationInProgress = false;
      if (localRunToken === runToken && dialog.open) {
        photoConsent.disabled = false;
        dialog.dataset.flowState = state.biometricVerified ? 'verified' : 'failed';
        updateSubmitState();
      }
    }
  }

  function resetMarkDialog() {
    runToken += 1;
    verificationInProgress = false;
    stopCamera();
    clearPhoto();

    state.locationEvidence = null;
    state.idempotencyKey = null;
    state.biometricChallenge = null;
    state.biometricVerified = false;

    if (photoConsent) {
      photoConsent.checked = false;
      photoConsent.disabled = false;
    }

    resultBox.hidden = false;
    locationStatus.textContent = 'Solicitando ubicación…';
    biometricInstruction.textContent = 'Mira de frente.';
    cameraStep.hidden = !isBiometricMark();
    photoConsentWrap.hidden = !isBiometricMark();
    retryBiometricButton.hidden = true;
    submitButton.disabled = true;
    title.textContent = `Confirmar ${labelFor(state.markType)}`;
    submitButton.textContent = `Registrar ${labelFor(state.markType)}`;
    dialog.dataset.flowState = isBiometricMark() ? 'waiting-consent' : 'waiting-location';

    if (isBiometricMark()) {
      setStatus('Autoriza el uso de la cámara para iniciar automáticamente.', 'neutral');
    } else {
      setStatus('Preparando ubicación…', 'neutral');
    }
  }

  function openMarkDialog(button) {
    if (button.disabled || !biometricReady) return;
    state.assignmentId = button.dataset.assignmentId;
    state.markType = button.dataset.markType;
    resetMarkDialog();
    showModal(dialog);
    const localRunToken = runToken;
    requestLocation(localRunToken);

    if (isBiometricMark()) {
      biometricApi?.prepare?.().catch(() => {});
      window.setTimeout(() => photoConsent?.focus({ preventScroll: true }), 0);
    } else {
      updateSubmitState();
    }
  }

  async function submitMark() {
    if (!state.assignmentId || !state.locationEvidence || !navigator.onLine) return;
    if (isBiometricMark() && (!state.biometricVerified || !state.photoBlob || !photoConsent?.checked)) {
      setStatus('La identidad todavía no está verificada.', 'warning');
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Registrando…';
    const form = new FormData();
    form.set('idempotencyKey', state.idempotencyKey || newIdempotencyKey());
    form.set('latitude', String(state.locationEvidence.latitude));
    form.set('longitude', String(state.locationEvidence.longitude));
    form.set('accuracyMeters', String(state.locationEvidence.accuracyMeters));
    form.set('clientCapturedAt', state.locationEvidence.clientCapturedAt);
    form.set('captureMode', 'ONLINE_WEB');
    form.set('photoConsent', isBiometricMark() ? 'true' : 'false');
    if (isBiometricMark()) {
      form.set('selfie', state.photoBlob, `selfie-${labelFor(state.markType).replaceAll(' ', '-')}.jpg`);
    }

    try {
      const response = await fetch(
        `/operaciones/portal/asignaciones/${encodeURIComponent(state.assignmentId)}/${endpointFor(state.markType)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'worker-portal' },
          body: form
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        const messages = {
          outside_operation_range: 'Debes estar dentro del rango de la operación.',
          operation_geofence_required: 'La operación no tiene geocerca configurada.',
          location_accuracy_insufficient: 'La precisión del GPS no es suficiente.',
          biometric_verification_required: 'La validación facial venció. Intenta nuevamente.',
          online_biometric_required: 'Necesitas conexión para marcar.',
          portal_session_required: 'Tu sesión venció.',
          departure_arrival_required: 'Primero registra la llegada.',
          departure_break_end_required: 'Finaliza el almuerzo antes de registrar la salida.'
        };
        throw new Error(messages[payload.error] || 'No fue posible registrar la marcación.');
      }

      setStatus(payload.message || 'Marcación registrada.', 'ok');
      stopCamera();
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      setStatus(error?.message || 'No fue posible registrar.', 'danger');
      submitButton.disabled = false;
      submitButton.textContent = `Registrar ${labelFor(state.markType)}`;
    }
  }

  function closeMarkDialog() {
    runToken += 1;
    verificationInProgress = false;
    stopCamera();
    clearPhoto();
    closeModal(dialog);
  }

  function renderConnectivity() {
    const online = navigator.onLine;
    connectivityBar?.classList.toggle('offline', !online);
    if (connectivityTitle) connectivityTitle.textContent = online ? 'Con conexión' : 'Sin conexión';
    if (!online) setButtonsReady(false);
    else if (biometricReady) setButtonsReady(true);
  }

  document.documentElement.dataset.lorrenBiometricFlow = FLOW_VERSION;

  startEnrollmentButton?.addEventListener('click', enrollFace);
  enrollmentDialog?.addEventListener('cancel', (event) => event.preventDefault());

  markButtons.forEach((button) => {
    button.addEventListener('pointerdown', () => biometricApi?.prepare?.().catch(() => {}), { passive: true });
    button.addEventListener('click', () => openMarkDialog(button));
  });

  photoConsent?.addEventListener('change', () => {
    if (!photoConsent.checked) {
      if (!verificationInProgress) {
        state.biometricVerified = false;
        clearPhoto();
        stopCamera();
        setStatus('Autoriza el uso de la cámara para iniciar automáticamente.', 'neutral');
        updateSubmitState();
      }
      return;
    }
    runAutomaticVerification();
  });

  retryBiometricButton?.addEventListener('click', runAutomaticVerification);
  submitButton.addEventListener('click', submitMark);
  closeMarkButton?.addEventListener('click', closeMarkDialog);
  cancelMarkButton?.addEventListener('click', closeMarkDialog);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeMarkDialog();
  });

  window.addEventListener('online', () => {
    renderConnectivity();
    loadBiometricStatus();
  });
  window.addEventListener('offline', renderConnectivity);

  renderConnectivity();
  loadBiometricStatus();
})();
