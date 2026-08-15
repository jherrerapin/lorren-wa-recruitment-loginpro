'use strict';

(() => {
  const normalizedPath = window.location.pathname.replace(/\/+$/, '') || '/';
  if (normalizedPath !== '/operaciones/portal') return;

  const ENROLLMENT_SUCCESS_PATTERN = /rostro\s+registrado/i;
  const INSTALL_QUERY_PARAM = 'instalarPortal';
  const ANDROID_APP_METADATA_PATH = '/operaciones/portal/sesion-transferencia/android-app';
  const OFFER_DELAY_MS = 700;
  const MAX_DIALOG_WAIT_ATTEMPTS = 16;
  const DIALOG_WAIT_MS = 250;

  let deferredInstallPrompt = null;
  let offerScheduled = false;
  let automaticOfferShown = false;
  let installedThisSession = false;
  let androidMetadataPromise = null;

  function userAgent() {
    return String(window.navigator.userAgent || '');
  }

  function isAndroid() {
    return /Android/i.test(userAgent());
  }

  function isIos() {
    const classicIos = /iPad|iPhone|iPod/i.test(userAgent());
    const ipadDesktopMode = navigator.platform === 'MacIntel'
      && Number(navigator.maxTouchPoints || 0) > 1;
    return classicIos || ipadDesktopMode;
  }

  function isAndroidInAppBrowser() {
    return isAndroid() && /WhatsApp|FBAN|FBAV|Instagram|Line\/|wv\)/i.test(userAgent());
  }

  function nativeCapabilities() {
    if (!isAndroid() || !window.LorrenAndroidPresence) return null;
    try {
      const parsed = JSON.parse(window.LorrenAndroidPresence.getCapabilities());
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function isNativeAndroidApp() {
    return nativeCapabilities()?.androidNative === true;
  }

  function isStandalone() {
    return window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || window.navigator.standalone === true;
  }

  function requestedInstallFromExternalBrowser() {
    return new URL(window.location.href).searchParams.get(INSTALL_QUERY_PARAM) === '1';
  }

  function removeInstallQueryParam() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(INSTALL_QUERY_PARAM)) return;
    url.searchParams.delete(INSTALL_QUERY_PARAM);
    window.history.replaceState(null, document.title, `${url.pathname}${url.search}${url.hash}`);
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
      .portal-install-cta-button{min-height:44px;border:0;border-radius:11px;padding:10px 14px;background:#176c36;color:#fff;font:inherit;font-size:13px;font-weight:850;cursor:pointer;white-space:nowrap}.portal-install-cta-button:disabled{cursor:progress;opacity:.62}
      #portal-install-dialog{width:min(calc(100% - 24px),500px);border:0;border-radius:22px;padding:0;box-shadow:0 24px 72px rgba(23,33,43,.3)}#portal-install-dialog::backdrop{background:rgba(12,21,29,.72)}
      .portal-install-body{padding:24px}.portal-install-icon{display:grid;place-items:center;width:64px;height:64px;margin-bottom:16px;border-radius:18px;background:#eaf8ef;color:#176c36;font-size:31px;font-weight:900}
      .portal-install-brand{margin:0 0 7px;color:#176c36;font-size:12px;font-weight:850;letter-spacing:.08em;text-transform:uppercase}.portal-install-title{margin:0;color:#17212b;font-size:25px;line-height:1.15}.portal-install-copy{margin:11px 0 0;color:#4d5b69;line-height:1.55}
      .portal-install-benefits{display:grid;gap:9px;margin:18px 0;padding:0;list-style:none}.portal-install-benefits li{display:grid;grid-template-columns:24px 1fr;gap:9px;align-items:start;color:#263645;font-weight:700}.portal-install-benefits li::before{content:'✓';display:grid;place-items:center;width:22px;height:22px;border-radius:999px;background:#eaf8ef;color:#176c36;font-size:13px;font-weight:900}
      .portal-install-instructions{margin:18px 0 0;padding:15px;border-radius:14px;background:#fff6df;color:#68490c;line-height:1.5}.portal-install-instructions ol{margin:9px 0 0;padding-left:22px}.portal-install-instructions li+li{margin-top:7px}
      .portal-install-status{margin-top:15px;padding:13px;border-radius:12px;background:#f2f5f7;color:#263645;font-weight:750}.portal-install-status.ok{background:#eaf8ef;color:#176c36}.portal-install-status.warning{background:#fff6df;color:#76520b}
      .portal-install-actions{display:grid;gap:10px;margin-top:19px}.portal-install-primary,.portal-install-secondary{width:100%;min-height:54px;border:0;border-radius:13px;padding:14px 16px;font:inherit;font-weight:850;cursor:pointer}.portal-install-primary{background:#176c36;color:#fff}.portal-install-secondary{background:#edf1f4;color:#263645}.portal-install-primary:disabled,.portal-install-secondary:disabled{cursor:progress;opacity:.55}
      @media(max-width:620px){#portal-install-cta{grid-template-columns:44px minmax(0,1fr)}.portal-install-cta-icon{width:44px;height:44px}.portal-install-cta-button{grid-column:1/-1;width:100%}}
      @media(max-width:760px){#portal-install-dialog{inset:0;width:100vw;max-width:none;height:100dvh;max-height:100dvh;margin:0;border-radius:0}.portal-install-body{min-height:100dvh;padding:max(24px,env(safe-area-inset-top)) 20px max(20px,env(safe-area-inset-bottom));display:flex;flex-direction:column}.portal-install-actions{margin-top:auto;padding-top:20px}}
    `;
    document.head.append(style);
  }

  function removeInstallUi() {
    document.getElementById('portal-install-cta')?.remove();
    const dialog = document.getElementById('portal-install-dialog');
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
  }

  function insertCta(cta) {
    const connectivity = document.getElementById('portal-connectivity');
    const header = document.querySelector('.portal-header');
    if (connectivity?.parentNode) connectivity.insertAdjacentElement('afterend', cta);
    else if (header?.parentNode) header.insertAdjacentElement('afterend', cta);
    else document.querySelector('main')?.prepend(cta);
  }

  function buildCta({ title, copy, buttonText, ariaLabel = 'Descargar Portal del Auxiliar', onClick }) {
    document.getElementById('portal-install-cta')?.remove();
    installStyles();
    const cta = createElement('section', { id: 'portal-install-cta', 'aria-label': ariaLabel });
    const icon = createElement('div', { className: 'portal-install-cta-icon', 'aria-hidden': 'true' }, 'L');
    const text = createElement('div', { className: 'portal-install-cta-copy' });
    text.append(createElement('strong', {}, title), createElement('span', {}, copy));
    const button = createElement('button', {
      type: 'button',
      className: 'portal-install-cta-button',
      id: 'open-worker-portal-install'
    }, buttonText);
    if (typeof onClick === 'function') button.addEventListener('click', onClick);
    cta.append(icon, text, button);
    insertCta(cta);
    return cta;
  }

  function setStatus(dialog, message, tone = '') {
    const status = dialog?.querySelector('#portal-install-status');
    if (!status) return;
    status.hidden = !message;
    status.className = `portal-install-status${tone ? ` ${tone}` : ''}`;
    status.textContent = message || '';
  }

  function buildPersistentCta() {
    if (isNativeAndroidApp() || isStandalone() || installedThisSession) {
      removeInstallUi();
      return null;
    }
    if (document.getElementById('portal-install-cta')) return document.getElementById('portal-install-cta');
    return buildCta({
      title: isAndroid() ? 'Instala la app Android de Lórren' : 'Descarga el Portal del Auxiliar',
      copy: isAndroid()
        ? 'APK privado para abrir el Portal y usar la presencia de cuadrilla sin Internet.'
        : 'Instálalo como aplicación para abrirlo rápido y conservar las marcaciones offline.',
      buttonText: isAndroidInAppBrowser() ? 'Abrir en Chrome y descargar' : 'Descargar app',
      onClick: () => showInstallDialog()
    });
  }

  function buildNativeUpdateCta(metadata, capabilities) {
    const installedName = String(capabilities?.appVersionName || '').trim() || `#${capabilities.appVersionCode}`;
    return buildCta({
      ariaLabel: 'Actualizar aplicación Android de Lórren',
      title: 'Actualización de Lórren disponible',
      copy: `Tienes ${installedName}. La versión ${metadata.versionName} está lista para instalar.`,
      buttonText: 'Actualizar Lórren'
    });
  }

  async function loadAndroidMetadata() {
    if (androidMetadataPromise) return androidMetadataPromise;
    androidMetadataPromise = fetch(ANDROID_APP_METADATA_PATH, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true || payload?.available !== true) {
        throw new Error(payload?.error || 'android_app_unavailable');
      }
      const versionCode = Number(payload.versionCode);
      const versionName = String(payload.versionName || '').trim();
      const downloadUrl = String(payload.downloadUrl || '').trim();
      if (!Number.isInteger(versionCode) || versionCode <= 0 || !versionName || !downloadUrl.startsWith('/operaciones/portal/')) {
        throw new Error('android_app_metadata_invalid');
      }
      return { versionCode, versionName, downloadUrl };
    }).catch((error) => {
      androidMetadataPromise = null;
      throw error;
    });
    return androidMetadataPromise;
  }

  async function checkNativeUpdate() {
    const capabilities = nativeCapabilities();
    const installedVersionCode = Number(capabilities?.appVersionCode);
    if (!Number.isInteger(installedVersionCode) || installedVersionCode <= 0) {
      removeInstallUi();
      return;
    }
    try {
      const metadata = await loadAndroidMetadata();
      if (metadata.versionCode > installedVersionCode) buildNativeUpdateCta(metadata, capabilities);
      else removeInstallUi();
    } catch (_error) {
      removeInstallUi();
    }
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
    const title = createElement('h2', { className: 'portal-install-title', id: 'portal-install-title' });
    const copy = createElement('p', { className: 'portal-install-copy', id: 'portal-install-copy' });
    const benefits = createElement('ul', { className: 'portal-install-benefits' });
    const instructions = createElement('div', { className: 'portal-install-instructions', id: 'portal-install-instructions', hidden: true });
    const status = createElement('div', { className: 'portal-install-status', id: 'portal-install-status', role: 'status', 'aria-live': 'polite', hidden: true });
    const actions = createElement('div', { className: 'portal-install-actions' });
    const installButton = createElement('button', { type: 'button', className: 'portal-install-primary', id: 'install-worker-portal' }, 'Descargar app');
    const nativeButton = createElement('button', { type: 'button', className: 'portal-install-secondary', id: 'open-worker-portal-native', hidden: true }, 'Ya la instalé · abrir Lórren');
    const closeButton = createElement('button', { type: 'button', className: 'portal-install-secondary', id: 'dismiss-worker-portal-install' }, 'Ahora no');
    actions.append(installButton, nativeButton, closeButton);
    body.append(icon, brand, title, copy, benefits, instructions, status, actions);
    dialog.append(body);
    document.body.append(dialog);
    closeButton.addEventListener('click', () => closeDialog(dialog));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog(dialog);
    });
    installButton.addEventListener('click', () => handlePrimaryInstall(dialog));
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

  async function renderAndroidDialog(dialog) {
    const title = dialog.querySelector('#portal-install-title');
    const copy = dialog.querySelector('#portal-install-copy');
    const benefits = dialog.querySelector('.portal-install-benefits');
    const instructions = dialog.querySelector('#portal-install-instructions');
    const installButton = dialog.querySelector('#install-worker-portal');
    const nativeButton = dialog.querySelector('#open-worker-portal-native');
    if (!title || !copy || !benefits || !instructions || !installButton || !nativeButton) return;
    title.textContent = 'Instala Lórren en este teléfono';
    copy.textContent = 'Android descargará el APK privado de Lórren desde tu sesión activa. No necesitas Play Store.';
    benefits.replaceChildren(
      createElement('li', {}, 'Usa el mismo Portal del Auxiliar y la misma sesión autorizada.'),
      createElement('li', {}, 'Permite presencia de cuadrilla teléfono a teléfono sin Internet.'),
      createElement('li', {}, 'La clave privada del dispositivo permanece en Android Keystore.')
    );
    instructions.hidden = false;
    instructions.innerHTML = '<strong>Instalación privada:</strong><ol><li>Descarga el APK.</li><li>Android puede pedir permiso para instalar apps desde este navegador.</li><li>Cuando termine, vuelve aquí y pulsa “Ya la instalé · abrir Lórren”.</li></ol>';
    nativeButton.hidden = false;
    if (isAndroidInAppBrowser()) {
      installButton.disabled = false;
      installButton.textContent = 'Abrir en Chrome y descargar';
      setStatus(dialog, 'Primero transferiremos tu sesión a Chrome para mantener la descarga privada.');
      return;
    }
    installButton.disabled = true;
    installButton.textContent = 'Preparando APK…';
    setStatus(dialog, 'Comprobando la versión privada disponible.');
    try {
      const metadata = await loadAndroidMetadata();
      installButton.disabled = false;
      installButton.textContent = `Descargar APK ${metadata.versionName}`;
      installButton.dataset.downloadUrl = metadata.downloadUrl;
      installButton.dataset.versionCode = String(metadata.versionCode);
      setStatus(dialog, `Versión Android ${metadata.versionName} lista para descargar.`, 'ok');
    } catch {
      installButton.disabled = true;
      installButton.textContent = 'APK no disponible';
      setStatus(dialog, 'La versión Android privada todavía no está publicada en el servidor.', 'warning');
    }
  }

  function renderIosDialog(dialog) {
    const title = dialog.querySelector('#portal-install-title');
    const copy = dialog.querySelector('#portal-install-copy');
    const benefits = dialog.querySelector('.portal-install-benefits');
    const instructions = dialog.querySelector('#portal-install-instructions');
    const installButton = dialog.querySelector('#install-worker-portal');
    const nativeButton = dialog.querySelector('#open-worker-portal-native');
    if (!title || !copy || !benefits || !instructions || !installButton || !nativeButton) return;
    title.textContent = 'Agrega el Portal a tu iPhone';
    copy.textContent = 'En iPhone se conserva la instalación web guiada por Safari.';
    benefits.replaceChildren(
      createElement('li', {}, 'Icono propio en la pantalla de inicio.'),
      createElement('li', {}, 'Apertura como aplicación independiente.'),
      createElement('li', {}, 'Acceso rápido al Portal del Auxiliar.')
    );
    instructions.hidden = false;
    instructions.innerHTML = '<strong>Apple no permite iniciar esta instalación desde un botón:</strong><ol><li>Pulsa Compartir en Safari.</li><li>Selecciona “Agregar a pantalla de inicio”.</li><li>Pulsa “Agregar”.</li></ol>';
    installButton.hidden = true;
    nativeButton.hidden = true;
    setStatus(dialog, 'En iPhone la instalación depende del menú de Safari.', 'warning');
  }

  function renderPwaDialog(dialog) {
    const title = dialog.querySelector('#portal-install-title');
    const copy = dialog.querySelector('#portal-install-copy');
    const benefits = dialog.querySelector('.portal-install-benefits');
    const installButton = dialog.querySelector('#install-worker-portal');
    const nativeButton = dialog.querySelector('#open-worker-portal-native');
    const instructions = dialog.querySelector('#portal-install-instructions');
    if (!title || !copy || !benefits || !installButton || !nativeButton || !instructions) return;
    title.textContent = 'Descarga el portal en este dispositivo';
    copy.textContent = 'Tu navegador puede instalar el Portal del Auxiliar como aplicación web.';
    benefits.replaceChildren(
      createElement('li', {}, 'Icono propio en la pantalla de inicio.'),
      createElement('li', {}, 'Apertura como una aplicación independiente.'),
      createElement('li', {}, 'Soporte para marcaciones offline del Portal.')
    );
    instructions.hidden = true;
    nativeButton.hidden = true;
    installButton.hidden = false;
    installButton.disabled = !deferredInstallPrompt;
    installButton.textContent = deferredInstallPrompt ? 'Descargar app' : 'Instalación no disponible';
    setStatus(dialog, deferredInstallPrompt
      ? 'Pulsa descargar para abrir el instalador del navegador.'
      : 'Este navegador no ofreció la instalación automática.', deferredInstallPrompt ? '' : 'warning');
  }

  function showInstallDialog() {
    if (isNativeAndroidApp() || isStandalone() || installedThisSession) return;
    const dialog = buildDialog();
    showDialog(dialog);
    if (isAndroid()) renderAndroidDialog(dialog);
    else if (isIos()) renderIosDialog(dialog);
    else renderPwaDialog(dialog);
  }

  async function handlePrimaryInstall(dialog) {
    const installButton = dialog.querySelector('#install-worker-portal');
    if (!installButton || installButton.disabled) return;
    if (isAndroid()) {
      if (isAndroidInAppBrowser()) return;
      const downloadUrl = String(installButton.dataset.downloadUrl || '');
      if (!downloadUrl.startsWith('/operaciones/portal/')) {
        setStatus(dialog, 'La descarga privada no está preparada.', 'warning');
        return;
      }
      installButton.textContent = 'Descargando APK…';
      setStatus(dialog, 'Android descargará el APK. Después completa la instalación y vuelve a esta pantalla.');
      window.location.href = downloadUrl;
      window.setTimeout(() => {
        if (!installButton.isConnected) return;
        installButton.disabled = false;
        installButton.textContent = 'Descargar APK otra vez';
      }, 2_000);
      return;
    }
    if (!deferredInstallPrompt) return;
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    installButton.disabled = true;
    installButton.textContent = 'Abriendo descarga…';
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        installedThisSession = true;
        setStatus(dialog, 'Portal instalado correctamente.', 'ok');
        installButton.hidden = true;
        document.getElementById('portal-install-cta')?.remove();
        return;
      }
      installButton.disabled = false;
      installButton.textContent = 'Reintentar descarga';
      setStatus(dialog, 'La descarga fue cancelada. Puedes volver a intentarlo.', 'warning');
    } catch {
      installButton.disabled = false;
      installButton.textContent = 'Reintentar descarga';
      setStatus(dialog, 'El navegador no pudo abrir el instalador.', 'warning');
    }
  }

  function waitForEnrollmentDialogToClose(attempt = 0) {
    const enrollmentDialog = document.getElementById('enrollment-dialog');
    if (enrollmentDialog?.open && attempt < MAX_DIALOG_WAIT_ATTEMPTS) {
      window.setTimeout(() => waitForEnrollmentDialogToClose(attempt + 1), DIALOG_WAIT_MS);
      return;
    }
    if (isNativeAndroidApp() || isStandalone() || installedThisSession || automaticOfferShown) return;
    automaticOfferShown = true;
    showInstallDialog();
  }

  function scheduleInstallOffer() {
    if (offerScheduled || automaticOfferShown || isNativeAndroidApp() || isStandalone() || installedThisSession) return;
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
    if (isAndroid()) return;
    deferredInstallPrompt = event;
    buildPersistentCta();
    const dialog = document.getElementById('portal-install-dialog');
    if (dialog?.open) renderPwaDialog(dialog);
  });

  window.addEventListener('appinstalled', () => {
    if (isAndroid()) return;
    installedThisSession = true;
    deferredInstallPrompt = null;
    removeInstallUi();
  });

  window.matchMedia?.('(display-mode: standalone)')?.addEventListener?.('change', (event) => {
    if (event.matches) removeInstallUi();
  });

  if (isNativeAndroidApp()) {
    installStyles();
    checkNativeUpdate();
    return;
  }

  window.addEventListener('lorren:face-enrolled', scheduleInstallOffer);
  installStyles();
  buildPersistentCta();
  observeEnrollmentSuccess();

  if (requestedInstallFromExternalBrowser()) {
    removeInstallQueryParam();
    window.setTimeout(showInstallDialog, 0);
  }
})();
