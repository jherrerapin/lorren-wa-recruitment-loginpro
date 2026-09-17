'use strict';

(() => {
  const PORTAL_PATH = '/operaciones/portal';
  const CREATE_HANDOFF_PATH = `${PORTAL_PATH}/sesion-transferencia/crear`;
  const CONTINUE_HANDOFF_PATH = `${PORTAL_PATH}/sesion-transferencia/continuar`;
  const INSTALL_QUERY_PARAM = 'instalarPortal';
  const INSTALL_BUTTON_IDS = new Set([
    'open-worker-portal-install',
    'install-worker-portal'
  ]);
  const NATIVE_OPEN_BUTTON_ID = 'open-worker-portal-native';

  let handoffInProgress = false;

  function userAgent() {
    return String(window.navigator.userAgent || '');
  }

  function platformHint() {
    return String(window.navigator.userAgentData?.platform || window.navigator.platform || '');
  }

  function isChromiumAndroidDesktopMode() {
    const userAgentValue = userAgent();
    const platformValue = platformHint();
    return Number(window.navigator.maxTouchPoints || 0) > 1
      && /Linux|X11/i.test(`${userAgentValue} ${platformValue}`)
      && /Chrome|Chromium|Edg|SamsungBrowser/i.test(userAgentValue)
      && !/Firefox|FxiOS|OPR\//i.test(userAgentValue);
  }

  function isAndroid() {
    return Boolean(window.LorrenAndroidPresence)
      || /Android/i.test(userAgent())
      || /Android/i.test(platformHint())
      || isChromiumAndroidDesktopMode();
  }

  function isNativeAndroidApp() {
    return isAndroid() && Boolean(window.LorrenAndroidPresence);
  }

  function isAndroidInAppBrowser() {
    return isAndroid()
      && /WhatsApp|FBAN|FBAV|Instagram|Line\/|wv\)/i.test(userAgent());
  }

  function shouldTransferInstallToChrome() {
    return (isNativeAndroidApp() || isAndroidInAppBrowser()) && !handoffAlreadyCompleted();
  }

  function handoffAlreadyCompleted() {
    return new URL(window.location.href).searchParams.get(INSTALL_QUERY_PARAM) === '1';
  }

  function buttonFromEvent(event) {
    const element = event.target instanceof Element
      ? event.target.closest('button')
      : null;
    if (!element) return null;
    if (element.id === NATIVE_OPEN_BUTTON_ID) return element;
    return INSTALL_BUTTON_IDS.has(element.id) ? element : null;
  }

  function statusElement() {
    return document.getElementById('portal-install-status');
  }

  function setStatus(message, warning = false) {
    const status = statusElement();
    if (!status) return;
    status.hidden = false;
    status.className = `portal-install-status${warning ? ' warning' : ''}`;
    if (status.textContent !== message) status.textContent = message;
  }

  function ensureNativeOpenButton() {
    if (isNativeAndroidApp()) return null;
    const actions = document.querySelector('#portal-install-dialog .portal-install-actions');
    if (!actions) return null;

    let button = document.getElementById(NATIVE_OPEN_BUTTON_ID);
    if (button) return button;

    button = document.createElement('button');
    button.type = 'button';
    button.className = 'portal-install-secondary';
    button.id = NATIVE_OPEN_BUTTON_ID;
    button.textContent = 'Ya instalé Lórren · abrir app';

    const closeButton = actions.querySelector('#dismiss-worker-portal-install');
    if (closeButton) actions.insertBefore(button, closeButton);
    else actions.appendChild(button);
    return button;
  }

  function prepareInstallButtons() {
    if (!isAndroid()) return;
    if (shouldTransferInstallToChrome()) {
      for (const id of INSTALL_BUTTON_IDS) {
        const button = document.getElementById(id);
        if (!button) continue;
        button.disabled = false;
        if (!isNativeAndroidApp() && button.textContent !== 'Abrir en Chrome y descargar') {
          button.textContent = 'Abrir en Chrome y descargar';
        }
        button.dataset.installAction = 'session-handoff-chrome';
      }
    }
    const nativeButton = ensureNativeOpenButton();
    if (nativeButton) nativeButton.dataset.installAction = 'session-handoff-native';
  }

  function mutationAddsInstallButton(mutation) {
    return [...mutation.addedNodes].some((node) => {
      if (!(node instanceof Element)) return false;
      if (INSTALL_BUTTON_IDS.has(node.id) || node.id === NATIVE_OPEN_BUTTON_ID) return true;
      return [...node.querySelectorAll('button')].some((button) => (
        INSTALL_BUTTON_IDS.has(button.id) || button.id === NATIVE_OPEN_BUTTON_ID
      ));
    });
  }

  async function createSessionHandoff() {
    const response = await fetch(CREATE_HANDOFF_PATH, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'worker-portal'
      },
      body: '{}'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true || typeof payload.handoffToken !== 'string') {
      throw new Error(payload?.error || 'worker_portal_handoff_failed');
    }
    return payload.handoffToken;
  }

  function continueUrl(handoffToken) {
    const target = new URL(CONTINUE_HANDOFF_PATH, window.location.origin);
    target.searchParams.set('transferencia', handoffToken);
    return target;
  }

  function chromeIntentUrl(handoffToken) {
    const target = continueUrl(handoffToken);
    const scheme = target.protocol.replace(':', '');
    return `intent://${target.host}${target.pathname}${target.search}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(target.toString())};end`;
  }

  function nativeDeepLink(handoffToken) {
    return `lorren://portal/transferencia?transferencia=${encodeURIComponent(handoffToken)}`;
  }

  function restoreButton(button, originalText) {
    handoffInProgress = false;
    if (!button?.isConnected) return;
    button.disabled = false;
    button.textContent = originalText || (button.id === NATIVE_OPEN_BUTTON_ID
      ? 'Ya instalé Lórren · abrir app'
      : 'Descargar app');
  }

  async function handleInstallClick(event) {
    if (!isAndroid()) return;
    const button = buttonFromEvent(event);
    if (!button) return;

    const opensNative = button.id === NATIVE_OPEN_BUTTON_ID;
    const transfersToChrome = !opensNative
      && shouldTransferInstallToChrome()
      && INSTALL_BUTTON_IDS.has(button.id);
    if (!opensNative && !transfersToChrome) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (handoffInProgress) return;

    handoffInProgress = true;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Preparando aplicación…';
    setStatus(opensNative
      ? 'Transfiriendo tu sesión de forma temporal a la app Lórren.'
      : 'Asegurando que Chrome conserve tu sesión para descargar la app.');

    try {
      const handoffToken = await createSessionHandoff();
      if (opensNative) {
        button.textContent = 'Abriendo Lórren…';
        setStatus('Android abrirá Lórren y el servidor rotará la sesión al entrar.');
        window.location.href = nativeDeepLink(handoffToken);
        window.setTimeout(() => {
          if (document.visibilityState === 'visible') {
            restoreButton(button, originalText);
            setStatus('Si Lórren no se abrió, comprueba que el APK haya terminado de instalarse.', true);
          }
        }, 2_500);
        return;
      }

      button.textContent = 'Abriendo Chrome…';
      setStatus('Chrome abrirá el Portal con una sesión rotada y continuará la descarga privada.');
      window.location.href = chromeIntentUrl(handoffToken);
    } catch {
      restoreButton(button, originalText);
      setStatus('No fue posible preparar la sesión de la aplicación. Recarga el portal e intenta nuevamente.', true);
    }
  }

  if (!isAndroid()) return;

  document.addEventListener('click', handleInstallClick, true);
  const observer = new MutationObserver((mutations) => {
    if (mutations.some(mutationAddsInstallButton)) prepareInstallButtons();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  prepareInstallButtons();
})();