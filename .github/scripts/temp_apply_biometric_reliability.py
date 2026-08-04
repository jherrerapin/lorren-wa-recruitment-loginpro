from pathlib import Path


def replace_once(pathname: str, old: str, new: str) -> None:
    path = Path(pathname)
    source = path.read_text(encoding='utf-8')
    count = source.count(old)
    if count != 1:
        raise SystemExit(
            f'{pathname}: expected one match, found {count}: {old[:120]!r}'
        )
    path.write_text(source.replace(old, new, 1), encoding='utf-8')


def append_once(pathname: str, marker: str, content: str) -> None:
    path = Path(pathname)
    source = path.read_text(encoding='utf-8')
    if marker in source:
        return
    path.write_text(source.rstrip() + '\n\n' + content.lstrip(), encoding='utf-8')


# ---------------------------------------------------------------------------
# Motor móvil: concede tiempo de finalización cuando ya existe progreso real.
# No modifica umbrales de liveness, anti-spoof ni similitud.
# ---------------------------------------------------------------------------
mobile = 'src/public/worker-biometric-mobile.js'
replace_once(
    mobile,
    "  const DETECTION_INTERVAL_MS = 90;\n  const ENROLLMENT_TIMEOUT_MS = 30_000;",
    "  const DETECTION_INTERVAL_MS = 90;\n"
    "  const SAMPLE_COMPLETION_GRACE_MS = 12_000;\n"
    "  const ACTION_COMPLETION_GRACE_MS = 8_000;\n"
    "  const ENROLLMENT_TIMEOUT_MS = 30_000;"
)

replace_once(
    mobile,
    """  function activePreparationVideo() {
    const markDialog = document.getElementById('mark-dialog');
    if (dialogIsOpen(markDialog)) return document.getElementById('camera-video');
    const enrollmentDialog = document.getElementById('enrollment-dialog');
    if (dialogIsOpen(enrollmentDialog)) return document.getElementById('enrollment-video');
    return null;
  }
""",
    """  function activePreparationVideo() {
    const markDialog = document.getElementById('mark-dialog');
    const markConsent = document.getElementById('photo-consent');
    if (dialogIsOpen(markDialog) && markConsent?.checked === true) {
      return document.getElementById('camera-video');
    }
    const enrollmentDialog = document.getElementById('enrollment-dialog');
    const enrollmentConsent = document.getElementById('enrollment-consent');
    if (dialogIsOpen(enrollmentDialog) && enrollmentConsent?.checked === true) {
      return document.getElementById('enrollment-video');
    }
    return null;
  }
"""
)

replace_once(
    mobile,
    """    const samples = [];
    let consecutiveFront = 0;
    let latest = null;

    while (Date.now() < deadline) {
""",
    """    const samples = [];
    let consecutiveFront = 0;
    let latest = null;
    let activeDeadline = deadline;

    while (Date.now() < activeDeadline) {
"""
)

replace_once(
    mobile,
    """      } catch {
        onStatus?.('No se pudieron leer los rasgos. Mantén la posición.');
      }

      if (samples.length >= samplesRequired) {
""",
    """      } catch {
        onStatus?.('No se pudieron leer los rasgos. Mantén la posición.');
      }

      if (samples.length > 0 && samples.length < samplesRequired) {
        activeDeadline = Math.max(activeDeadline, Date.now() + SAMPLE_COMPLETION_GRACE_MS);
      }

      if (samples.length >= samplesRequired) {
"""
)

replace_once(
    mobile,
    """      onStatus?.(`Rostro válido · captura ${samples.length} de ${samplesRequired}.`);
      await sleep(160);
""",
    """      onStatus?.(`Rostro válido · captura ${samples.length} de ${samplesRequired}. Mantén la posición.`);
      await sleep(160);
"""
)

replace_once(
    mobile,
    """    let consecutiveActionFrames = 0;
    const accepted = [];

    if (challenge.action === 'TURN_SIDE') onStatus?.('Gira el rostro claramente hacia uno de los lados.');
""",
    """    let consecutiveActionFrames = 0;
    const accepted = [];
    let activeDeadline = deadline;
    let actionGraceGranted = false;

    if (challenge.action === 'TURN_SIDE') onStatus?.('Gira el rostro claramente hacia uno de los lados.');
"""
)

replace_once(
    mobile,
    """    while (Date.now() < deadline) {
      const detected = await detectOneFace(human, video, onStatus);
""",
    """    while (Date.now() < activeDeadline) {
      const detected = await detectOneFace(human, video, onStatus);
"""
)

