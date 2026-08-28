'use strict';

(() => {
  if (window.location.pathname !== '/operaciones/portal') return;

  const biometricApi = window.LorrenWorkerBiometric || null;
  const nativePresenceBridge = window.LorrenAndroidPresence || null;
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

  const MAX_AUTOMATIC_ATTEMPTS = 1;
  const FLOW_RELEASE = '20260828-attendance-failure-audit-v1';
  const ATTENDANCE_FAILURE_QUEUE_KEY = 'lorren-attendance-failure-v1';
  const ATTENDANCE_FAILURE_QUEUE_LIMIT = 40;
  const CLIENT_FAILURE_CODES = Object.freeze({
    location_permission_denied: 'client_location_permission_denied',
    location_position_unavailable: 'client_location_position_unavailable',
    location_timeout: 'client_location_timeout',
    location_unsupported: 'client_location_unsupported',
    native_location_unavailable: 'client_native_location_unavailable',
    native_location_proof_failed: 'client_native_location_proof_failed',
    native_location_credential_required: 'client_native_location_credential_required',
    permissions_required: 'client_native_permissions_required',
    mock_location_detected: 'client_mock_location_detected',
    native_bridge_unavailable: 'client_native_bridge_unavailable',
    native_bridge_invalid_response: 'client_native_bridge_invalid_response',
    native_bridge_failed: 'client_native_bridge_failed',
    camera_unavailable: 'client_camera_unavailable',
    camera_stream_unavailable: 'client_camera_stream_unavailable',
    camera_stream_muted: 'client_camera_stream_muted',
    biometric_page_not_visible: 'client_biometric_page_not_visible',
    biometric_runtime_preparing: 'client_biometric_runtime_preparing',
    biometric_runtime_unavailable: 'client_biometric_runtime_unavailable',
    biometric_detection_timeout: 'client_biometric_detection_timeout',
    biometric_capture_timeout: 'client_biometric_capture_timeout',
    biometric_baseline_timeout: 'client_biometric_baseline_timeout',
    biometric_challenge_timeout: 'client_biometric_challenge_timeout',
    biometric_final_timeout: 'client_biometric_final_timeout',
    biometric_challenge_not_completed: 'client_biometric_challenge_not_completed',
    biometric_descriptor_unavailable: 'client_biometric_descriptor_unavailable',
    biometric_descriptor_inconsistent: 'client_biometric_descriptor_inconsistent',
    network_request_failed: 'client_network_request_failed'
  });
  const AUTOMATIC_RETRY_ERRORS = new Set([
    'camera_stream_unavailable',
    'camera_stream_muted',
    'biometric_runtime_unavailable',
    'biometric_detection_timeout',
    'biometric_capture_timeout',
    'biometric_baseline_timeout',
    'biometric_challenge_timeout',
    'biometric_final_timeout'
  ]);
  const BACKEND_RECOVERY_ERRORS = new Set([
    'biometric_runtime_unavailable',
    'biometric_detection_timeout',
    'biometric_baseline_timeout',
    'biometric_final_timeout'
  ]);
  const LOCATION_PREFLIGHT_ERRORS = new Set([
    'attendance_location_pending',
    'mark_request_invalid',
    'operation_geofence_required',
    'location_accuracy_insufficient',
    'outside_operation_range',
    'attendance_native_location_required',
    'attendance_native_location_invalid',
    'attendance_native_location_identity_invalid',
    'attendance_native_location_time_mismatch',
    'attendance_mock_location_detected',
    'mock_location_detected',
    'native_location_unavailable',
    'native_location_proof_failed',
    'native_location_credential_required'
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
  let failureFlushPromise = null;

  function parseNativeBridgeResult(value) {
    if (typeof value !== 'string') return null;
    try { return JSON.parse(value); } catch (_error) { return null; }
  }

  function nativeBridgeCall(method, ...args) {
    const fn = nativePresenceBridge?.[method];
    if (typeof fn !== 'function') return { ok: false, error: 'native_bridge_unavailable' };
    try {
      return parseNativeBridgeResult(fn.apply(nativePresenceBridge, args))
        || { ok: false, error: 'native_bridge_invalid_response' };
    } catch (_error) {
      return { ok: false, error: 'native_bridge_failed' };
    }
  }

  const nativeCapabilities = nativePresenceBridge ? nativeBridgeCall('getCapabilities') : null;
  const nativeAttendanceLocationEnabled = Boolean(
    nativeCapabilities?.androidNative === true
    && nativeCapabilities?.nativeAttendanceLocation === true
    && nativeCapabilities?.mockLocationSignal === true
    && nativeCapabilities?.attendanceWriter === false
  );

  const state = {
    assignmentId: null,
    markType: null,
    locationEvidence: null,
    nativeLocationProof: null,
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

  function failureRecordKey(record) {
    return [record?.assignmentId, record?.markType, record?.clientAttemptId, record?.errorCode].join(':');
  }

  function loadAttendanceFailureQueue() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(ATTENDANCE_FAILURE_QUEUE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter((record) => (
        record
        && typeof record.assignmentId === 'string'
        && typeof record.markType === 'string'
        && typeof record.clientAttemptId === 'string'
        && typeof record.errorCode === 'string'
        && typeof record.occurredAt === 'string'
      )).slice(-ATTENDANCE_FAILURE_QUEUE_LIMIT) : [];
    } catch (_error) {
      return [];
    }
  }

  function saveAttendanceFailureQueue(records) {
    try {
      const next = Array.isArray(records) ? records.slice(-ATTENDANCE_FAILURE_QUEUE_LIMIT) : [];
      if (next.length) window.localStorage.setItem(ATTENDANCE_FAILURE_QUEUE_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(ATTENDANCE_FAILURE_QUEUE_KEY);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function queueAttendanceFailure(record) {
    const queue = loadAttendanceFailureQueue();
    const key = failureRecordKey(record);
    if (!queue.some((item) => failureRecordKey(item) === key)) queue.push(record);
    return saveAttendanceFailureQueue(queue);
  }

  function removeAttendanceFailure(record) {
    const key = failureRecordKey(record);
    const queue = loadAttendanceFailureQueue().filter((item) => failureRecordKey(item) !== key);
    saveAttendanceFailureQueue(queue);
  }

  async function sendAttendanceFailure(record) {
    const response = await fetch(
      `/operaciones/portal/asignaciones/${encodeURIComponent(record.assignmentId)}/intentos-fallidos`,
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'worker-portal'
        },
        body: JSON.stringify({
          markType: record.markType,
          clientAttemptId: record.clientAttemptId,
          errorCode: record.errorCode,
          occurredAt: record.occurredAt
        })
      }
    );
    if (response.ok) return 'sent';
    if ([400, 404].includes(response.status)) return 'discard';
    return 'retry';
  }

  async function flushAttendanceFailureQueue() {
    if (!navigator.onLine) return false;
    if (failureFlushPromise) return failureFlushPromise;
    failureFlushPromise = (async () => {
      while (navigator.onLine) {
        const record = loadAttendanceFailureQueue()[0];
        if (!record) return true;
        let outcome = 'retry';
        try {
          outcome = await sendAttendanceFailure(record);
        } catch (_error) {
          outcome = 'retry';
        }
        if (outcome === 'retry') return false;
        removeAttendanceFailure(record);
      }
      return false;
    })().finally(() => {
      failureFlushPromise = null;
    });
    return failureFlushPromise;
  }

  function reportAttendanceFailure(error, occurredAt = new Date()) {
    const internalCode = String(error?.message || '');
    const reportCode = CLIENT_FAILURE_CODES[internalCode];
    if (!reportCode || !state.assignmentId || !state.markType || !state.idempotencyKey) return false;
    const occurred = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
    if (Number.isNaN(occurred.getTime())) return false;
    const record = {
      assignmentId: String(state.assignmentId),
      markType: String(state.markType).toUpperCase(),
      clientAttemptId: String(state.idempotencyKey),
      errorCode: reportCode,
      occurredAt: occurred.toISOString()
    };
    const queued = queueAttendanceFailure(record);
    if (navigator.onLine) {
      if (queued) flushAttendanceFailureQueue();
      else sendAttendanceFailure(record).catch(() => {});
    }
    return true;
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

  function clearLocation({ rotateAttempt = false } = {}) {
    state.locationEvidence = null;
    state.nativeLocationProof = null;
    if (rotateAttempt) state.idempotencyKey = newIdempotencyKey();
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
      biometric_runtime_preparing: 'El reconocimiento facial todavía se está preparando en este teléfono. Espera unos segundos.',
      biometric_runtime_unavailable: 'El reconocimiento facial no pudo quedar listo.',
      biometric_detection_timeout: 'El análisis facial se demoró demasiado y fue reiniciado.',
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
      attendance_location_pending: 'Espera a que la ubicación esté lista antes de iniciar la cámara.',
      mark_request_invalid: 'No fue posible validar la ubicación. Actualízala e intenta nuevamente.',
      operation_geofence_required: 'La operación no tiene una geocerca válida configurada.',
      location_accuracy_insufficient: 'La precisión del GPS no es suficiente. Intenta nuevamente al aire libre.',
      outside_operation_range: 'Debes estar dentro del rango de la operación para marcar asistencia.',
      attendance_native_location_required: 'La app necesita obtener una ubicación segura antes de marcar.',
      attendance_native_location_invalid: 'La ubicación segura no corresponde a esta marcación. Actualízala.',
      attendance_native_location_identity_invalid: 'No fue posible validar este teléfono para la ubicación. Vuelve a abrir la app e intenta nuevamente.',
      attendance_native_location_time_mismatch: 'La ubicación segura venció. Actualízala e intenta nuevamente.',
      attendance_mock_location_detected: 'Android detectó una ubicación simulada. Desactiva la ubicación de prueba antes de marcar.',
      mock_location_detected: 'Android detectó una ubicación simulada. Desactiva la ubicación de prueba antes de marcar.',
      native_location_unavailable: 'No fue posible obtener una ubicación válida de Android.',
      native_location_proof_failed: 'No fue posible proteger la ubicación de este intento.',
      native_location_credential_required: 'El teléfono aún se está preparando. Conéctate y vuelve a intentar en unos segundos.',
      permissions_required: 'Autoriza los permisos de ubicación solicitados por Android.',
      native_bridge_unavailable: 'La app no pudo acceder a la ubicación segura de Android.',
      native_bridge_invalid_response: 'La app recibió una respuesta inválida al solicitar la ubicación segura.',
      native_bridge_failed: 'La app no pudo completar la solicitud de ubicación segura.',
      network_request_failed: 'Se perdió la comunicación con el servidor durante este intento.',
      biometric_enrollment_required: 'Debes registrar nuevamente tu rostro antes de marcar.',
      portal_session_required: 'Tu sesión del portal venció.',
      assignment_not_available: 'La asignación ya no está disponible para marcar.',
      biometric_request_invalid: 'No fue posible preparar la validación facial.',
      biometric_challenge_failed: 'No fue posible iniciar la validación facial.'
    };
    return messages[code] || 'No fue posible confirmar tu identidad.';
  }

  function biometricRejectionMessage(error) {
    const flags = Array.isArray(error?.payload?.riskFlags)
      ? error.payload.riskFlags.map((flag) => String(flag))
      : [];
    const messages = [
      ['BIOMETRIC_DESCRIPTOR_REPLAY', 'Se requiere una captura nueva en vivo. Vuelve a realizar la validación con la cámara.'],
      ['BIOMETRIC_ANTISPOOF_LOW', 'No se confirmó que la captura corresponda a un rostro real. Usa la cámara en vivo y buena iluminación.'],
      ['BIOMETRIC_LIVENESS_LOW', 'No se confirmó vida facial en todas las muestras. Mira de frente y sigue el movimiento indicado.'],
      ['BIOMETRIC_SAMPLES_INCONSISTENT', 'Las muestras cambiaron demasiado. Mantén el rostro centrado y estable durante la validación.'],
      ['BIOMETRIC_CHALLENGE_NOT_COMPLETED', 'No se confirmó el movimiento solicitado. Sigue la indicación y vuelve al centro.'],
      ['BIOMETRIC_CHALLENGE_EXPIRED', 'La validación facial venció antes de terminar. Inicia un nuevo intento.'],
      ['BIOMETRIC_CHALLENGE_INVALID', 'La validación facial perdió vigencia. Inicia un nuevo intento.'],
      ['BIOMETRIC_CHALLENGE_EVIDENCE_INVALID', 'No se pudo validar correctamente el movimiento facial. Sigue la indicación y vuelve a intentarlo.'],
      ['BIOMETRIC_FACE_MISMATCH', 'El rostro capturado no coincidió suficientemente con el registro. Mira de frente, usa iluminación uniforme y vuelve a intentarlo.'],
      ['BIOMETRIC_EVIDENCE_INVALID', 'La captura facial no pudo validarse correctamente. Mantén el rostro visible y vuelve a intentarlo.'],
      ['BIOMETRIC_DESCRIPTOR_INVALID', 'No se pudieron leer correctamente los rasgos del rostro. Mira de frente y vuelve a intentarlo.'],
      ['BIOMETRIC_NOT_ENROLLED', 'No existe un registro facial vigente. Debes registrar nuevamente tu rostro antes de marcar.'],
      ['BIOMETRIC_TEMPLATE_UNAVAILABLE', 'El registro facial no está disponible. Debes renovarlo antes de marcar.'],
      ['BIOMETRIC_ENROLLMENT_UPGRADE_REQUIRED', 'Debes renovar el registro facial antes de marcar.']
    ];
    for (const [flag, message] of messages) {
      if (flags.includes(flag)) return message;
    }
    return 'No se confirmó la identidad en este intento. Mira de frente, usa buena iluminación y vuelve a intentarlo.';
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
      || (nativeAttendanceLocationEnabled && !state.nativeLocationProof)
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
    let response;
    try {
      response = await fetch(`/operaciones/portal/biometria/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'worker-portal'
        },
        body: JSON.stringify(body)
      });
    } catch (_error) {
      throw new Error('network_request_failed');
    }
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
        biometricApi?.prepare?.().catch(() => {});
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

  function maybeStartVerificationAfterLocation() {
    updateSubmitState();
    if (
      isBiometricMark()
      && photoConsent?.checked
      && !verificationInProgress
      && activeRateLimitSeconds() <= 0
    ) {
      runAutomaticVerification();
    }
  }

  function requestNativeLocation(localRunToken) {
    if (!state.assignmentId || !state.markType) return;
    if (!state.idempotencyKey) state.idempotencyKey = newIdempotencyKey();
    clearLocation();
    locationStatus.textContent = 'Solicitando ubicación segura de Android…';
    const result = nativeBridgeCall('requestAttendanceLocation', JSON.stringify({
      assignmentId: state.assignmentId,
      markType: state.markType,
      idempotencyKey: state.idempotencyKey
    }));
    if (localRunToken !== runToken || !dialog.open) return;
    if (!result?.ok) {
      const error = new Error(result?.error || 'native_location_unavailable');
      reportAttendanceFailure(error);
      locationStatus.textContent = publicErrorMessage(error);
      setStatus(publicErrorMessage(error), 'warning');
      updateSubmitState();
    }
  }

  function requestLocation(localRunToken) {
    if (!state.idempotencyKey) state.idempotencyKey = newIdempotencyKey();
    if (nativeAttendanceLocationEnabled) {
      requestNativeLocation(localRunToken);
      return;
    }
    if (!navigator.geolocation) {
      const error = new Error('location_unsupported');
      reportAttendanceFailure(error);
      setStatus('Este navegador no permite obtener la ubicación.', 'danger');
      return;
    }

    clearLocation();
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
      maybeStartVerificationAfterLocation();
    }, (geolocationError) => {
      if (localRunToken !== runToken || !dialog.open) return;
      const internalCode = geolocationError?.code === 1
        ? 'location_permission_denied'
        : (geolocationError?.code === 3 ? 'location_timeout' : 'location_position_unavailable');
      reportAttendanceFailure(new Error(internalCode));
      locationStatus.textContent = geolocationError?.code === 1
        ? 'Permiso de ubicación rechazado.'
        : (geolocationError?.code === 3 ? 'El GPS agotó el tiempo de espera.' : 'No fue posible obtener la ubicación.');
      setStatus(geolocationError?.code === 1 ? 'Activa la ubicación para continuar.' : 'No fue posible obtener una ubicación válida.', 'warning');
    }, {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 0
    });
  }

  function handleNativeAttendanceLocation(event) {
    if (!nativeAttendanceLocationEnabled || !dialog.open) return;
    const detail = event?.detail;
    if (!detail || typeof detail !== 'object') return;
    const type = String(detail.type || '');
    if (!['attendance_location_ready', 'attendance_location_error'].includes(type)) return;
    if (
      String(detail.assignmentId || '') !== String(state.assignmentId || '')
      || String(detail.markType || '').toUpperCase() !== String(state.markType || '').toUpperCase()
      || String(detail.idempotencyKey || '') !== String(state.idempotencyKey || '')
    ) return;

    if (type === 'attendance_location_error') {
      clearLocation();
      const error = new Error(String(detail.code || 'native_location_unavailable'));
      reportAttendanceFailure(error);
      locationStatus.textContent = publicErrorMessage(error);
      setStatus(publicErrorMessage(error), errorCode(error).includes('mock') ? 'danger' : 'warning');
      updateSubmitState();
      return;
    }

    const proof = detail.proof;
    const latitude = Number(proof?.latitude);
    const longitude = Number(proof?.longitude);
    const accuracyMeters = Number(proof?.accuracyMeters);
    const capturedAt = Number(proof?.capturedAt);
    if (
      !proof || typeof proof !== 'object' || Array.isArray(proof)
      || proof.isMock === true
      || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || !Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > 100_000
      || !Number.isFinite(capturedAt) || capturedAt <= 0
    ) {
      clearLocation();
      const error = new Error(proof?.isMock === true ? 'mock_location_detected' : 'native_location_unavailable');
      reportAttendanceFailure(error);
      locationStatus.textContent = publicErrorMessage(error);
      setStatus(publicErrorMessage(error), 'danger');
      updateSubmitState();
      return;
    }

    state.nativeLocationProof = proof;
    state.locationEvidence = {
      latitude,
      longitude,
      accuracyMeters,
      clientCapturedAt: new Date(capturedAt).toISOString()
    };
    locationStatus.textContent = `Ubicación lista · precisión ${Math.round(accuracyMeters)} m`;
    maybeStartVerificationAfterLocation();
  }

  async function requestBiometricChallenge() {
    if (!state.locationEvidence || !state.idempotencyKey) throw new Error('attendance_location_pending');
    if (nativeAttendanceLocationEnabled && !state.nativeLocationProof) throw new Error('attendance_native_location_required');
    const payload = await portalBiometricRequest('desafio', {
      assignmentId: state.assignmentId,
      markType: state.markType,
      idempotencyKey: state.idempotencyKey,
      latitude: state.locationEvidence.latitude,
      longitude: state.locationEvidence.longitude,
      accuracyMeters: state.locationEvidence.accuracyMeters,
      clientCapturedAt: state.locationEvidence.clientCapturedAt,
      ...(nativeAttendanceLocationEnabled ? { nativeLocationProof: state.nativeLocationProof } : {})
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
    setInstruction('Abriendo cámara y preparando el análisis facial…');
    if (retryBiometricButton) {
      retryBiometricButton.disabled = false;
      retryBiometricButton.textContent = 'Intentar nuevamente';
    }

    if (!navigator.onLine) throw new Error('network_request_failed');
    if (!biometricApi) throw new Error('camera_unavailable');
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
    if (!state.locationEvidence || (nativeAttendanceLocationEnabled && !state.nativeLocationProof)) {
      setStatus('Esperando una ubicación válida antes de abrir la cámara…', 'neutral');
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

      reportAttendanceFailure(lastError);
      clearVerification();
      clearPhoto();
      const code = errorCode(lastError);
      const locationRejected = LOCATION_PREFLIGHT_ERRORS.has(code);
      const runtimePreparing = code === 'biometric_runtime_preparing';
      if (locationRejected) {
        clearLocation({ rotateAttempt: true });
        if (locationStatus) locationStatus.textContent = publicErrorMessage(lastError);
      }
      const message = code === 'biometric_verification_rejected'
        ? biometricRejectionMessage(lastError)
        : `${publicErrorMessage(lastError)}${locationRejected ? '' : ' Puedes intentar nuevamente.'}`;
      setStatus(message, runtimePreparing ? 'warning' : 'danger');
      if (retryBiometricButton) {
        retryBiometricButton.hidden = false;
        retryBiometricButton.disabled = false;
        retryBiometricButton.textContent = locationRejected ? 'Actualizar ubicación' : 'Intentar nuevamente';
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
    state.nativeLocationProof = null;
    state.idempotencyKey = newIdempotencyKey();
    clearVerification();

    if (photoConsent) {
      photoConsent.checked = false;
      photoConsent.disabled = false;
    }

    resultBox.hidden = false;
    locationStatus.textContent = nativeAttendanceLocationEnabled
      ? 'Solicitando ubicación segura de Android…'
      : 'Solicitando ubicación…';
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
    if (!state.assignmentId || !state.locationEvidence || !state.idempotencyKey || !navigator.onLine) return;
    if (nativeAttendanceLocationEnabled && !state.nativeLocationProof) {
      setStatus('Actualiza la ubicación segura antes de marcar.', 'warning');
      updateSubmitState();
      return;
    }
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
    form.set('idempotencyKey', state.idempotencyKey);
    form.set('latitude', String(state.locationEvidence.latitude));
    form.set('longitude', String(state.locationEvidence.longitude));
    form.set('accuracyMeters', String(state.locationEvidence.accuracyMeters));
    form.set('clientCapturedAt', state.locationEvidence.clientCapturedAt);
    form.set('captureMode', 'ONLINE_WEB');
    form.set('photoConsent', isBiometricMark() ? 'true' : 'false');
    if (nativeAttendanceLocationEnabled) {
      form.set('nativeLocationProof', JSON.stringify(state.nativeLocationProof));
    }
    if (isBiometricMark()) {
      form.set('selfie', state.photoBlob, `selfie-${labelFor(state.markType).replaceAll(' ', '-')}.jpg`);
    }

    try {
      let response;
      try {
        response = await fetch(
          `/operaciones/portal/asignaciones/${encodeURIComponent(state.assignmentId)}/${endpointFor(state.markType)}`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'worker-portal' },
            body: form
          }
        );
      } catch (_error) {
        throw new Error('network_request_failed');
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        const messages = {
          outside_operation_range: 'Debes estar dentro del rango de la operación.',
          operation_geofence_required: 'La operación no tiene geocerca configurada.',
          location_accuracy_insufficient: 'La precisión del GPS no es suficiente.',
          attendance_native_location_required: 'La app necesita una ubicación segura antes de marcar.',
          attendance_native_location_invalid: 'La ubicación segura no corresponde a esta marcación. Actualízala.',
          attendance_native_location_identity_invalid: 'No fue posible validar este teléfono para la ubicación.',
          attendance_native_location_time_mismatch: 'La ubicación segura venció. Actualízala.',
          attendance_mock_location_detected: 'Android detectó una ubicación simulada. Desactiva la ubicación de prueba antes de marcar.',
          native_location_temporarily_unavailable: 'No fue posible validar la ubicación segura en este momento.',
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
      reportAttendanceFailure(error);
      const locationRejected = LOCATION_PREFLIGHT_ERRORS.has(error?.code);
      if (error?.code === 'biometric_verification_required') {
        clearVerification();
        clearPhoto();
        retryBiometricButton.hidden = false;
      }
      if (locationRejected) {
        clearVerification();
        clearPhoto();
        clearLocation({ rotateAttempt: true });
        if (retryBiometricButton) {
          retryBiometricButton.hidden = false;
          retryBiometricButton.textContent = 'Actualizar ubicación';
        }
      }
      setStatus(error?.message === 'network_request_failed'
        ? publicErrorMessage(error)
        : (error?.message || 'No fue posible registrar.'), 'danger');
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
    clearLocation();
    state.idempotencyKey = null;
    closeModal(dialog);
  }

  function pauseOpenVerification(_reason) {
    if (!dialog.open || !isBiometricMark()) return;
    resumeVerificationPending = Boolean(photoConsent?.checked);
    runToken += 1;
    stopCamera();
    clearPhoto();
    clearLocation();
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
    if (!state.locationEvidence || (nativeAttendanceLocationEnabled && !state.nativeLocationProof)) {
      requestLocation(runToken);
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

  window.addEventListener('lorren-native-presence', handleNativeAttendanceLocation);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pauseOpenVerification('document-hidden');
    else resumeOpenVerification('document-visible');
  }, { capture: true });
  document.addEventListener('freeze', () => pauseOpenVerification('document-frozen'), { capture: true });
  document.addEventListener('resume', () => resumeOpenVerification('document-resumed'), { capture: true });
  window.addEventListener('pagehide', () => pauseOpenVerification('page-hidden'), { capture: true });
  window.addEventListener('pageshow', (event) => {
    if (navigator.onLine) flushAttendanceFailureQueue();
    if (event.persisted || document.wasDiscarded) resumeOpenVerification('page-restored');
  }, { capture: true });

  window.addEventListener('online', () => {
    renderConnectivity();
    flushAttendanceFailureQueue();
    loadBiometricStatus();
  });
  window.addEventListener('offline', enterOfflineMode);

  renderConnectivity();
  if (navigator.onLine) {
    flushAttendanceFailureQueue();
    loadBiometricStatus();
  } else closeEnrollmentDialog();
})();
