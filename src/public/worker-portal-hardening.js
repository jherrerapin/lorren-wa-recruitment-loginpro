'use strict';

(() => {
  const STRICT_ERRORS = Object.freeze({
    outside_operation_range: 'Debes estar dentro del rango de la operación para marcar.',
    operation_geofence_required: 'La operación no tiene una geocerca válida.',
    location_accuracy_insufficient: 'La precisión del GPS no es suficiente. Intenta nuevamente al aire libre.',
    biometric_enrollment_required: 'Primero completa el registro facial inicial.',
    biometric_verification_required: 'Completa correctamente la validación facial para marcar.',
    online_biometric_required: 'Necesitas conexión para validar el rostro.',
    biometric_challenge_failed: 'No fue posible iniciar la validación facial.',
    biometric_request_invalid: 'No fue posible preparar la validación facial.',
    portal_session_required: 'Tu sesión del portal venció. Abre nuevamente el enlace del auxiliar.',
    assignment_not_available: 'La asignación ya no está disponible para validar el rostro.',
    biometric_temporarily_unavailable: 'La validación facial está temporalmente no disponible.',
    attendance_biometric_consent_required: 'Debes autorizar el registro facial para continuar.',
    attendance_biometric_antispoof_low: 'No se confirmó un rostro real. Intenta nuevamente.',
    attendance_biometric_liveness_low: 'No se confirmó el movimiento solicitado. Intenta nuevamente.',
    biometric_verification_rejected: 'El rostro no fue verificado. Repite la captura.'
  });
  const LEGACY_BIOMETRIC_ROUTES = Object.freeze({
    '/admin/operaciones/portal-activaciones/biometria/desafio': '/operaciones/portal/biometria/desafio',
    '/admin/operaciones/portal-activaciones/biometria/verificar': '/operaciones/portal/biometria/verificar'
  });

  let currentMarkType = null;
  let biometricVerified = false;
  let lastBiometricStartError = null;
  const previousFetch = window.fetch.bind(window);

  function markResult(message, className = 'danger') {
    const result = document.getElementById('mark-result');
    if (!result) return;
    result.hidden = false;
    result.className = `status ${className}`;
    result.textContent = message;
  }

  function rewriteBiometricInput(input) {
    const originalUrl = typeof input === 'string' ? input : String(input?.url || '');
    const matchedPath = Object.keys(LEGACY_BIOMETRIC_ROUTES)
      .find((path) => originalUrl.includes(path));
    if (!matchedPath) return { input, url: originalUrl };
    const rewrittenUrl = originalUrl.replace(matchedPath, LEGACY_BIOMETRIC_ROUTES[matchedPath]);
    if (typeof input === 'string') return { input: rewrittenUrl, url: rewrittenUrl };
    return { input: new Request(rewrittenUrl, input), url: rewrittenUrl };
  }

  window.fetch = async (input, init = {}) => {
    const rewritten = rewriteBiometricInput(input);
    const url = rewritten.url;
    let nextInit = init;

    if (url.includes('/biometria/verificar') && typeof init.body === 'string') {
      try {
        const payload = JSON.parse(init.body);
        payload.consentAccepted = document.getElementById('photo-consent')?.checked === true;
        nextInit = { ...init, body: JSON.stringify(payload) };
      } catch {
        // La ruta del servidor rechazará una solicitud inválida.
      }
    }

    const response = await previousFetch(rewritten.input, nextInit);

    if (url.includes('/biometria/desafio')) {
      try {
        const payload = await response.clone().json();
        lastBiometricStartError = response.ok
          ? null
          : (STRICT_ERRORS[payload?.error] || payload?.message || 'No fue posible iniciar la validación facial.');
      } catch {
        lastBiometricStartError = response.ok ? null : 'No fue posible iniciar la validación facial.';
      }
    }

    if (url.includes('/biometria/verificar')) {
      try {
        const payload = await response.clone().json();
        biometricVerified = Boolean(response.ok && payload?.ok && payload?.verified === true);
        if (!biometricVerified) {
          const message = STRICT_ERRORS[payload?.error] || 'La validación facial no fue aprobada.';
          window.setTimeout(() => markResult(message, 'danger'), 0);
        }
      } catch {
        biometricVerified = false;
      }
    }

    if (/\/operaciones\/portal\/asignaciones\/[^/]+\/(llegada|inicio-almuerzo|fin-almuerzo|salida)$/.test(url) && !response.ok) {
      try {
        const payload = await response.clone().json();
        const message = STRICT_ERRORS[payload?.error] || payload?.message;
        if (message) window.setTimeout(() => markResult(message, 'danger'), 0);
      } catch {
        // La interfaz principal conserva el mensaje de error.
      }
    }

    return response;
  };

  function installBiometricStartMessageObserver() {
    const result = document.getElementById('mark-result');
    if (!result) return;
    const clarify = () => {
      const text = String(result.textContent || '');
      if (!/No fue posible iniciar la cámara y la validación facial/i.test(text)) return;
      result.textContent = lastBiometricStartError
        || 'No fue posible abrir la cámara frontal. Cierra otras aplicaciones que puedan estar usándola e intenta nuevamente.';
    };
    new MutationObserver(clarify).observe(result, { childList: true, characterData: true, subtree: true });
  }

  function initializeWorkerPortal() {
    if (window.location.pathname !== '/operaciones/portal') return;

    installBiometricStartMessageObserver();

    document.querySelectorAll('.mark-button[data-mark-type]').forEach((button) => {
      button.addEventListener('click', (event) => {
        currentMarkType = button.dataset.markType || null;
        biometricVerified = false;
        lastBiometricStartError = null;
        if (!navigator.onLine) {
          event.preventDefault();
          event.stopImmediatePropagation();
          markResult('Necesitas conexión para validar el rostro y la ubicación.', 'danger');
        }
      }, true);
    });

    document.getElementById('capture-photo')?.addEventListener('click', (event) => {
      if (!['ARRIVAL', 'DEPARTURE'].includes(currentMarkType)) return;
      if (document.getElementById('photo-consent')?.checked === true) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      markResult('Autoriza la captura para continuar.', 'warning');
    }, true);

    document.getElementById('submit-mark')?.addEventListener('click', (event) => {
      if (!['ARRIVAL', 'DEPARTURE'].includes(currentMarkType) || biometricVerified) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      markResult('Primero completa correctamente la validación facial.', 'danger');
    }, true);

    window.addEventListener('online', () => {
      const enrollmentDialog = document.getElementById('enrollment-dialog');
      const enrollmentButton = document.getElementById('start-enrollment');
      if (enrollmentDialog?.open && enrollmentButton?.disabled) window.location.reload();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeWorkerPortal, { once: true });
  else initializeWorkerPortal();
})();
