'use strict';

(() => {
  const MODEL_VERSION = 'human-3.3.6-faceres';
  const reviewRequiredKeys = new Set();
  const MARK_ENDPOINT_PATTERN = /\/operaciones\/portal\/asignaciones\/[^/]+\/(llegada|inicio-almuerzo|fin-almuerzo|salida)$/;

  function installPortalResponseGuard() {
    if (!window.location.pathname.startsWith('/operaciones/portal') || window.__lorrenBiometricFetchGuard) return;
    window.__lorrenBiometricFetchGuard = true;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const response = await originalFetch(input, init);

      if (url.includes('/biometria/verificar') && typeof init.body === 'string') {
        try {
          const requestPayload = JSON.parse(init.body);
          const responsePayload = await response.clone().json();
          if (responsePayload?.requiresReview && requestPayload?.idempotencyKey) {
            reviewRequiredKeys.add(String(requestPayload.idempotencyKey));
          }
        } catch {
          // El controlador que originó la solicitud conserva el manejo del error.
        }
        return response;
      }

      if (MARK_ENDPOINT_PATTERN.test(url) && init.body instanceof FormData) {
        const idempotencyKey = String(init.body.get('idempotencyKey') || '');
        if (idempotencyKey && reviewRequiredKeys.has(idempotencyKey) && response.ok) {
          try {
            const payload = await response.clone().json();
            reviewRequiredKeys.delete(idempotencyKey);
            const headers = new Headers(response.headers);
            headers.set('Content-Type', 'application/json; charset=utf-8');
            return new Response(JSON.stringify({
              ...payload,
              requiresReview: true,
              message: 'Marcación registrada y enviada para revisión.'
            }), {
              status: response.status,
              statusText: response.statusText,
              headers
            });
          } catch {
            return response;
          }
        }
      }

      return response;
    };
  }

  installPortalResponseGuard();

  window.LorrenWorkerBiometric = Object.freeze({
    MODEL_VERSION,
    humanFaceSimilarity: (left, right) => {
      if (!window.Human?.match?.similarity) return null;
      return window.Human.match.similarity(left, right);
    }
  });
})();
