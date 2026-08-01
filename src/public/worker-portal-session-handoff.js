'use strict';

(() => {
  const PORTAL_PATH = '/operaciones/portal';
  const CREATE_HANDOFF_PATH = `${PORTAL_PATH}/sesion-transferencia/crear`;
  const CONTINUE_HANDOFF_PATH = `${PORTAL_PATH}/sesion-transferencia/continuar`;
  const INSTALL_BUTTON_IDS = new Set([
    'open-worker-portal-install',
    'install-worker-portal'
  ]);

  let handoffInProgress = false;

  function userAgent() {
    return String(window.navigator.userAgent || '');
  }

  function isAndroidInAppBrowser() {
    return /Android/i.test(userAgent())
      && /WhatsApp|FBAN|FBAV|Instagram|Line\/|wv\)/i.test(userAgent());
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
    status.textContent = message;
  }

  function prepareInAppInstallButtons() {
    if (!isAndroidInAppBrowser()) return;
    for (const id of INSTALL_BUTTON_IDS) {
      const button = document.getElementById(id);
      if (!button) continue;
      button.disabled = false;
      button.textContent = 'Abrir en Chrome y descargar';
      button.dataset.installAction = 'session-handoff';
    }
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

  function chromeIntentUrl(handoffToken) {
    const target = new URL(CONTINUE_HANDOFF_PATH, window.location.origin);
    target.searchParams.set('transferencia', handoffToken);
    const scheme = target.protocol.replace(':', '');
    return `intent://${target.host}${target.pathname}${target.search}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(target.toString())};end`;
  }

  async function handleInstallClick(event) {
    if (!isAndroidInAppBrowser()) return;
    const button = installButtonFromEvent(event);
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (handoffInProgress) return;

    handoffInProgress = true;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Transfiriendo sesión…';
    setStatus('Preparando el acceso seguro en Chrome.');

    try {
      const handoffToken = await createSessionHandoff();
      button.textContent = 'Abriendo Chrome…';
      setStatus('Chrome abrirá el portal con tu sesión activa.');
      window.location.href = chromeIntentUrl(handoffToken);
    } catch {
      handoffInProgress = false;
      button.disabled = false;
      button.textContent = originalText || 'Abrir en Chrome y descargar';
      setStatus('No fue posible transferir la sesión. Recarga el portal e intenta nuevamente.', true);
    }
  }

  if (!isAndroidInAppBrowser()) return;

  document.addEventListener('click', handleInstallClick, true);
  const observer = new MutationObserver(prepareInAppInstallButtons);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  prepareInAppInstallButtons();
})();
