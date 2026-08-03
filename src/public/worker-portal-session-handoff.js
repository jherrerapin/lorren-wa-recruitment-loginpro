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

  let handoffInProgress = false;

  function userAgent() {
    return String(window.navigator.userAgent || '');
  }

  function isAndroid() {
    return /Android/i.test(userAgent());
  }

  function isAndroidInAppBrowser() {
    return isAndroid()
      && /WhatsApp|FBAN|FBAV|Instagram|Line\/|wv\)/i.test(userAgent());
  }

  function handoffAlreadyCompleted() {
    return new URL(window.location.href).searchParams.get(INSTALL_QUERY_PARAM) === '1';
  }

  function installButtonFromEvent(event) {
    const element = event.target instanceof Element
      ? event.target.closest('button')
      : null;
    return element && INSTALL_BUTTON_IDS.has(element.id) ? element : null;
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

  function prepareInstallButtons() {
    if (!isAndroid() || handoffAlreadyCompleted()) return;
    const inAppBrowser = isAndroidInAppBrowser();
    for (const id of INSTALL_BUTTON_IDS) {
      const button = document.getElementById(id);
      if (!button) continue;
      if (button.disabled) button.disabled = false;
      if (inAppBrowser && button.textContent !== 'Abrir en Chrome y descargar') {
        button.textContent = 'Abrir en Chrome y descargar';
      }
      if (button.dataset.installAction !== 'session-handoff') {
        button.dataset.installAction = 'session-handoff';
      }
    }
  }

  function mutationAddsInstallButton(mutation) {
    return [...mutation.addedNodes].some((node) => {
      if (!(node instanceof Element)) return false;
      if (INSTALL_BUTTON_IDS.has(node.id)) return true;
      return [...node.querySelectorAll('button')].some((button) => INSTALL_BUTTON_IDS.has(button.id));
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

  async function handleInstallClick(event) {
    if (!isAndroid() || handoffAlreadyCompleted()) return;
    const button = installButtonFromEvent(event);
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (handoffInProgress) return;

    handoffInProgress = true;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Preparando aplicación…';
    setStatus('Asegurando que la aplicación conserve tu sesión activa.');

    try {
      const handoffToken = await createSessionHandoff();
      if (isAndroidInAppBrowser()) {
        button.textContent = 'Abriendo Chrome…';
        setStatus('Chrome abrirá el portal con tu sesión activa.');
        window.location.href = chromeIntentUrl(handoffToken);
        return;
      }
      button.textContent = 'Continuando…';
      setStatus('La descarga continuará con la sesión preparada.');
      window.location.href = continueUrl(handoffToken).toString();
    } catch {
      handoffInProgress = false;
      button.disabled = false;
      button.textContent = originalText || (isAndroidInAppBrowser()
        ? 'Abrir en Chrome y descargar'
        : 'Descargar app');
      setStatus('No fue posible preparar la sesión de la aplicación. Recarga el portal e intenta nuevamente.', true);
    }
  }

  if (!isAndroid() || handoffAlreadyCompleted()) return;

  document.addEventListener('click', handleInstallClick, true);
  const observer = new MutationObserver((mutations) => {
    if (mutations.some(mutationAddsInstallButton)) prepareInstallButtons();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  prepareInstallButtons();
})();
