import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const viewUrl = new URL('../src/views/workerPortal.ejs', import.meta.url);
const onlineFlowUrl = new URL('../src/public/worker-portal-biometric-flow.js', import.meta.url);
const offlineFlowUrl = new URL('../src/public/worker-portal-offline-controller.js', import.meta.url);
const serviceWorkerUrl = new URL('../src/public/worker-portal-sw.js', import.meta.url);

async function source(url) {
  return readFile(url, 'utf8');
}

function noticeRuntime(viewSource) {
  const start = viewSource.indexOf('// arrival-time-notice:begin');
  const end = viewSource.indexOf('// arrival-time-notice:end');
  assert.ok(start >= 0 && end > start, 'debe existir la autoridad de presentación del aviso horario');
  return viewSource.slice(start, end);
}

function timingFormatter(runtime) {
  const start = runtime.indexOf('function arrivalTimingMessage(expectedStartAt, arrivalReportedAt)');
  const end = runtime.indexOf('window.LorrenArrivalTimingNotice', start);
  assert.ok(start >= 0 && end > start, 'debe poder aislarse el formateador compartido');
  const functionSource = runtime.slice(start, end).trim();
  return Function(`"use strict"; ${functionSource}; return arrivalTimingMessage;`)();
}

test('el aviso conserva el texto aprobado para antes, después y singular', async () => {
  const format = timingFormatter(noticeRuntime(await source(viewUrl)));
  const expected = '2026-08-28T13:00:00.000Z';

  assert.equal(
    format(expected, '2026-08-28T12:42:00.000Z'),
    'Tu marcación de entrada quedó registrada. Llegaste 18 minutos antes de la hora programada.'
  );
  assert.equal(
    format(expected, '2026-08-28T13:12:00.000Z'),
    'Tu marcación de entrada quedó registrada. Llegaste 12 minutos después de la hora programada.'
  );
  assert.equal(
    format(expected, '2026-08-28T12:59:00.000Z'),
    'Tu marcación de entrada quedó registrada. Llegaste 1 minuto antes de la hora programada.'
  );
  assert.equal(
    format(expected, '2026-08-28T13:01:00.000Z'),
    'Tu marcación de entrada quedó registrada. Llegaste 1 minuto después de la hora programada.'
  );
  assert.equal(format(expected, '2026-08-28T12:59:01.000Z'), '');
  assert.equal(format(expected, '2026-08-28T13:00:59.000Z'), '');
  assert.equal(format(expected, expected), '');
});

test('la vista solo publica el formateador y ya no reconstruye la marcación con storage o fetch', async () => {
  const runtime = noticeRuntime(await source(viewUrl));

  assert.match(runtime, /window\.LorrenArrivalTimingNotice\s*=\s*Object\.freeze/);
  assert.match(runtime, /message:\s*arrivalTimingMessage/);
  assert.doesNotMatch(runtime, /window\.fetch\s*=/);
  assert.doesNotMatch(runtime, /localStorage|sessionStorage/);
  assert.doesNotMatch(runtime, /STORAGE_KEY|CONFIRMED_NOTICE_KEY|resolvePendingArrivalNotices/);
  assert.doesNotMatch(runtime, /\b(?:window\.)?alert\s*\(|\b(?:window\.)?confirm\s*\(|\b(?:window\.)?prompt\s*\(/);
});

test('online muestra el aviso desde la respuesta persistida antes de recargar', async () => {
  const flow = await source(onlineFlowUrl);

  assert.match(flow, /const arrivalTimingNotice = window\.LorrenArrivalTimingNotice \|\| null/);
  assert.match(flow, /payload\?\.recorded !== true \|\| payload\?\.markType !== 'ARRIVAL'/);
  assert.match(flow, /arrivalTimingNotice\?\.message\?\.\(payload\.expectedStartAt, payload\.arrivalReportedAt\)/);
  assert.match(flow, /const timingMessage = confirmedArrivalTimingMessage\(payload\)/);
  assert.match(flow, /setStatus\(timingMessage \|\| payload\.message \|\| 'Marcación registrada\.', 'ok'\)/);
  assert.match(flow, /window\.setTimeout\(\(\) => window\.location\.reload\(\), timingMessage \? 7800 : 900\)/);
  assert.doesNotMatch(flow, /lorren-arrival-time-notice-confirmed|lorren-arrival-time-notice-pending/);
});

test('offline calcula el mismo aviso con el horario cacheado y la hora capturada localmente', async () => {
  const flow = await source(offlineFlowUrl);

  assert.match(flow, /const arrivalTimingNotice = window\.LorrenArrivalTimingNotice \|\| null/);
  assert.match(flow, /dataset\?\.expectedStartAt/);
  assert.match(flow, /arrivalTimingNotice\?\.message\?\.\(expectedStartAt, record\.clientCapturedAt\)/);
  assert.match(flow, /const timingMessage = offlineArrivalTimingMessage\(record\)/);
  assert.match(flow, /Quedó guardada en este teléfono y se sincronizará automáticamente cuando vuelva la conexión\./);
  assert.match(flow, /window\.setTimeout\(closeOfflineDialog, timingMessage \? 7800 : 1100\)/);
  assert.doesNotMatch(flow, /sessionStorage/);
});

test('la sincronización posterior no contiene una segunda autoridad de aviso horario', async () => {
  const [view, onlineFlow, offlineFlow] = await Promise.all([
    source(viewUrl),
    source(onlineFlowUrl),
    source(offlineFlowUrl)
  ]);

  const approvedPrefix = 'Tu marcación de entrada quedó registrada. Llegaste';
  assert.equal(view.split(approvedPrefix).length - 1, 1);
  assert.equal(onlineFlow.split(approvedPrefix).length - 1, 0);
  assert.equal(offlineFlow.split(approvedPrefix).length - 1, 0);
  assert.doesNotMatch(view, /ARRIVAL_SYNCED/);
});

test('el PWA instalado recibe una nueva generación de shell sin reinstalación', async () => {
  const serviceWorker = await source(serviceWorkerUrl);

  assert.match(serviceWorker, /CACHE_NAME\s*=\s*'lorren-worker-portal-shell-v17'/);
  assert.match(serviceWorker, /self\.skipWaiting\(\)/);
  assert.match(serviceWorker, /self\.clients\.claim\(\)/);
  assert.match(serviceWorker, /notifyClients\(\{ type: 'PORTAL_SHELL_UPDATED', cacheName: CACHE_NAME \}\)/);
  assert.match(serviceWorker, /name !== CACHE_NAME/);
});
