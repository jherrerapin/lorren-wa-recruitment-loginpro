'use strict';

(() => {
  if (window.location.pathname !== '/operaciones/portal') return;

  const currentApi = window.LorrenWorkerBiometric;
  if (!currentApi || typeof currentApi.captureVerification !== 'function') return;

  const MIN_VISIBLE_VERIFICATION_MS = 5_000;
  const captureVerification = currentApi.captureVerification.bind(currentApi);

  async function captureVerificationWithBriefVisibleWindow(options = {}) {
    const startedAt = performance.now();
    const result = await captureVerification({
      ...options,
      onStatus: () => {}
    });
    const remainingMs = Math.max(0, MIN_VISIBLE_VERIFICATION_MS - (performance.now() - startedAt));
    if (remainingMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, remainingMs));
    }
    return result;
  }

  window.LorrenWorkerBiometric = Object.freeze({
    ...currentApi,
    captureVerification: captureVerificationWithBriefVisibleWindow
  });

  const style = document.createElement('style');
  style.dataset.lorrenFaceVerificationUx = 'true';
  style.textContent = [
    '#mark-dialog[data-flow-state="verifying"] #mark-result',
    '#mark-dialog[data-flow-state="verifying"] #biometric-instruction',
    '#mark-dialog[data-flow-state="verified"] #mark-result',
    '#mark-dialog[data-flow-state="verified"] #biometric-instruction'
  ].join(',') + '{display:none!important;}';
  document.head.appendChild(style);
})();