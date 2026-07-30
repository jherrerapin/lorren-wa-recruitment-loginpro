'use strict';

(() => {
  const STYLE_ID = 'lorren-biometric-accessibility-style';

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

      @media (max-width: 420px) {
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

  function initialize() {
    if (window.location.pathname !== '/operaciones/portal') return;
    installStyles();
    makeInstructionAccessible();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