replace_once(
    mobile,
    """      consecutiveActionFrames += 1;
      accepted.push({ scores, geometry, descriptor });
      if (consecutiveActionFrames >= REQUIRED_ACTION_FRAMES) {
""",
    """      consecutiveActionFrames += 1;
      accepted.push({ scores, geometry, descriptor });
      if (consecutiveActionFrames === 1 && !actionGraceGranted) {
        actionGraceGranted = true;
        activeDeadline = Math.max(activeDeadline, Date.now() + ACTION_COMPLETION_GRACE_MS);
      }
      if (consecutiveActionFrames >= REQUIRED_ACTION_FRAMES) {
"""
)


# ---------------------------------------------------------------------------
# Flujo de marcación: un rechazo facial cuenta una vez. Solo los errores
# técnicos reciben un segundo intento automático. El rate limit se presenta
# como cuenta regresiva y se consulta antes de abrir la cámara.
# ---------------------------------------------------------------------------
flow = 'src/public/worker-portal-biometric-flow.js'
replace_once(
    flow,
    """  const MAX_AUTOMATIC_ATTEMPTS = 2;
  const FLOW_RELEASE = '20260801-biometric-integrity-v2';
  const BACKEND_RECOVERY_ERRORS = new Set([
""",
    """  const MAX_AUTOMATIC_ATTEMPTS = 2;
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
"""
)

replace_once(
    flow,
    """  let resumeVerificationPending = false;
  let resumeTimer = null;

  const state = {
""",
    """  let resumeVerificationPending = false;
  let resumeTimer = null;
  let rateLimitTimer = null;
  let rateLimitUntil = 0;
  let rateLimitContext = '';

  const state = {
"""
)

replace_once(
    flow,
    """    return messages[code] || 'No fue posible confirmar tu identidad.';
  }

  function verificationStillValid() {
""",
    """    return messages[code] || 'No fue posible confirmar tu identidad.';
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
"""
)

replace_once(
    flow,
    """    setStatus(
      attemptNumber === 1 ? 'Preparando reconocimiento facial…' : 'Segundo intento automático…',
      'neutral'
    );

    if (!biometricApi || !navigator.onLine) throw new Error('camera_unavailable');
    await biometricApi.prepare?.();

    const challenge = await requestBiometricChallenge();
    const stream = await biometricApi.startCamera(cameraVideo);
""",
    """    setStatus(
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
"""
)

replace_once(
    flow,
    """  async function runAutomaticVerification() {
    if (verificationInProgress || !dialog.open || !isBiometricMark()) return;
    if (!photoConsent?.checked) {
""",
    """  async function runAutomaticVerification() {
    if (verificationInProgress || !dialog.open || !isBiometricMark()) return;
    if (activeRateLimitSeconds() > 0) {
      startRateLimitCountdown();
      return;
    }
    if (!photoConsent?.checked) {
"""
)

replace_once(
    flow,
    """        } catch (error) {
          lastError = error;
          stopCamera();
          if (errorCode(error) === 'biometric_flow_cancelled') return;
          if (errorCode(error) === 'attendance_biometric_rate_limited') break;
          if (attempt < MAX_AUTOMATIC_ATTEMPTS) {
            await recoverAfterFailure(error, localRunToken);
            if (localRunToken !== runToken || !dialog.open) return;
          }
        }
      }

      clearVerification();
      clearPhoto();
      setStatus(`${publicErrorMessage(lastError)} Puedes intentar nuevamente.`, 'danger');
      retryBiometricButton.hidden = false;
      retryBiometricButton.focus({ preventScroll: true });
""",
    """        } catch (error) {
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
"""
)

replace_once(
    flow,
    """    retryBiometricButton.hidden = true;
    submitButton.disabled = true;
""",
    """    retryBiometricButton.hidden = true;
    retryBiometricButton.disabled = false;
    retryBiometricButton.textContent = 'Intentar nuevamente';
    submitButton.disabled = true;
"""
)

replace_once(
    flow,
    """    resetMarkDialog();
    showModal(dialog);
    const localRunToken = runToken;
    requestLocation(localRunToken);

    if (isBiometricMark()) {
      biometricApi?.prepare?.().catch(() => {});
      window.setTimeout(() => photoConsent?.focus({ preventScroll: true }), 0);
    } else {
      updateSubmitState();
    }
""",
    """    resetMarkDialog();
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
"""
)

replace_once(
    flow,
    """  function closeMarkDialog() {
    runToken += 1;
    resumeVerificationPending = false;
    if (resumeTimer) window.clearTimeout(resumeTimer);
    resumeTimer = null;
    stopCamera();
""",
    """  function closeMarkDialog() {
    runToken += 1;
    resumeVerificationPending = false;
    if (resumeTimer) window.clearTimeout(resumeTimer);
    resumeTimer = null;
    clearRateLimitTimer();
    stopCamera();
"""
)

