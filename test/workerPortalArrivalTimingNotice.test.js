import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const viewUrl = new URL('../src/views/workerPortal.ejs', import.meta.url);

async function portalViewSource() {
  return readFile(viewUrl, 'utf8');
}

function noticeRuntime(source) {
  const start = source.indexOf('// arrival-time-notice:begin');
  const end = source.indexOf('// arrival-time-notice:end');
  assert.ok(start >= 0 && end > start, 'debe existir el runtime canónico del aviso de entrada');
  return source.slice(start, end);
}

function timingFormatter(runtime) {
  const start = runtime.indexOf('function arrivalTimingMessage(expectedStartAt, arrivalReportedAt)');
  const end = runtime.indexOf('function showArrivalNotices', start);
  assert.ok(start >= 0 && end > start, 'debe poder aislarse el formateador real del aviso');
  const functionSource = runtime.slice(start, end).trim();
  return Function(`"use strict"; ${functionSource}; return arrivalTimingMessage;`)();
}

test('el aviso de entrada usa el texto aprobado para minutos antes y después', async () => {
  const source = await portalViewSource();
  const format = timingFormatter(noticeRuntime(source));
  const expected = '2026-08-28T12:00:00.000Z';

  assert.equal(
    format(expected, '2026-08-28T11:42:00.000Z'),
    'Tu marcación de entrada quedó registrada. Llegaste 18 minutos antes de la hora programada.'
  );
  assert.equal(
    format(expected, '2026-08-28T12:12:00.000Z'),
    'Tu marcación de entrada quedó registrada. Llegaste 12 minutos después de la hora programada.'
  );
  assert.equal(
    format(expected, '2026-08-28T11:59:00.000Z'),
    'Tu marcación de entrada quedó registrada. Llegaste 1 minuto antes de la hora programada.'
  );
  assert.equal(
    format(expected, '2026-08-28T12:01:00.000Z'),
    'Tu marcación de entrada quedó registrada. Llegaste 1 minuto después de la hora programada.'
  );

  assert.equal(format(expected, '2026-08-28T11:59:01.000Z'), '');
  assert.equal(format(expected, '2026-08-28T12:00:59.000Z'), '');
  assert.equal(format(expected, expected), '');
});

test('el aviso no usa texto descartado y depende de tiempos persistidos por la proyección del Portal', async () => {
  const source = await portalViewSource();
  const runtime = noticeRuntime(source);

  assert.match(source, /data-expected-start-at="<%= assignment\.expectedStartAt \|\| '' %>"/);
  assert.match(source, /data-arrival-reported-at="<%= assignment\.arrivalReportedAt \|\| '' %>"/);
  assert.match(runtime, /card\.dataset\.expectedStartAt/);
  assert.match(runtime, /card\.dataset\.arrivalReportedAt/);
  assert.doesNotMatch(runtime, /correctamente|gracias/i);
});

test('PWA y WebView Android reciben el mismo aviso no bloqueante sin ampliar diálogos nativos', async () => {
  const source = await portalViewSource();
  const runtime = noticeRuntime(source);
  const loaderIndex = source.indexOf('/public/worker-biometric.js');
  const noticeIndex = source.indexOf('// arrival-time-notice:begin');

  assert.ok(loaderIndex > noticeIndex, 'el listener debe instalarse antes del flujo compartido PWA/Android');
  assert.match(source, /id="arrival-time-toast" class="async-toast" role="status" aria-live="polite"/);
  assert.match(runtime, /window\.localStorage/);
  assert.match(runtime, /document\.addEventListener\('pointerdown', rememberArrivalIntent, true\)/);
  assert.doesNotMatch(runtime, /\b(?:window\.)?alert\s*\(/);
  assert.doesNotMatch(runtime, /\b(?:window\.)?confirm\s*\(/);
  assert.doesNotMatch(runtime, /\b(?:window\.)?prompt\s*\(/);
});
