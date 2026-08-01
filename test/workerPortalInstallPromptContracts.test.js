import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loaderSource = fs.readFileSync(new URL('../src/public/worker-biometric.js', import.meta.url), 'utf8');
const installSource = fs.readFileSync(new URL('../src/public/worker-portal-install.js', import.meta.url), 'utf8');
const serviceWorkerSource = fs.readFileSync(new URL('../src/public/worker-portal-sw.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../src/public/worker-portal.webmanifest', import.meta.url), 'utf8'));


test('el cargador incluye el flujo de instalación con una versión nueva', () => {
  assert.match(loaderSource, /worker-portal-install\.js/);
  assert.match(loaderSource, /20260801-install-button-cache-v2/);
});


test('el portal muestra un acceso de instalación aunque el rostro ya estuviera registrado', () => {
  assert.match(installSource, /portal-install-cta/);
  assert.match(installSource, /open-worker-portal-install/);
  assert.match(installSource, /Instalar portal/);
  assert.match(installSource, /buildPersistentCta\(\)/);
  assert.match(installSource, /insertAdjacentElement\('afterend', cta\)/);
});


test('la oferta automática sigue apareciendo después de confirmar el registro facial', () => {
  assert.match(installSource, /rostro\\s\+registrado/i);
  assert.match(installSource, /MutationObserver/);
  assert.match(installSource, /classList\?\.contains\('ok'\)/);
  assert.match(installSource, /scheduleInstallOffer/);
  assert.match(installSource, /lorren:face-enrolled/);
});


test('Android usa el diálogo nativo iniciado por el usuario cuando está disponible', () => {
  assert.match(installSource, /beforeinstallprompt/);
  assert.match(installSource, /event\.preventDefault\(\)/);
  assert.match(installSource, /promptEvent\.prompt\(\)/);
  assert.match(installSource, /promptEvent\.userChoice/);
  assert.match(installSource, /Instalar Portal del Auxiliar/);
});


test('iPhone y navegadores internos reciben instrucciones manuales', () => {
  assert.match(installSource, /iPad\|iPhone\|iPod/);
  assert.match(installSource, /WhatsApp\|FBAN\|FBAV\|Instagram/);
  assert.match(installSource, /Agregar a pantalla de inicio/);
  assert.match(installSource, /Abrir en Chrome/);
  assert.match(installSource, /Abrir en Safari/);
});


test('la instalación no se ofrece dentro de la app ya instalada', () => {
  assert.match(installSource, /display-mode: standalone/);
  assert.match(installSource, /navigator\.standalone/);
  assert.match(installSource, /appinstalled/);
  assert.match(installSource, /removeInstallUi/);
});


test('el service worker elimina la caché antigua y conserva el módulo de instalación', () => {
  assert.match(serviceWorkerSource, /lorren-worker-portal-shell-v8/);
  assert.match(serviceWorkerSource, /'\/public\/worker-portal-install\.js'/);
  assert.match(serviceWorkerSource, /NETWORK_FIRST_ASSETS/);
  assert.match(serviceWorkerSource, /networkFirstStatic/);
  assert.match(serviceWorkerSource, /cache: 'no-store'/);
  assert.match(serviceWorkerSource, /PORTAL_SHELL_UPDATED/);
});


test('la ruta admite el portal con o sin barra final', () => {
  assert.match(installSource, /window\.location\.pathname\.replace\(\/\\\/\+\$\//);
  assert.match(installSource, /normalizedPath !== '\/operaciones\/portal'/);
});


test('el manifiesto mantiene el portal como PWA independiente', () => {
  assert.equal(manifest.id, '/operaciones/portal');
  assert.equal(manifest.start_url, '/operaciones/portal');
  assert.equal(manifest.scope, '/operaciones/portal');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  assert.ok(Array.isArray(manifest.icons));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
});
