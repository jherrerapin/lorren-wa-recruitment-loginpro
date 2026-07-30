'use strict';

(() => {
  const STYLE_ID = 'lorren-biometric-accessibility-style';
  const FLOW_VERSION = '2026-07-29-r4';
  let activeMarkButton = null;
  let automaticRetryUsed = false;
  let automaticRetryPending = false;
  let lastInstruction = '';

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function waitFor(predicate, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(100);
    }
    throw new Error('biometric_ui_wait_timeout');
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

  function finalFailureMessage() {
    const normalized = lastInstruction.toLowerCase();
    if (normalized.includes('rostro real')) return 'No se confirmó un rostro real. Intenta con luz de frente y sin reflejos.';
    if (normalized.includes('hombro') || normalized.includes('acerca')) return 'No se confirmó el movimiento solicitado.';
    return 'No fue posible confirmar que el rostro coincide con el registrado.';
  }

  async function retryCompleteFlow() {
    const dialog = document.getElementById('mark-dialog');
    const closeButton = document.getElementById('close-mark');
    const captureButton = document.getElementById('capture-photo');
    const consent = document.getElementById('photo-consent');
    const instruction = document.getElementById('biometric-instruction');
    const result = document.getElementById('mark-result');

    if (automaticRetryUsed || automaticRetryPending || !activeMarkButton || !dialog?.open) return;
    automaticRetryUsed = true;
    automaticRetryPending = true;

    if (instruction) instruction.textContent = 'Reintentando automáticamente. Mira de frente.';
    if (result) {
      result.hidden = false;
      result.className = 'status warning';
      result.textContent = 'La primera lectura no concluyó. Reintentando sin que pulses otra vez…';
    }

    try {
      closeButton?.click();
      await sleep(250);
      activeMarkButton.click();
      await waitFor(() => Boolean(dialog.open && captureButton && !captureButton.disabled));
      if (consent) {
        consent.checked = true;
        consent.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (instruction) instruction.textContent = 'Mira de frente. Segundo intento automático.';
      captureButton.click();
    } catch {
      if (result) {
        result.hidden = false;
        result.className = 'status danger';
        result.textContent = 'No fue posible reiniciar automáticamente la validación facial.';
      }
    } finally {
      automaticRetryPending = false;
    }
  }

  function installFlowRecovery() {
    const dialog = document.getElementById('mark-dialog');
    const captureButton = document.getElementById('capture-photo');
    const instruction = document.getElementById('biometric-instruction');
    const result = document.getElementById('mark-result');

    document.documentElement.dataset.lorrenBiometricFlow = FLOW_VERSION;

    document.querySelectorAll('.mark-button[data-mark-type]').forEach((button) => {
      button.addEventListener('pointerdown', prepareBiometricModels, { passive: true });
      button.addEventListener('click', (event) => {
        activeMarkButton = button;
        if (event.isTrusted) {
          automaticRetryUsed = false;
          automaticRetryPending = false;
        }
        prepareBiometricModels();
      }, true);
    });

    document.getElementById('photo-consent')?.addEventListener('change', (event) => {
      if (!event.currentTarget.checked) return;
      prepareBiometricModels();
      captureButton?.focus({ preventScroll: true });
    });

    captureButton?.addEventListener('click', () => {
      captureButton.textContent = 'Validando rostro…';
      captureButton.setAttribute('aria-busy', 'true');
    });

    if (captureButton) {
      new MutationObserver(() => {
        if (!captureButton.disabled && !/validado/i.test(captureButton.textContent || '')) {
          captureButton.textContent = 'Validar rostro';
          captureButton.removeAttribute('aria-busy');
        }
      }).observe(captureButton, { attributes: true, attributeFilter: ['disabled'] });
    }

    if (instruction) {
      lastInstruction = String(instruction.textContent || '');
      new MutationObserver(() => {
        lastInstruction = String(instruction.textContent || '');
        if (!/identidad verificada/i.test(lastInstruction)) return;
        if (captureButton) {
          captureButton.textContent = 'Rostro validado';
          captureButton.removeAttribute('aria-busy');
        }
      }).observe(instruction, { childList: true, characterData: true, subtree: true });
    }

    if (result) {
      new MutationObserver(() => {
        const text = String(result.textContent || '');
        const failed = /La validación facial falló|validación facial no fue aprobada|rostro no fue verificado/i.test(text);
        if (!failed || !dialog?.open) return;
        if (!automaticRetryUsed) {
          window.setTimeout(() => retryCompleteFlow(), 180);
          return;
        }
        result.className = 'status danger';
        result.textContent = finalFailureMessage();
      }).observe(result, { childList: true, characterData: true, subtree: true });
    }
  }

  function initialize() {
    if (window.location.pathname !== '/operaciones/portal') return;
    installStyles();
    makeInstructionAccessible();
    installFlowRecovery();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
