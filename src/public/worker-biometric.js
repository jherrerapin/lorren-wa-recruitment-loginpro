'use strict';

const BIOMETRIC_ASSET_RELEASE = '20260803-worker-portal-filters-v4';
const BIOMETRIC_SHELL_CACHE = 'lorren-worker-portal-shell-v9';
const BIOMETRIC_SHELL_RELOAD_KEY = `lorren-shell-reloaded:${BIOMETRIC_SHELL_CACHE}`;
const WORKER_PORTAL_USER_AGENT = String(window.navigator.userAgent || '');
const LOAD_WORKER_PORTAL_HANDOFF = /Android/i.test(WORKER_PORTAL_USER_AGENT);

window.LorrenBiometricAssetRelease = BIOMETRIC_ASSET_RELEASE;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const message = event?.data;
    if (
      message?.type !== 'PORTAL_SHELL_UPDATED'
      || message?.cacheName !== BIOMETRIC_SHELL_CACHE
      || window.sessionStorage.getItem(BIOMETRIC_SHELL_RELOAD_KEY) === 'true'
    ) return;

    window.sessionStorage.setItem(BIOMETRIC_SHELL_RELOAD_KEY, 'true');
    window.location.reload();
  });

  navigator.serviceWorker.getRegistration('/operaciones/portal')
    .then((registration) => registration?.update?.())
    .catch(() => {});
}

document.write(`<script src="/public/worker-biometric-core.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-biometric-mobile.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-portal-biometric-flow.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
// Este runtime contiene la presentación vigente del portal: agrupación y filtros por fecha/estado.
// Se carga desde /public para evitar que una copia histórica de /operaciones/portal/offline.js oculte los filtros.
document.write(`<script src="/public/worker-portal-offline.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-portal-offline-v2.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
document.write(`<script src="/public/worker-portal-offline-controller.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
if (LOAD_WORKER_PORTAL_HANDOFF) {
  document.write(`<script src="/public/worker-portal-session-handoff.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
}
document.write(`<script src="/public/worker-portal-install.js?v=${BIOMETRIC_ASSET_RELEASE}"><\/script>`);
