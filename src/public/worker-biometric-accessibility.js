'use strict';

(() => {
  const STYLE_ID = 'lorren-biometric-accessibility-style';
  const TRANSIENT_CAPTURE_ERRORS = new Set([
    'biometric_capture_timeout',
    'biometric_challenge_not_completed',
    'biometric_descriptor_unavailable',
    'biometric_descriptor_inconsistent'
  ]);

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function installSinglePressVerification() {
    const api = window.LorrenWorkerBiometric;
    if (!api?.captureVerification || api.singlePressVerification === true) return;
    const originalCaptureVerification = api.captureVerification.bind(api);

    async function captureVerification(options = {}) {
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await originalCaptureVerification({ ...options, timeoutMs: 12_000 });
        } catch (error) {
          lastError = error;
          if (attempt > 0 || !TRANSIENT_CAPTURE_ERRORS.has(String(error?.message || ''))) throw error;
          options.onStatus?.('No te muevas. Reintentando automáticamente…');
          await sleep(350);
        }
      }
      throw lastError || new Error('biometric_capture_timeout');
    }

    window.LorrenWorkerBiometric = Object.freeze({
      ...api,
      captureVerification,
      singlePressVerification: true
    });
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #biometric-instruction,
      #enrollment-status {
        font-size: clamp(21px, 5.8vw, 28px) !important;
        line-height: 1.35 !important;
        font-weight: 850 !important;
        letter-spacing: 0 !important;
      }

      #biometric-instruction {
        display: block;
        margin-top: 10px;
        padding: 16px;
        border: 2px solid #176c36;
        border-radius: 14px;
        background: #eef9f2;
        color: #102a1b !important;
        box-shadow: 0 0 0 4px rgba(23, 108, 54, .10);
      }

      #close-mark {
        width: 52px !important;
        min-width: 52px !important;
        height: 52px !important;
        font-size: 30px !important;
        line-height: 1 !important;
      }

      #photo-consent-wrap {
        align-items: center !important;
        gap: 14px !important;
        padding: 14px !important;
        border: 1px solid #b8d8c4;
        border-radius: 14px;
        background: #f7fcf9;
        color: #17212b !important;
        font-size: 18px !important;
        line-height: 1.4 !important;
        font-weight: 650;
      }

      #photo-consent {
        width: 30px !important;
        min-width: 30px !important;
        height: 30px !important;
        accent-color: #176c36;
      }

      #capture-photo,
      #submit-mark {
        min-height: 60px !important;
        padding: 15px 18px !important;
        border-radius: 14px !important;
        font-size: 19px !important;
        font-weight: 850 !important;
      }

      #capture-photo {
        background: #176c36 !important;
        color: #fff !important;
      }

      #retry-photo,
      #cancel-mark {
        min-height: 50px !important;
        font-size: 16px !important;
      }

      @media (max-width: 760px) {
        body:has(#mark-dialog[open]) {
          overflow: hidden;
        }

        #mark-dialog {
          inset: 0 !important;
          width: 100vw !important;
          max-width: none !important;
          height: 100dvh !important;
          max-height: 100dvh !important;
          margin: 0 !important;
          border-radius: 0 !important;
        }

        #mark-dialog .dialog-body {
          display: flex !important;
          flex-direction: column !important;
          min-height: 100dvh !important;
          max-height: 100dvh !important;
          padding: max(10px, env(safe-area-inset-top)) 14px max(8px, env(safe-area-inset-bottom)) !important;
          overflow-y: auto !important;
          overscroll-behavior: contain;
        }

        #mark-dialog .dialog-head {
          position: sticky;
          top: 0;
          z-index: 20;
          align-items: center !important;
          margin: 0 -2px 10px !important;
          padding: 6px 2px 10px !important;
          background: #fff;
        }

        #mark-dialog #camera-step {
          margin-top: 10px !important;
          padding: 12px !important;
        }

        #mark-dialog #camera-step[hidden] {
          display: none !important;
        }

        #mark-dialog .face-stage {
          width: min(100%, 380px) !important;
          max-height: 47dvh !important;
          margin: 10px auto 0 !important;
          aspect-ratio: 3 / 4 !important;
        }

        #mark-dialog .camera-actions {
          grid-template-columns: 1fr !important;
          gap: 9px !important;
        }

        #mark-dialog .dialog-actions {
          position: sticky;
          bottom: 0;
          z-index: 20;
          margin-top: auto !important;
          padding: 12px 0 calc(8px + env(safe-area-inset-bottom)) !important;
          background: #fff;
          box-shadow: 0 -12px 20px rgba(255, 255, 255, .96);
        }

        #biometric-instruction,
        #enrollment-status {
          font-size: 22px !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function makeInstructionAccessible() {
    const instruction = document.getElementById('biometric-instruction');
    if (instruction) {
      instruction.setAttribute('role', 'status');
      instruction.setAttribute('aria-live', 'assertive');
      instruction.setAttribute('aria-atomic', 'true');
    }

    const enrollmentStatus = document.getElementById('enrollment-status');
    enrollmentStatus?.setAttribute('aria-atomic', 'true');
  }

  function prepareBiometricModels() {
    if (!navigator.onLine) return;
    window.LorrenWorkerBiometric?.prepare?.().catch(() => {});
  }

  function enhanceControls() {
    document.querySelectorAll('.mark-button[data-mark-type]').forEach((button) => {
      button.addEventListener('pointerdown', prepareBiometricModels, { passive: true });
      button.addEventListener('click', prepareBiometricModels);
    });

    const consent = document.getElementById('photo-consent');
    const captureButton = document.getElementById('capture-photo');
    const instruction = document.getElementById('biometric-instruction');

    consent?.addEventListener('change', () => {
      if (!consent.checked) return;
      prepareBiometricModels();
      captureButton?.focus({ preventScroll: true });
    });

    captureButton?.addEventListener('click', () => {
      captureButton.textContent = 'Validando rostro…';
      captureButton.setAttribute('aria-busy', 'true');
    });

    if (captureButton) {
      new MutationObserver(() => {
        if (!captureButton.disabled) {
          captureButton.textContent = 'Validar rostro';
          captureButton.removeAttribute('aria-busy');
        }
      }).observe(captureButton, { attributes: true, attributeFilter: ['disabled'] });
    }

    if (instruction && captureButton) {
      new MutationObserver(() => {
        if (!/identidad verificada/i.test(String(instruction.textContent || ''))) return;
        captureButton.textContent = 'Rostro validado';
        captureButton.removeAttribute('aria-busy');
      }).observe(instruction, { childList: true, characterData: true, subtree: true });
    }
  }

  function initialize() {
    if (window.location.pathname !== '/operaciones/portal') return;
    installStyles();
    makeInstructionAccessible();
    enhanceControls();
  }

  installSinglePressVerification();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();