replace_once(
    flow,
    """    }
    runAutomaticVerification();
  });

  retryBiometricButton?.addEventListener('click', runAutomaticVerification);
""",
    """    }
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
"""
)


# ---------------------------------------------------------------------------
# Servidor: los fallos se limitan por etapa de la jornada, no mezclando
# llegada, almuerzo y salida. El desafío dura suficiente para móviles lentos.
# ---------------------------------------------------------------------------
service = 'src/services/workerBiometricService.js'
replace_once(
    service,
    'const CHALLENGE_TTL_MS = 2 * 60 * 1000;',
    'const CHALLENGE_TTL_MS = 3 * 60 * 1000;'
)

replace_once(
    service,
    """  const workerId = normalizeString(input.workerId, 120);
  const assignmentId = normalizeString(input.assignmentId, 120);
  const now = options.now || new Date();
  if (!workerId || !assignmentId || !validDate(now)) {
""",
    """  const workerId = normalizeString(input.workerId, 120);
  const assignmentId = normalizeString(input.assignmentId, 120);
  const markType = normalizeString(input.markType, 40)?.toUpperCase() || null;
  const now = options.now || new Date();
  if (!workerId || !assignmentId || !validDate(now) || (markType && !BIOMETRIC_MARK_TYPES.has(markType))) {
"""
)

replace_once(
    service,
    """  const relevant = events
    .filter((event) => String(event?.metadata?.workerId || '') === workerId)
    .sort((left, right) => (assessmentTime(right)?.getTime() || 0) - (assessmentTime(left)?.getTime() || 0));
""",
    """  const relevant = events
    .filter((event) => (
      String(event?.metadata?.workerId || '') === workerId
      && (!markType || String(event?.metadata?.markType || '') === markType)
    ))
    .sort((left, right) => (assessmentTime(right)?.getTime() || 0) - (assessmentTime(left)?.getTime() || 0));
"""
)

replace_once(
    service,
    'await assertWorkerBiometricAttemptAllowed(prisma, { workerId, assignmentId }, { now });',
    'await assertWorkerBiometricAttemptAllowed(prisma, { workerId, assignmentId, markType }, { now });'
)

route = 'src/routes/workerPortal.js'
replace_once(
    route,
    """      await assertAttemptAllowedFn({
        workerId: portalSession.workerId,
        assignmentId: context.assignmentId
      }, { now });
""",
    """      await assertAttemptAllowedFn({
        workerId: portalSession.workerId,
        assignmentId: context.assignmentId,
        markType: context.markType
      }, { now });
"""
)


# ---------------------------------------------------------------------------
# Forzar que la PWA instalada reciba la nueva lógica.
# ---------------------------------------------------------------------------
replace_once(
    'src/public/worker-biometric.js',
    "const BIOMETRIC_ASSET_RELEASE = '20260803-worker-portal-runtime-v5';",
    "const BIOMETRIC_ASSET_RELEASE = '20260804-worker-portal-biometric-v6';"
)
replace_once(
    'src/public/worker-portal-sw.js',
    "const CACHE_NAME = 'lorren-worker-portal-shell-v11';",
    "const CACHE_NAME = 'lorren-worker-portal-shell-v12';"
)


# ---------------------------------------------------------------------------
# Contratos de regresión.
# ---------------------------------------------------------------------------
replace_once(
    'test/workerBiometricIntegrationContracts.test.js',
    "assert.match(loader, /BIOMETRIC_ASSET_RELEASE\\s*=\\s*'20260803-worker-portal-runtime-v5'/);",
    "assert.match(loader, /BIOMETRIC_ASSET_RELEASE\\s*=\\s*'20260804-worker-portal-biometric-v6'/);"
)

