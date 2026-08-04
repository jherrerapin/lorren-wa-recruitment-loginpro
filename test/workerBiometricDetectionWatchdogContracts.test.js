import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const mobile = read('src/public/worker-biometric-mobile.js');
const flow = read('src/public/worker-portal-biometric-flow.js');
const view = read('src/views/workerPortal.ejs');
const loader = read('src/public/worker-biometric.js');
const serviceWorker = read('src/public/worker-portal-sw.js');

test('cada inferencia facial tiene watchdog y no puede bloquear la marcación indefinidamente', () => {
  assert.match(mobile, /const DETECTION_TIMEOUT_MS = 8_000/);
  assert.match(mobile, /withTimeout\([\s\S]*human\.detect\(video\)[\s\S]*DETECTION_TIMEOUT_MS[\s\S]*biometric_detection_timeout/);
  assert.match(mobile, /invalidateRuntime\(code === 'biometric_detection_timeout' \? 'detect-timeout' : 'detect-failed'\)/);
  assert.match(flow, /'biometric_detection_timeout'/);
  assert.match(flow, /El análisis facial se demoró demasiado y fue reiniciado/);
});

test('la interfaz muestra una sola instrucción amplia y mantiene el progreso accesible', () => {
  assert.match(view, /\.mark-status \{[^}]*min-height:\s*110px/);
  assert.match(view, /#biometric-instruction \{ display: none; \}/);
  assert.match(view, /id="biometric-instruction"[^>]*hidden[^>]*aria-hidden="true"/);
  assert.match(view, /id="mark-result"[^>]*aria-live="assertive"/);
  assert.match(flow, /setInstruction\('Abriendo cámara y preparando el análisis facial…'\)/);
  assert.match(mobile, /Analizando tu rostro\. Mantén la posición dentro del marco\./);
});

test('la aplicación instalada recibe el motor y la caché corregidos', () => {
  assert.match(loader, /20260804-worker-portal-biometric-v8/);
  assert.match(serviceWorker, /lorren-worker-portal-shell-v14/);
  assert.match(view, /worker-biometric\.js\?v=20260804-worker-portal-biometric-v8/);
});
