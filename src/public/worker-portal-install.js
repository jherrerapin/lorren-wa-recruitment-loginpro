'use strict';

(() => {
  const normalizedPath = window.location.pathname.replace(/\/+$/, '') || '/';
  if (normalizedPath !== '/operaciones/portal') return;

  const ENROLLMENT_SUCCESS_PATTERN = /rostro\s+registrado/i;
  const INSTALL_QUERY_PARAM = 'instalarPortal';
  const OFFER_DELAY_MS = 700;
  const MAX_DIALOG_WAIT_ATTEMPTS = 16;
  const DIALOG_WAIT_MS = 250;
  const PROMPT_READY_TIMEOUT_MS = 12_000;

  let deferredInstallPrompt = null;
  let offerScheduled = false;
  let automaticOfferShown = false;
  let installedThisSession = false;
  let promptReadyTimer = null;

  function isStandalone() {
    return window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || window.navigator.standalone === true;
  }

  function userAgent() {
    return String(window.navigator.userAgent || '');
  }

  function isIos() {
    const classicIos = /iPad|iPhone|iPod/i.test(userAgent());
    const ipadDesktopMode = navigator.platform === 'MacIntel'
      && Number(navigator.maxTouchPoints || 0) > 1;
    return classicIos || ipadDesktopMode;
  }

  function isAndroid() {
    return /Android/i.test(userAgent());
  }

  function isChromiumBrowser() {
    return /Chrome|Chromium|CriOS|EdgA|SamsungBrowser/i.test(userAgent())
      && !/Firefox|FxiOS|OPR\//i.test(userAgent());
  }

  function isInAppBrowser() {
    return /WhatsApp|FBAN|FBAV|Instagram|Line\/|wv\)/i.test(userAgent());
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
      #portal-install-cta{display:grid;grid-template-columns:48px minmax(0,1fr) auto;gap:12px;align-items:center;margin:-4px 0 18px;padding:13px 14px;border:1px solid #99c8aa;border-radius:16px;background:#f1faf4;box-shadow:0 9px 24px rgba(23,108,54,.08)}
      .portal-install-cta-icon{display:grid;place-items:center;width:48px;height:48px;border-radius:14px;background:#176c36;color:#fff;font-size:23px;font-weight:900}
      .portal-install-cta-copy strong{display:block;color:#163b24;font-size:14px}.portal-install-cta-copy span{display:block;margin-top:3px;color:#55705f;font-size:12px;line-height:1.35}
      .portal-install-cta-button{min-height:44px;border:0;border-radius:11px;padding:10px 14px;background:#176c36;color:#fff;font:inherit;font-size:13px;font-weight:850;cursor:pointer;white-space:nowrap}
      .portal-install-cta-button:disabled{cursor:progress;opacity:.62}
      #portal-install-dialog{width:min(calc(100% - 24px),500px);border:0;border-radius:22px;padding:0;box-shadow:0 24px 72px rgba(23,33,43,.3)}
      #portal-install-dialog::backdrop{background:rgba(12,21,29,.72)}
      .portal-install-body{padding:24px}.portal-install-icon{display:grid;place-items:center;width:64px;height:64px;margin-bottom:16px;border-radius:18px;background:#eaf8ef;color:#176c36;font-size:31px;font-weight:900}
      .portal-install-brand{margin:0 0 7px;color:#176c36;font-size:12px;font-weight:850;letter-spacing:.08em;text-transform:uppercase}.portal-install-title{margin:0;color:#17212b;font-size:25px;line-height:1.15}
      .portal-install-copy{margin:11px 0 0;color:#4d5b69;line-height:1.55}.portal-install-benefits{display:grid;gap:9px;margin:18px 0;padding:0;list-style:none}
      .portal-install-benefits li{display:grid;grid-template-columns:24px 1fr;gap:9px;align-items:start;color:#263645;font-weight:700}.portal-install-benefits li::before{content:'✓';display:grid;place-items:center;width:22px;height:22px;border-radius:999px;background:#eaf8ef;color:#176c36;font-size:13px;font-weight:900}
      .portal-install-instructions{margin:18px 0 0;padding:15px;border-radius:14px;background:#fff6df;color:#68490c;line-height:1.5}.portal-install-instructions ol{margin:9px 0 0;padding-left:22px}.portal-install-instructions li+li{margin-top:7px}
      .portal-install-status{margin-top:15px;padding:13px;border-radius:12px;background:#f2f5f7;color:#263645;font-weight:750}.portal-install-status.ok{background:#eaf8ef;color:#176c36}.portal-install-status.warning{background:#fff6df;color:#76520b}
      .portal-install-actions{display:grid;gap:10px;margin-top:19px}.portal-install-primary,.portal-install-secondary{width:100%;min-height:54px;border:0;border-radius:13px;padding:14px 16px;font:inherit;font-weight:850;cursor:pointer}
      .portal-install-primary{background:#176c36;color:#fff}.portal-install-secondary{background:#edf1f4;color:#263645}.portal-install-primary:disabled{cursor:progress;opacity:.55}
      @media(max-width:620px){#portal-install-cta{grid-template-columns:44px minmax(0,1fr)}.portal-install-cta-icon{width:44px;height:44px}.portal-install-cta-button{grid-column:1/-1;width:100%}}
      @media(max-width:760px){#portal-install-dialog{inset:0;width:100vw;max-width:none;height:100dvh;max-height:100dvh;margin:0;border-radius:0}.portal-install-body{min-height:100dvh;padding:max(24px,env(safe-area-inset-top)) 20px max(20px,env(safe-area-inset-bottom));display:flex;flex-direction:column}.portal-install-actions{margin-top:auto;padding-top:20px}}
    `;
    document.head.append(style);
  }

  function removeInstallQueryParam() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(INSTALL_QUERY_PARAM)) return;
    url.searchParams.delete(INSTALL_QUERY_PARAM);
    window.history.replaceState(null, document.title, `${url.pathname}${url.search}${url.hash}`);
  }

  function requestedInstallFromExternalBrowser() {
    return new URL(window.location.href).searchParams.get(INSTALL_QUERY_PARAM) === '1';
  }

  function androidChromeIntentUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set(INSTALL_QUERY_PARAM, '1');
    const path = `${url.host}${url.pathname}${url.search}${url.hash}`;
    return `intent://${path}#Intent;scheme=${url.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
  }

  function removeInstallUi() {
    window.clearTimeout(promptReadyTimer);
    document.getElementById('portal-install-cta')?.remove();
    const dialog = document.getElementById('portal-install-dialog');
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
  }

  function configureCtaButton(button) {
    if (!button) return;
    button.disabled = false;
    button.textContent = 'Descargar app';

    if (isAndroid() && isInAppBrowser()) {
      button.textContent = 'Abrir en Chrome y descargar';
      button.dataset.installAction = 'open-chrome';
      return;
    }

    if (deferredInstallPrompt) {
      button.dataset.installAction = 'native-prompt';
      return;
    }

    if (isAndroid() && isChromiumBrowser()) {
      button.disabled = true;
      button.textContent = 'Preparando descarga…';
      button.dataset.installAction = 'waiting-prompt';
      window.clearTimeout(promptReadyTimer);
      promptReadyTimer = window.setTimeout(() => {
        if (deferredInstallPrompt || isStandalone() || installedThisSession) return;
        button.disabled = false;
        button.textContent = 'Reintentar descarga';
        button.dataset.installAction = 'retry-installability';
      }, PROMPT_READY_TIMEOUT_MS);
      return;
    }

    if (isIos()) {
      button.textContent = 'Agregar app al iPhone';
      button.dataset.installAction = 'ios-instructions';
      return;
    }

    button.dataset.installAction = 'manual-fallback';
  }

  function buildPersistentCta() {
    if (isStandalone() || installedThisSession) {
      removeInstallUi();
      return null;
    }
    const existing = document.getElementById('portal-install-cta');
    if (existing) {
      configureCtaButton(existing.querySelector('#open-worker-portal-install'));
      return existing;
    }

    installStyles();
    const cta = createElement('section', {
      id: 'portal-install-cta',
      'aria-label': 'Descargar Portal del Auxiliar'
    });
    const icon = createElement('div', { className: 'portal-install-cta-icon', 'aria-hidden': 'true' }, 'L');
    const copy = createElement('div', { className: 'portal-install-cta-copy' });
    copy.append(
      createElement('strong', {}, 'Descarga el Portal del Auxiliar'),
      createElement('span', {}, 'Instálalo como aplicación para abrirlo rápido y conservar las marcaciones offline.')
    );
    const button = createElement('button', {
      type: 'button',
      className: 'portal-install-cta-button',
      id: 'open-worker-portal-install'
    }, 'Descargar app');
    button.addEventListener('click', handlePersistentButton);
    cta.append(icon, copy, button);

    const connectivity = document.getElementById('portal-connectivity');
    const header = document.querySelector('.portal-header');
    if (connectivity?.parentNode) connectivity.insertAdjacentElement('afterend', cta);
    else if (header?.parentNode) header.insertAdjacentElement('afterend', cta);
    else document.querySelector('main')?.prepend(cta);
    configureCtaButton(button);
    return cta;
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
    const title = createElement('h2', { className: 'portal-install-title', id: 'portal-install-title' }, 'Descarga el portal en este teléfono');
    const copy = createElement('p', { className: 'portal-install-copy', id: 'portal-install-copy' }, 'Chrome abrirá el instalador oficial. No se descarga un APK ni necesitas entrar a Play Store.');
    const benefits = createElement('ul', { className: 'portal-install-benefits' });
    benefits.append(
      createElement('li', {}, 'Icono propio en la pantalla de inicio.'),
      createElement('li', {}, 'Apertura como una aplicación independiente.'),
      createElement('li', {}, 'Soporte para guardar marcaciones sin conexión.')
    );
    const instructions = createElement('div', { className: 'portal-install-instructions', id: 'portal-install-instructions', hidden: true });
    const status = createElement('div', { className: 'portal-install-status', id: 'portal-install-status', role: 'status', 'aria-live': 'polite', hidden: true });
    const actions = createElement('div', { className: 'portal-install-actions' });
    const installButton = createElement('button', { type: 'button', className: 'portal-install-primary', id: 'install-worker-portal' }, 'Descargar app');
    const closeButton = createElement('button', { type: 'button', className: 'portal-install-secondary', id: 'dismiss-worker-portal-install' }, 'Ahora no');

    actions.append(installButton, closeButton);
    body.append(icon, brand, title, copy, benefits, instructions, status, actions);
    dialog.append(body);
    document.body.append(dialog);

    closeButton.addEventListener('click', () => closeDialog(dialog));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog(dialog);
    });
    installButton.addEventListener('click', () => handleNativeInstall(dialog));
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

  function renderIosInstructions(dialog) {
    const instructions = dialog.querySelector('#portal-install-instructions');
    const installButton = dialog.querySelector('#install-worker-portal');
    const closeButton = dialog.querySelector('#dismiss-worker-portal-install');
    if (!instructions || !installButton || !closeButton) return;
    instructions.hidden = false;
    installButton.hidden = true;
    closeButton.textContent = 'Entendido';
    instructions.innerHTML = '<strong>Apple no permite iniciar esta instalación desde un botón:</strong><ol><li>Pulsa Compartir en Safari.</li><li>Selecciona “Agregar a pantalla de inicio”.</li><li>Pulsa “Agregar”.</li></ol>';
    setStatus(dialog, 'En iPhone la instalación depende del menú de Safari.', 'warning');
  }

  function renderPromptNotReady(dialog) {
    const installButton = dialog.querySelector('#install-worker-portal');
    if (!installButton) return;
    installButton.hidden = false;
    installButton.disabled = true;
    installButton.textContent = 'Preparando descarga…';
    setStatus(dialog, 'Chrome está verificando que la aplicación esté lista para instalarse.');
  }

  function renderNativeReady(dialog) {
    const instructions = dialog.querySelector('#portal-install-instructions');
    const installButton = dialog.querySelector('#install-worker-portal');
    const closeButton = dialog.querySelector('#dismiss-worker-portal-install');
    if (!installButton || !closeButton || !instructions) return;
    instructions.hidden = true;
    installButton.hidden = false;
    installButton.disabled = false;
    installButton.textContent = 'Descargar app';
    closeButton.textContent = 'Ahora no';
    setStatus(dialog, 'Pulsa descargar para abrir el instalador oficial de Chrome.');
  }

  function showInstallDialog() {
    if (isStandalone() || installedThisSession) {
      removeInstallUi();
      return;
    }
    const dialog = buildDialog();
    if (deferredInstallPrompt) renderNativeReady(dialog);
    else if (isIos()) renderIosInstructions(dialog);
    else renderPromptNotReady(dialog);
    showDialog(dialog);
  }

  async function refreshInstallability() {
    try {
      const registration = await navigator.serviceWorker?.ready;
      await registration?.update?.();
    } catch {
      // El botón permanece disponible para volver a intentar.
    }
    const manifestLink = document.querySelector('link[rel="manifest"]');
    if (manifestLink?.href) {
      fetch(manifestLink.href, { cache: 'reload', credentials: 'same-origin' }).catch(() => {});
    }
  }

  function handlePersistentButton(event) {
    const button = event.currentTarget;
    const action = button?.dataset?.installAction;

    if (action === 'open-chrome') {
      window.location.href = androidChromeIntentUrl();
      return;
    }

    if (action === 'native-prompt' && deferredInstallPrompt) {
      showInstallDialog();
      return;
    }

    if (action === 'ios-instructions') {
      showInstallDialog();
      return;
    }

    button.disabled = true;
    button.textContent = 'Preparando descarga…';
    refreshInstallability().finally(() => {
      if (deferredInstallPrompt) {
        configureCtaButton(button);
        showInstallDialog();
        return;
      }
      window.setTimeout(() => configureCtaButton(button), 1200);
    });
  }

  async function handleNativeInstall(dialog) {
    const installButton = dialog.querySelector('#install-worker-portal');
    if (!installButton) return;

    if (!deferredInstallPrompt) {
      if (isAndroid() && isInAppBrowser()) {
        window.location.href = androidChromeIntentUrl();
        return;
      }
      if (isIos()) {
        renderIosInstructions(dialog);
        return;
      }
      renderPromptNotReady(dialog);
      await refreshInstallability();
      return;
    }

    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    installButton.disabled = true;
    installButton.textContent = 'Abriendo descarga…';
    setStatus(dialog, 'Confirma la instalación en la ventana de Chrome.');

    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        installedThisSession = true;
        setStatus(dialog, 'Portal instalado correctamente.', 'ok');
        installButton.hidden = true;
        document.getElementById('portal-install-cta')?.remove();
        const closeButton = dialog.querySelector('#dismiss-worker-portal-install');
        if (closeButton) closeButton.textContent = 'Continuar';
        return;
      }
      setStatus(dialog, 'La descarga fue cancelada. Puedes volver a intentarlo.', 'warning');
      installButton.disabled = false;
      installButton.textContent = 'Reintentar descarga';
    } catch {
      setStatus(dialog, 'Chrome no pudo abrir el instalador. Recarga el portal e inténtalo nuevamente.', 'warning');
      installButton.disabled = false;
      installButton.textContent = 'Reintentar descarga';
    }
  }

  function waitForEnrollmentDialogToClose(attempt = 0) {
    const enrollmentDialog = document.getElementById('enrollment-dialog');
    if (enrollmentDialog?.open && attempt < MAX_DIALOG_WAIT_ATTEMPTS) {
      window.setTimeout(() => waitForEnrollmentDialogToClose(attempt + 1), DIALOG_WAIT_MS);
      return;
    }
    if (isStandalone() || installedThisSession || automaticOfferShown) return;
    automaticOfferShown = true;
    showInstallDialog();
  }

  function scheduleInstallOffer() {
    if (offerScheduled || automaticOfferShown || isStandalone() || installedThisSession) return;
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
    window.clearTimeout(promptReadyTimer);
    buildPersistentCta();
    const dialog = document.getElementById('portal-install-dialog');
    if (dialog?.open) renderNativeReady(dialog);
    if (requestedInstallFromExternalBrowser()) {
      removeInstallQueryParam();
      showInstallDialog();
    }
  });

  window.addEventListener('appinstalled', () => {
    installedThisSession = true;
    deferredInstallPrompt = null;
    removeInstallQueryParam();
    document.getElementById('portal-install-cta')?.remove();
    const dialog = document.getElementById('portal-install-dialog');
    if (!dialog) return;
    setStatus(dialog, 'Portal instalado correctamente.', 'ok');
    const installButton = dialog.querySelector('#install-worker-portal');
    const closeButton = dialog.querySelector('#dismiss-worker-portal-install');
    if (installButton) installButton.hidden = true;
    if (closeButton) closeButton.textContent = 'Continuar';
  });

  window.matchMedia?.('(display-mode: standalone)')?.addEventListener?.('change', (event) => {
    if (event.matches) removeInstallUi();
  });

  window.addEventListener('lorren:face-enrolled', scheduleInstallOffer);
  installStyles();
  buildPersistentCta();
  observeEnrollmentSuccess();
  refreshInstallability();
})();