append_once(
    'test/workerBiometricIntegrationContracts.test.js',
    "los fallos de una etapa no bloquean otra marcación de la jornada",
    """
test('los fallos de una etapa no bloquean otra marcación de la jornada', async () => {
  const prisma = fakePrisma();
  for (let index = 0; index < 5; index += 1) {
    prisma.events.push({
      id: `break-failure-${index}`,
      entityType: 'DISPATCH_ATTENDANCE_BIOMETRIC',
      entityId: `break-failed-key-${index}`,
      entityLabel: ASSIGNMENT_ID,
      action: 'BIOMETRIC_ASSESSED',
      metadata: {
        workerId: WORKER_ID,
        markType: 'BREAK_END',
        verified: false,
        decision: 'REVIEW_REQUIRED',
        assessedAt: new Date(NOW.getTime() - index * 1_000).toISOString()
      },
      createdAt: new Date(NOW.getTime() - index * 1_000)
    });
  }

  const departure = await assertWorkerBiometricAttemptAllowed(prisma, {
    workerId: WORKER_ID,
    assignmentId: ASSIGNMENT_ID,
    markType: 'DEPARTURE'
  }, { now: NOW });
  assert.equal(departure.allowed, true);

  await assert.rejects(
    () => assertWorkerBiometricAttemptAllowed(prisma, {
      workerId: WORKER_ID,
      assignmentId: ASSIGNMENT_ID,
      markType: 'BREAK_END'
    }, { now: NOW }),
    (error) => error.message === 'attendance_biometric_rate_limited'
  );
});
"""
)

replace_once(
    'test/workerPortalUiCacheContracts.test.js',
    "lorren-worker-portal-shell-v11",
    "lorren-worker-portal-shell-v12"
)
replace_once(
    'test/workerPortalUiCacheContracts.test.js',
    "20260803-worker-portal-runtime-v5",
    "20260804-worker-portal-biometric-v6"
)

Path('test/workerBiometricMarkingReliabilityContracts.test.js').write_text(
    """import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const flow = read('src/public/worker-portal-biometric-flow.js');
const mobile = read('src/public/worker-biometric-mobile.js');
const service = read('src/services/workerBiometricService.js');
const route = read('src/routes/workerPortal.js');
const loader = read('src/public/worker-biometric.js');
const serviceWorker = read('src/public/worker-portal-sw.js');

test('un rechazo facial no genera otro rechazo automático ni acelera el bloqueo', () => {
  assert.match(flow, /AUTOMATIC_RETRY_ERRORS = new Set/);
  const retrySet = flow.slice(
    flow.indexOf('AUTOMATIC_RETRY_ERRORS = new Set'),
    flow.indexOf('BACKEND_RECOVERY_ERRORS')
  );
  assert.doesNotMatch(retrySet, /biometric_verification_rejected/);
  assert.match(flow, /if \(!AUTOMATIC_RETRY_ERRORS\.has\(code\)\) break/);
  assert.match(flow, /code === 'attendance_biometric_rate_limited'/);
});

test('el límite temporal muestra cuenta regresiva y bloquea el botón hasta vencer', () => {
  assert.match(flow, /function beginRateLimitCooldown\(secondsValue\)/);
  assert.match(flow, /function startRateLimitCountdown\(\)/);
  assert.match(flow, /Reintentar en \$\{seconds\} s/);
  assert.match(flow, /retryBiometricButton\.disabled = true/);
  assert.match(flow, /activeRateLimitSeconds\(\) > 0/);
});

test('la segunda muestra recibe tiempo adicional sin reducir liveness ni anti-spoof', () => {
  assert.match(mobile, /SAMPLE_COMPLETION_GRACE_MS = 12_000/);
  assert.match(mobile, /ACTION_COMPLETION_GRACE_MS = 8_000/);
  assert.match(mobile, /activeDeadline = Math\.max\(activeDeadline, Date\.now\(\) \+ SAMPLE_COMPLETION_GRACE_MS\)/);
  assert.match(mobile, /scores\.realScore < MIN_REAL_SCORE/);
  assert.match(mobile, /scores\.liveScore < MIN_LIVE_SCORE/);
});

test('la cámara solo se abre después del consentimiento y el bloqueo se consulta antes', () => {
  assert.match(mobile, /markConsent\?\.checked === true/);
  assert.match(mobile, /enrollmentConsent\?\.checked === true/);
  const challengePosition = flow.indexOf('const challenge = await requestBiometricChallenge()');
  const preparePosition = flow.indexOf('await biometricApi.prepare?.()', challengePosition);
  assert.ok(challengePosition >= 0 && preparePosition > challengePosition);
});

test('el límite se separa por tipo de marcación en cliente y servidor', () => {
  assert.match(service, /const markType = normalizeString\(input\.markType, 40\)/);
  assert.match(service, /metadata\?\.markType/);
  assert.match(route, /markType: context\.markType/);
  assert.match(flow, /`\$\{state\.assignmentId\}:\$\{state\.markType\}`/);
});

test('la aplicación instalada recibe una versión nueva del motor y de la caché', () => {
  assert.match(loader, /20260804-worker-portal-biometric-v6/);
  assert.match(serviceWorker, /lorren-worker-portal-shell-v12/);
});
""",
    encoding='utf-8'
)
