'use strict';

(() => {
  if (window.location.pathname !== '/operaciones/portal') return;

  const ENROLLMENT_SUCCESS_PATTERN = /rostro\s+registrado/i;
  const OFFER_DELAY_MS = 700;
  const MAX_DIALOG_WAIT_ATTEMPTS = 12;
  const DIALOG_WAIT_MS = 250;

  let deferredInstallPrompt = null;
  let offerScheduled = false;
  let offerShown = false;
  let installedThisSession = false;

  function isStandalone() {
    return window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || window.navigator.standalone === true;
  }

  function isIos() {
    const userAgent = String(navigator.userAgent || '');
    const classicIos = /iPad|iPhone|iPod/i.test(userAgent);
    const ipadDesktopMode = navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1;
    return classicIos || ipadDesktopMode;
  }

  function isAndroid() {
    return /Android/i.test(String(navigator.userAgent || ''));
  }

  function isInAppBrowser() {
    return /WhatsApp|FBAN|FBAV|Instagram|Line\//i.test(String(navigator.userAgent || ''));
  }

  function createElement(tagName, attributes = {}, text = '') {
    const element = document.createElement(tagName);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === 'className') element.className = value;
      else if (name === 'hidden') element.hidden = Boolean(value);
      else element.setAttribute(name, String(value));
    }
    if (text) element.textContent = text;
    return element;
  }

  function installStyles() {
    if (document.querySelector('[data-worker-portal-install-styles]')) return;
    const style = createElement('style', { 'data-worker-portal-install-styles': 'true' });
    style.textContent = `
      #portal-install-dialog{width:min(calc(100% - 24px),500px);border:0;border-radius:22px;padding:0;box-shadow:0 24px 72px rgba(23,33,43,.3)}
      #portal-install-dialog::backdrop{background:rgba(12,21,29,.72)}
      .portal-install-body{padding:24px}
      .portal-install-icon{display:grid;place-items:center;width:64px;height:64px;margin-bottom:16px;border-radius:18px;background:#eaf8ef;color:#176c36;font-size:31px;font-weight:900}
      .portal-install-brand{margin:0 0 7px;color:#176c36;font-size:12px;font-weight:850;letter-spacing:.08em;text-transform:uppercase}
      .portal-install-title{margin:0;color:#17212b;font-size:25px;line-height:1.15}
      .portal-install-copy{margin:11px 0 0;color:#4d5b69;line-height:1.55}
      .portal-install-benefits{display:grid;gap:9px;margin:18px 0;padding:0;list-style:none}
      .portal-install-benefits li{display:grid;grid-template-columns:24px 1fr;gap:9px;align-items:start;color:#263645;font-weight:700}
      .portal-install-benefits li::before{content:'✓';display:grid;place-items:center;width:22px;height:22px;border-radius:999px;background:#eaf8ef;color:#176c36;font-size:13px;font-weight:900}
      .portal-install-instructions{margin:18px 0 0;padding:15px;border-radius:14px;background:#fff6df;color:#68490c;line-height:1.5}
      .portal-install-instructions ol{margin:9px 0 0;padding-left:22px}
      .portal-install-instructions li+li{margin-top:7px}
      .portal-install-status{margin-top:15px;padding:13px;border-radius:12px;background:#f2f5f7;color:#263645;font-weight:750}
      .portal-install-status.ok{background:#eaf8ef;color:#176c36}
      .portal-install-status.warning{background:#fff6df;color:#76520b}
      .portal-install-actions{display:grid;gap:10px;margin-top:19px}
      .portal-install-primary,.portal-install-secondary{width:100%;min-height:54px;border:0;border-radius:13px;padding:14px 16px;font:inherit;font-weight:850;cursor:pointer}
      .portal-install-primary{background:#176c36;color:#fff}
      .portal-install-secondary{background:#edf1f4;color:#263645}
      .portal-install-primary:disabled{cursor:not-allowed;opacity:.55}
      @media(max-width:760px){#portal-install-dialog{inset:0;width:100vw;max-width:none;height:100dvh;max-height:100dvh;margin:0;border-radius:0}.portal-install-body{min-height:100dvh;padding:max(24px,env(safe-area-inset-top)) 20px max(20px,env(safe-area-inset-bottom));display:flex;flex-direction:column}.portal-install-actions{margin-top:auto;padding-top:20px}}
    `;
    document.head.append(style);
  }

  function buildDialog() {
    const existing = document.getElementById('portal-install-dialog');
    if (existing) return existing;

    installStyles();
    const dialog = createElement('dialog', {
      id: 'portal-install-dialog',
      'aria-labelledby': 'portal-install-title',
      'aria-describedby': 'portal-install-copy'
    });
    const body = createElement('div', { className: 'portal-install-body' });
    const icon = createElement('div', { className: 'portal-install-icon', 'aria-hidden': 'true' }, 'L');
    const brand = createElement('p', { className: 'portal-install-brand' }, 'Lórren · Portal del Auxiliar');
    const title = createElement('h2', { className: 'portal-install-title', id: 'portal-install-title' }, 'Instala el portal en este teléfono');
    const copy = createElement(
      'p',
      { className: 'portal-install-copy', id: 'portal-install-copy' },
      'Ábrelo como una aplicación y conserva el acceso a tus marcaciones cuando la conexión falle.'
    );
    const benefits = createElement('ul', { className: 'portal-install-benefits' });
    benefits.append(
      createElement('li', {}, 'Acceso directo desde la pantalla de inicio.'),
      createElement('li', {}, 'Apertura en una ventana independiente del navegador.'),
      createElement('li', {}, 'Soporte para guardar marcaciones cuando no haya internet.')
    );
    const instructions = createElement('div', { className: 'portal-install-instructions', id: 'portal-install-instructions', hidden: true });
    const status = createElement('div', {
      className: 'portal-install-status',
      id: 'portal-install-status',
      role: 'status',
      'aria-live': 'polite',
      hidden: true
    });
    const actions = createElement('div', { className: 'portal-install-actions' });
    const installButton = createElement('button', {
      type: 'button',
      className: 'portal-install-primary',
      id: 'install-worker-portal'
    }, 'Instalar Portal del Auxiliar');
    const closeButton = createElement('button', {
      type: 'button',
      className: 'portal-install-secondary',
      id: 'dismiss-worker-portal-install'
    }, 'Ahora no');

    actions.append(installButton, closeButton);
    body.append(icon, brand, title, copy, benefits, instructions, status, actions);
    dialog.append(body);
    document.body.append(dialog);

    closeButton.addEventListener('click', () => closeDialog(dialog));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog(dialog);
    });
    installButton.addEventListener('click', () => handleInstall(dialog));
    return dialog;
  }

  function showDialog(dialog) {
    if (dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (!dialog?.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function setStatus(dialog, message, tone = '') {
    const status = dialog.querySelector('#portal-install-status');
    if (!status) return;
    status.hidden = !message;
    status.className = `portal-install-status${tone ? ` ${tone}` : ''}`;
    status.textContent = message;
  }

  function renderManualInstructions(dialog) {
    const instructions = dialog.querySelector('#portal-install-instructions');
    const installButton = dialog.querySelector('#install-worker-portal');
    const closeButton = dialog.querySelector('#dismiss-worker-portal-install');
    if (!instructions || !installButton || !closeButton) return;

    instructions.hidden = false;
    installButton.hidden = true;
    closeButton.textContent = 'Entendido';

    if (isInAppBrowser()) {
      instructions.innerHTML = '<strong>Primero abre este portal en el navegador del teléfono:</strong><ol><li>Pulsa el menú de esta pantalla.</li><li>Selecciona “Abrir en Chrome” o “Abrir en Safari”.</li><li>Desde el navegador, instala o agrega el portal a la pantalla de inicio.</li></ol>';
      return;
    }

    if (isIos()) {
      instructions.innerHTML = '<strong>En iPhone o iPad:</strong><ol><li>Pulsa el botón Compartir de Safari.</li><li>Selecciona “Agregar a pantalla de inicio”.</li><li>Pulsa “Agregar”.</li></ol>';
      return;
    }

    if (isAndroid()) {
      instructions.innerHTML = '<strong>En Android:</strong><ol><li>Abre el menú ⋮ del navegador.</li><li>Pulsa “Instalar aplicación” o “Agregar a pantalla principal”.</li><li>Confirma la instalación.</li></ol>';
      return;
    }

    instructions.innerHTML = '<strong>Instalación manual:</strong><ol><li>Abre el menú del navegador.</li><li>Busca “Instalar aplicación” o “Agregar a pantalla de inicio”.</li><li>Confirma la instalación.</li></ol>';
  }

  function renderInstallState(dialog) {
    const installButton = dialog.querySelector('#install-worker-portal');
    const closeButton = dialog.querySelector('#dismiss-worker-portal-install');
    const instructions = dialog.querySelector('#portal-install-instructions');
    if (!installButton || !closeButton || !instructions) return;

    instructions.hidden = true;
    installButton.hidden = false;
    installButton.disabled = false;
    installButton.textContent = 'Instalar Portal del Auxiliar';
    closeButton.textContent = 'Ahora no';
    setStatus(dialog, 'La instalación requiere tu confirmación.', '');
  }

  async function handleInstall(dialog) {
    const installButton = dialog.querySelector('#install-worker-portal');
    if (!installButton) return;

    if (!deferredInstallPrompt) {
      renderManualInstructions(dialog);
      setStatus(dialog, 'El navegador no habilitó la instalación directa.', 'warning');
      return;
    }

    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    installButton.disabled = true;
    installButton.textContent = 'Abriendo instalación…';
    setStatus(dialog, 'Confirma la instalación en la ventana del navegador.');

    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        installedThisSession = true;
        setStatus(dialog, 'Portal instalado correctamente.', 'ok');
        installButton.hidden = true;
        const closeButton = dialog.querySelector('#dismiss-worker-portal-install');
        if (closeButton) closeButton.textContent = 'Continuar';
        return;
      }
      setStatus(dialog, 'La instalación fue cancelada. Puedes hacerla más adelante.', 'warning');
      renderManualInstructions(dialog);
    } catch {
      renderManualInstructions(dialog);
      setStatus(dialog, 'No fue posible abrir la instalación automática.', 'warning');
    }
  }

  function waitForEnrollmentDialogToClose(attempt = 0) {
    const enrollmentDialog = document.getElementById('enrollment-dialog');
    if (enrollmentDialog?.open && attempt < MAX_DIALOG_WAIT_ATTEMPTS) {
      window.setTimeout(() => waitForEnrollmentDialogToClose(attempt + 1), DIALOG_WAIT_MS);
      return;
    }

    if (isStandalone() || installedThisSession || offerShown) return;
    offerShown = true;
    const dialog = buildDialog();
    if (deferredInstallPrompt) renderInstallState(dialog);
    else renderManualInstructions(dialog);
    showDialog(dialog);
  }

  function scheduleInstallOffer() {
    if (offerScheduled || offerShown || isStandalone() || installedThisSession) return;
    offerScheduled = true;
    window.setTimeout(() => waitForEnrollmentDialogToClose(), OFFER_DELAY_MS);
  }

  function enrollmentCompleted(statusElement) {
    return statusElement?.classList?.contains('ok')
      && ENROLLMENT_SUCCESS_PATTERN.test(String(statusElement.textContent || ''));
  }

  function observeEnrollmentSuccess() {
    const status = document.getElementById('enrollment-status');
    if (!status) return;

    const inspect = () => {
      if (enrollmentCompleted(status)) scheduleInstallOffer();
    };
    const observer = new MutationObserver(inspect);
    observer.observe(status, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class']
    });
    inspect();
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    const dialog = document.getElementById('portal-install-dialog');
    if (dialog?.open) renderInstallState(dialog);
  });

  window.addEventListener('appinstalled', () => {
    installedThisSession = true;
    deferredInstallPrompt = null;
    const dialog = document.getElementById('portal-install-dialog');
    if (!dialog) return;
    setStatus(dialog, 'Portal instalado correctamente.', 'ok');
    const installButton = dialog.querySelector('#install-worker-portal');
    const closeButton = dialog.querySelector('#dismiss-worker-portal-install');
    if (installButton) installButton.hidden = true;
    if (closeButton) closeButton.textContent = 'Continuar';
  });

  window.addEventListener('lorren:face-enrolled', scheduleInstallOffer);
  observeEnrollmentSuccess();
})();
