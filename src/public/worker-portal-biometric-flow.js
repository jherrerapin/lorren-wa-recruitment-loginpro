'use strict';

(() => {
  if (window.location.pathname !== '/operaciones/portal') return;

  const biometricApi = window.LorrenWorkerBiometric || null;
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
  const FLOW_RELEASE = '20260804-biometric-marking-reliability-v3';
  const AUTOMATIC_RETRY_ERRORS = new Set([
    'camera_stream_unavailable',
    'camera_stream_muted',
    'biometric_runtime_unavailable',
    'biometric_capture_timeout',
    'biometric_baseline_timeout',
    'biometric_challenge_timeout',
    'biometric_final_timeout'
  ]);
  const BACKEND_RECOVERY_ERRORS = new Set([
    'biometric_runtime_unavailable',
    'biometric_baseline_timeout',
    'biometric_final_timeout'
  ]);

  let biometricReady = false;
  let enrollmentStream = null;
  let cameraStream = null;
  let photoUrl = null;
  let runToken = 0;
  let verificationInProgress = false;
  let resumeVerificationPending = false;
  let resumeTimer = null;
  let rateLimitTimer = null;
  let rateLimitUntil = 0;
  let rateLimitContext = '';

  const state = {
    assignmentId: null,
    markType: null,
    locationEvidence: null,
    photoBlob: null,
    idempotencyKey: null,
    biometricChallenge: null,
    biometricVerified: false,
    biometricValidUntil: null
  };

  const isBiometricMark = () => ['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'].includes(state.markType);
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

  function currentMarkButtons() {
    return [...document.querySelectorAll('.mark-button[data-mark-type]')];
  }

  function markButtonFromEvent(event) {
    return event.target instanceof Element
      ? event.target.closest('.mark-button[data-mark-type]')
      : null;
  }

  function newIdempotencyKey() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${String(state.markType || 'mark').toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
  }

  function showModal(target) {
    if (typeof target?.showModal === 'function') target.showModal();
    else target?.setAttribute('open', '');
  }

  function closeModal(target) {
    if (!target) return;
    if (target.hasAttribute?.('open') && typeof target.close === 'function') target.close();
    else target.removeAttribute?.('open');
  }

  function stopStream(stream) {
    stream?.getTracks?.().forEach((track) => track.stop());
  }

  function closeEnrollmentDialog() {
    stopStream(enrollmentStream);
    enrollmentStream = null;
    if (enrollmentVideo) {
      enrollmentVideo.srcObject = null;
      enrollmentVideo.hidden = true;
    }
    closeModal(enrollmentDialog);
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

  function clearVerification() {
    state.biometricVerified = false;
    state.biometricValidUntil = null;
    state.biometricChallenge = null;
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

  function errorCode(error) {
    return String(error?.message || 'biometric_unknown_error');
  }

  function publicErrorMessage(error) {
    const code = errorCode(error);
    const messages = {
      camera_unavailable: 'No fue posible abrir la cámara frontal.',
      camera_stream_unavailable: 'La cámara no entregó imagen. Cierra otras aplicaciones que puedan estar usándola.',
      camera_stream_muted: 'La cámara quedó pausada por el teléfono. Vuelve a intentarlo con la pantalla activa.',
      biometric_page_not_visible: 'Mantén esta pantalla visible durante la validación.',
      biometric_runtime_unavailable: 'El reconocimiento facial se reinició, pero no pudo quedar listo.',
      biometric_enrollment_timeout: 'No se obtuvieron tres capturas válidas para registrar el rostro.',
      biometric_capture_timeout: 'No se obtuvo una captura estable dentro del tiempo disponible.',
      biometric_baseline_timeout: 'No se lograron obtener dos muestras frontales válidas.',
      biometric_challenge_timeout: 'No se confirmó el movimiento durante varios fotogramas.',
      biometric_final_timeout: 'No se lograron obtener las muestras finales al volver al centro.',
      biometric_challenge_not_completed: 'No se confirmó el movimiento solicitado.',
      biometric_descriptor_unavailable: 'No se pudieron leer correctamente los rasgos del rostro.',
      biometric_descriptor_inconsistent: 'Las capturas del rostro no fueron consistentes.',
      biometric_verification_rejected: 'No fue posible confirmar que sea el rostro registrado.',
      attendance_biometric_antispoof_low: 'No se confirmó que la captura corresponda a un rostro real.',
      attendance_biometric_liveness_low: 'No se confirmó vida facial en todas las muestras.',
      attendance_biometric_samples_inconsistent: 'Las muestras cambiaron demasiado durante la validación.',
      attendance_biometric_rate_limited: 'Se alcanzó el límite temporal de intentos. Espera antes de volver a intentar.',
      biometric_enrollment_required: 'Debes registrar nuevamente tu rostro antes de marcar.',
      portal_session_required: 'Tu sesión del portal venció.',
      assignment_not_available: 'La asignación ya no está disponible para marcar.',
      biometric_request_invalid: 'No fue posible preparar la validación facial.',
      biometric_challenge_failed: 'No fue posible iniciar la validación facial.'
    };
    return messages[code] || 'No fue posible confirmar tu identidad.';
  }

  function currentRateLimitContext() {
    return state.assignmentId && state.markType ? `${state.assignmentId}:${state.markType}` : '';
  }

  function clearRateLimitTimer() {
    if (rateLimitTimer) window.clearInterval(rateLimitTimer);
    rateLimitTimer = null;
  }

  function activeRateLimitSeconds() {
    if (!rateLimitUntil || rateLimitContext !== currentRateLimitContext()) return 0;
    return Math.max(0, Math.ceil((rateLimitUntil - Date.now()) / 1000));
  }

  function renderRateLimitCountdown() {
    const seconds = activeRateLimitSeconds();
    if (seconds <= 0) {
      clearRateLimitTimer();
      rateLimitUntil = 0;
      rateLimitContext = '';
      if (retryBiometricButton) {
        retryBiometricButton.hidden = false;
        retryBiometricButton.disabled = false;
        retryBiometricButton.textContent = 'Intentar nuevamente';
      }
      if (dialog.open) {
        setInstruction('Mira de frente.');
        setStatus('Ya puedes intentar nuevamente.', 'warning');
      }
      return false;
    }

    if (retryBiometricButton) {
      retryBiometricButton.hidden = false;
      retryBiometricButton.disabled = true;
      retryBiometricButton.textContent = `Reintentar en ${seconds} s`;
    }
    if (dialog.open) {
      if (biometricInstruction) {
        biometricInstruction.textContent = 'La cámara se reanudará cuando termine la espera.';
      }
      setStatus(`Se alcanzó el límite temporal. Podrás volver a intentar en ${seconds} segundos.`, 'danger');
    }
    return true;
  }

  function startRateLimitCountdown() {
    clearRateLimitTimer();
    if (!renderRateLimitCountdown()) return false;
    rateLimitTimer = window.setInterval(renderRateLimitCountdown, 1000);
    return true;
  }

  function beginRateLimitCooldown(secondsValue) {
    const seconds = Math.max(1, Math.ceil(Number(secondsValue) || 30));
    const context = currentRateLimitContext();
    const previousUntil = rateLimitContext === context ? rateLimitUntil : 0;
    rateLimitContext = context;
    rateLimitUntil = Math.max(previousUntil, Date.now() + seconds * 1000);
    stopCamera();
    clearPhoto();
    clearVerification();
    startRateLimitCountdown();
  }

  function verificationStillValid() {
    if (!state.biometricVerified || !state.biometricValidUntil) return false;
    return new Date(state.biometricValidUntil).getTime() > Date.now() + 2_000;
  }

  function updateSubmitState() {
    submitButton.disabled = !navigator.onLine
      || !state.locationEvidence
      || (isBiometricMark() && (!verificationStillValid() || !state.photoBlob || !photoConsent?.checked));
  }

  function setButtonsReady(ready) {
    biometricReady = ready;
    currentMarkButtons().forEach((button) => {
      const permanentlyDisabled = button.hasAttribute('data-server-disabled')
        || button.hasAttribute('data-offline-disabled');
      if (!permanentlyDisabled) button.disabled = !ready;
    });
  }

  currentMarkButtons().forEach((button) => {
    if (button.disabled) button.setAttribute('data-server-disabled', 'true');
    button.disabled = true;
  });

  async function portalBiometricRequest(path, body = {}) {
    const response = await fetch(`/operaciones/portal/biometria/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
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
      error.retryAfterSeconds = Number(response.headers.get('Retry-After') || 0);
      throw error;
    }
    return payload;
  }

  async function loadBiometricStatus() {
    if (!navigator.onLine) {
      closeEnrollmentDialog();
      return;
    }

    try {
      const status = await portalBiometricRequest('estado');
      if (!navigator.onLine) {
        closeEnrollmentDialog();
        return;
      }
      if (status.enrolled) {
        closeEnrollmentDialog();
        setButtonsReady(true);
        return;
      }

      setButtonsReady(false);
      if (startEnrollmentButton) startEnrollmentButton.disabled = false;
      if (enrollmentConsent) enrollmentConsent.disabled = false;
      if (enrollmentStatus) {
        enrollmentStatus.textContent = 'Autoriza el uso del rostro para comenzar.';
        enrollmentStatus.className = 'status';
      }
      showModal(enrollmentDialog);
      enrollmentConsent?.focus({ preventScroll: true });
    } catch {
      setButtonsReady(false);
      closeEnrollmentDialog();
      if (navigator.onLine && connectivityTitle) {
        connectivityTitle.textContent = 'Con conexión · validación facial pendiente';
      }
    }
  }

  async function enrollFace() {
    if (!navigator.onLine) {
      closeEnrollmentDialog();
      return;
    }
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
        evidenceVersion: capture.evidenceVersion,
        descriptor: capture.descriptor,
        sampleDescriptors: capture.sampleDescriptors,
        sampleRealScores: capture.sampleRealScores,
        sampleLiveScores: capture.sampleLiveScores,
        captureDurationMs: capture.captureDurationMs,
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
      if (!navigator.onLine) {
        closeEnrollmentDialog();
        return;
      }
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
      evidenceVersion: capture.evidenceVersion,
      challengeToken: state.biometricChallenge?.token,
      challengeAction: capture.challengeAction,
      challengeCompleted: capture.challengeCompleted,
      challengeEvidence: capture.challengeEvidence,
      descriptor: capture.descriptor,
      sampleDescriptors: capture.sampleDescriptors,
      sampleRealScores: capture.sampleRealScores,
      sampleLiveScores: capture.sampleLiveScores,
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

  function waitUntilVisible() {
    if (document.visibilityState !== 'hidden') return Promise.resolve();
    return new Promise((resolve) => {
      const visible = () => {
        if (document.visibilityState === 'hidden') return;
        document.removeEventListener('visibilitychange', visible, true);
        resolve();
      };
      document.addEventListener('visibilitychange', visible, true);
    });
  }

  async function recoverAfterFailure(error, localRunToken) {
    const code = errorCode(error);
    await waitUntilVisible();
    if (localRunToken !== runToken || !dialog.open) return;

    if (BACKEND_RECOVERY_ERRORS.has(code) && biometricApi?.recover) {
      setStatus('Reiniciando el motor facial y la cámara…', 'warning');
      await biometricApi.recover({ reason: code, rotateBackend: true });
      return;
    }

    const retryAfterSeconds = Number(error?.retryAfterSeconds || 0);
    if (code === 'attendance_biometric_rate_limited' && retryAfterSeconds > 0) {
      setStatus(`Espera ${retryAfterSeconds} segundos antes de un nuevo intento.`, 'warning');
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(5_000, retryAfterSeconds * 1000)));
      return;
    }

    setStatus('Preparando un nuevo intento con la cámara…', 'warning');
    await new Promise((resolve) => window.setTimeout(resolve, 450));
  }

  async function runSingleVerificationAttempt(localRunToken, attemptNumber) {
    if (localRunToken !== runToken || !dialog.open) throw new Error('biometric_flow_cancelled');
    stopCamera();
    clearPhoto();
    clearVerification();
    updateSubmitState();

    setStatus(
      attemptNumber === 1 ? 'Preparando reconocimiento facial…' : 'Reintentando recuperación técnica…',
      'neutral'
    );
    setInstruction('Mira de frente. La validación comenzará automáticamente.');
    if (retryBiometricButton) {
      retryBiometricButton.disabled = false;
      retryBiometricButton.textContent = 'Intentar nuevamente';
    }

    if (!biometricApi || !navigator.onLine) throw new Error('camera_unavailable');
    const challenge = await requestBiometricChallenge();
    await biometricApi.prepare?.();
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
    setStatus('Comparando las muestras con el rostro registrado…', 'neutral');
    const verification = await verifyBiometric(capture);
    if (verification.verified !== true || !verification.validUntil) {
      throw new Error('biometric_verification_rejected');
    }

    state.biometricVerified = true;
    state.biometricValidUntil = verification.validUntil;
    setVerifiedPhoto(capture.photoBlob);
    setInstruction('Identidad verificada.');
    setStatus('Identidad verificada. Registra la marcación ahora.', 'ok');
    submitButton.focus({ preventScroll: true });
  }

  async function runAutomaticVerification() {
    if (verificationInProgress || !dialog.open || !isBiometricMark()) return;
    if (activeRateLimitSeconds() > 0) {
      startRateLimitCountdown();
      return;
    }
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
          const code = errorCode(error);
          if (code === 'biometric_flow_cancelled') return;
          if (code === 'attendance_biometric_rate_limited') {
            beginRateLimitCooldown(error?.retryAfterSeconds);
            return;
          }
          if (!AUTOMATIC_RETRY_ERRORS.has(code)) break;
          if (attempt < MAX_AUTOMATIC_ATTEMPTS) {
            await recoverAfterFailure(error, localRunToken);
            if (localRunToken !== runToken || !dialog.open) return;
          }
        }
      }

      clearVerification();
      clearPhoto();
      const code = errorCode(lastError);
      const message = code === 'biometric_verification_rejected'
        ? 'No se confirmó la identidad en este intento. Mira de frente, usa buena iluminación y vuelve a intentarlo.'
        : `${publicErrorMessage(lastError)} Puedes intentar nuevamente.`;
      setStatus(message, 'danger');
      if (retryBiometricButton) {
        retryBiometricButton.hidden = false;
        retryBiometricButton.disabled = false;
        retryBiometricButton.textContent = 'Intentar nuevamente';
        retryBiometricButton.focus({ preventScroll: true });
      }
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
    resumeVerificationPending = false;
    if (resumeTimer) window.clearTimeout(resumeTimer);
    resumeTimer = null;
    stopCamera();
    clearPhoto();

    state.locationEvidence = null;
    state.idempotencyKey = null;
    clearVerification();

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
    retryBiometricButton.disabled = false;
    retryBiometricButton.textContent = 'Intentar nuevamente';
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
    if (!navigator.onLine || button.disabled || !biometricReady) return;
    state.assignmentId = button.dataset.assignmentId;
    state.markType = button.dataset.markType;
    resetMarkDialog();
    showModal(dialog);
    const localRunToken = runToken;
    requestLocation(localRunToken);

    const rateLimited = activeRateLimitSeconds() > 0;
    if (rateLimited) startRateLimitCountdown();
    if (isBiometricMark() && !rateLimited) {
      biometricApi?.prepare?.().catch(() => {});
      window.setTimeout(() => photoConsent?.focus({ preventScroll: true }), 0);
    } else if (!isBiometricMark()) {
      updateSubmitState();
    }
  }

  async function submitMark() {
    if (!state.assignmentId || !state.locationEvidence || !navigator.onLine) return;
    if (isBiometricMark() && (!verificationStillValid() || !state.photoBlob || !photoConsent?.checked)) {
      clearVerification();
      setStatus('La validación facial venció. Realízala nuevamente.', 'warning');
      retryBiometricButton.hidden = false;
      updateSubmitState();
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
          biometric_verification_required: 'La validación facial venció o ya fue utilizada. Intenta nuevamente.',
          online_biometric_required: 'Necesitas conexión para marcar.',
          portal_session_required: 'Tu sesión venció.',
          departure_arrival_required: 'Primero registra la llegada.',
          departure_break_end_required: 'Finaliza el almuerzo antes de registrar la salida.'
        };
        const error = new Error(messages[payload.error] || 'No fue posible registrar la marcación.');
        error.code = payload.error;
        throw error;
      }

      setStatus(payload.message || 'Marcación registrada.', 'ok');
      clearVerification();
      stopCamera();
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      if (error?.code === 'biometric_verification_required') {
        clearVerification();
        clearPhoto();
        retryBiometricButton.hidden = false;
      }
      setStatus(error?.message || 'No fue posible registrar.', 'danger');
      submitButton.disabled = false;
      submitButton.textContent = `Registrar ${labelFor(state.markType)}`;
      updateSubmitState();
    }
  }

  function closeMarkDialog() {
    runToken += 1;
    resumeVerificationPending = false;
    if (resumeTimer) window.clearTimeout(resumeTimer);
    resumeTimer = null;
    clearRateLimitTimer();
    stopCamera();
    clearPhoto();
    clearVerification();
    closeModal(dialog);
  }

  function pauseOpenVerification(_reason) {
    if (!dialog.open || !isBiometricMark()) return;
    resumeVerificationPending = Boolean(photoConsent?.checked);
    runToken += 1;
    stopCamera();
    clearPhoto();
    state.locationEvidence = null;
    state.idempotencyKey = null;
    clearVerification();
    if (locationStatus) locationStatus.textContent = 'La ubicación se actualizará al volver.';
    updateSubmitState();
    if (resumeVerificationPending) {
      setStatus('La validación se pausó mientras el teléfono estaba inactivo. Se reanudará automáticamente.', 'warning');
    }
  }

  function scheduleResumeVerification() {
    if (!resumeVerificationPending || !dialog.open || !photoConsent?.checked) return;
    if (resumeTimer) window.clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(() => {
      resumeTimer = null;
      if (!resumeVerificationPending || !dialog.open || document.visibilityState === 'hidden') return;
      if (verificationInProgress) {
        scheduleResumeVerification();
        return;
      }
      resumeVerificationPending = false;
      setStatus('Reiniciando reconocimiento facial…', 'neutral');
      runAutomaticVerification();
    }, 180);
  }

  function resumeOpenVerification(_reason) {
    if (navigator.onLine) biometricApi?.prepare?.().catch(() => {});
    if (navigator.onLine && dialog.open) requestLocation(runToken);
    if (navigator.onLine) scheduleResumeVerification();
  }

  function renderConnectivity() {
    const online = navigator.onLine;
    connectivityBar?.classList.toggle('offline', !online);
    if (connectivityTitle) connectivityTitle.textContent = online ? 'Con conexión' : 'Sin conexión';
    if (online && biometricReady) setButtonsReady(true);
  }

  function enterOfflineMode() {
    closeEnrollmentDialog();
    if (dialog.open && dialog.dataset.flowState !== 'offline') closeMarkDialog();
    renderConnectivity();
  }

  document.documentElement.dataset.lorrenBiometricFlow = FLOW_RELEASE;

  startEnrollmentButton?.addEventListener('click', enrollFace);
  enrollmentDialog?.addEventListener('cancel', (event) => event.preventDefault());

  document.addEventListener('pointerdown', (event) => {
    if (!navigator.onLine) return;
    const button = markButtonFromEvent(event);
    if (!button || button.disabled) return;
    biometricApi?.prepare?.().catch(() => {});
  }, { passive: true });
  document.addEventListener('click', (event) => {
    if (!navigator.onLine) return;
    const button = markButtonFromEvent(event);
    if (button) openMarkDialog(button);
  });

  photoConsent?.addEventListener('change', () => {
    if (!photoConsent.checked) {
      resumeVerificationPending = false;
      if (!verificationInProgress) {
        clearVerification();
        clearPhoto();
        stopCamera();
        setStatus('Autoriza el uso de la cámara para iniciar automáticamente.', 'neutral');
        updateSubmitState();
      }
      return;
    }
    if (activeRateLimitSeconds() > 0) {
      startRateLimitCountdown();
      return;
    }
    runAutomaticVerification();
  });

  retryBiometricButton?.addEventListener('click', () => {
    if (activeRateLimitSeconds() > 0) {
      startRateLimitCountdown();
      return;
    }
    runAutomaticVerification();
  });
  submitButton.addEventListener('click', submitMark);
  closeMarkButton?.addEventListener('click', closeMarkDialog);
  cancelMarkButton?.addEventListener('click', closeMarkDialog);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeMarkDialog();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pauseOpenVerification('document-hidden');
    else resumeOpenVerification('document-visible');
  }, { capture: true });
  document.addEventListener('freeze', () => pauseOpenVerification('document-frozen'), { capture: true });
  document.addEventListener('resume', () => resumeOpenVerification('document-resumed'), { capture: true });
  window.addEventListener('pagehide', () => pauseOpenVerification('page-hidden'), { capture: true });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted || document.wasDiscarded) resumeOpenVerification('page-restored');
  }, { capture: true });

  window.addEventListener('online', () => {
    renderConnectivity();
    loadBiometricStatus();
  });
  window.addEventListener('offline', enterOfflineMode);

  renderConnectivity();
  if (navigator.onLine) loadBiometricStatus();
  else closeEnrollmentDialog();
})();