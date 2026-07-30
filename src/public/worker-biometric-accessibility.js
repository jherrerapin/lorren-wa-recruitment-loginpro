'use strict';

(() => {
  const STYLE_ID = 'lorren-biometric-accessibility-style';
  const HELP_ID = 'lorren-biometric-visible-help';

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #biometric-instruction,
      #enrollment-status {
        font-size: clamp(20px, 5.5vw, 26px) !important;
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

      #enrollment-status,
      #mark-result {
        font-size: clamp(18px, 4.8vw, 22px) !important;
        line-height: 1.4 !important;
      }

      #camera-step .step-title {
        font-size: 19px !important;
      }

      #camera-step .camera-only,
      #enrollment-dialog .camera-only,
      #photo-consent-wrap,
      #enrollment-dialog .consent {
        font-size: 17px !important;
        line-height: 1.5 !important;
        color: #263645 !important;
      }

      #capture-photo,
      #retry-photo,
      #submit-mark,
      #start-enrollment {
        min-height: 52px;
        font-size: 17px !important;
      }

      .lorren-biometric-visible-help {
        display: grid;
        gap: 8px;
        margin: 12px 0;
        padding: 15px;
        border: 1px solid #b8d8c4;
        border-radius: 14px;
        background: #f7fcf9;
        color: #17212b;
        font-size: 17px;
        line-height: 1.5;
      }

      .lorren-biometric-visible-help strong {
        font-size: 18px;
        color: #176c36;
      }

      @media (max-width: 420px) {
        #biometric-instruction,
        #enrollment-status {
          font-size: 21px !important;
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
      if (String(instruction.textContent || '').trim() === 'Mira de frente.') {
        instruction.textContent = 'Mira de frente y centra todo tu rostro dentro del óvalo.';
      }
    }

    const enrollmentStatus = document.getElementById('enrollment-status');
    enrollmentStatus?.setAttribute('aria-atomic', 'true');
  }

  function addVisibleHelp() {
    const cameraStep = document.getElementById('camera-step');
    if (!cameraStep || document.getElementById(HELP_ID)) return;
    const stage = cameraStep.querySelector('.face-stage');
    if (!stage) return;

    const help = document.createElement('div');
    help.id = HELP_ID;
    help.className = 'lorren-biometric-visible-help';
    help.setAttribute('role', 'note');
    help.innerHTML = [
      '<strong>Para que te reconozca correctamente</strong>',
      '<span>1. Mantén todo el rostro dentro del óvalo y mira la instrucción grande de arriba.</span>',
      '<span>2. Busca luz de frente; evita quedar a contraluz.</span>',
      '<span>3. Puedes usar gafas transparentes. Si hay reflejo fuerte o no reconoce tus ojos, inclina un poco el celular o retíralas solo durante la validación.</span>',
      '<span>4. Solo tú debes aparecer frente a la cámara.</span>'
    ].join('');
    stage.before(help);
  }

  function improveStaticCopy() {
    document.querySelectorAll('#camera-step .camera-only, #enrollment-dialog .camera-only').forEach((element) => {
      element.textContent = 'Solo cámara frontal en vivo. Sigue la instrucción grande y mantén buena iluminación.';
    });
  }

  function initialize() {
    if (window.location.pathname !== '/operaciones/portal') return;
    installStyles();
    makeInstructionAccessible();
    addVisibleHelp();
    improveStaticCopy();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
