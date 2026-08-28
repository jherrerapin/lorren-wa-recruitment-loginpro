import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import express from 'express';
import {
  WORKER_PORTAL_INSTALLATION_COOKIE_NAME,
  workerPortalRouter
} from '../src/routes/workerPortal.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';

const viewUrl = new URL('../src/views/workerPortal.ejs', import.meta.url);
const SESSION_TOKEN = 'N'.repeat(43);
const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174010';
const EXPECTED_START_AT = '2026-08-28T13:00:00.000Z';
const ARRIVAL_REPORTED_AT = '2026-08-28T12:42:00.000Z';

async function portalViewSource() {
  return readFile(viewUrl, 'utf8');
}

function noticeRuntime(source) {
  const start = source.indexOf('// arrival-time-notice:begin');
  const end = source.indexOf('// arrival-time-notice:end');
  assert.ok(start >= 0 && end > start, 'debe existir el runtime canónico del aviso de entrada');
  return source.slice(start, end);
}

function noticeFormatters(runtime) {
  const start = runtime.indexOf('function arrivalTimingMessage(expectedStartAt, arrivalReportedAt)');
  const end = runtime.indexOf('function saveConfirmedArrivalNotice', start);
  assert.ok(start >= 0 && end > start, 'deben poder aislarse los formateadores reales del aviso');
  const functionSource = runtime.slice(start, end).trim();
  return Function(`"use strict"; ${functionSource}; return { arrivalTimingMessage, confirmedArrivalMessage };`)();
}

async function withArrivalServer(callback) {
  const app = express();
  app.use('/operaciones/portal', workerPortalRouter({}, {
    repository: {},
    installationPepper: 'p'.repeat(32),
    nowFn: () => new Date(ARRIVAL_REPORTED_AT),
    nonceBytesFn: (size) => Buffer.alloc(size, 7),
    resolveSessionFn: async () => ({
      workerId: 'worker-notice-test',
      deviceId: 'device-notice-test',
      sessionId: 'session-notice-test',
      expiresAt: new Date('2027-08-28T12:42:00.000Z')
    }),
    loadAssignmentsFn: async () => [],
    loadAssignmentForArrivalFn: async () => ({
      id: 'assignment-notice-test',
      attendanceEnabled: true,
      arrivalReported: false,
      canRegisterArrival: true,
      photoRequired: false
    }),
    storeArrivalEvidenceFn: async () => ({ storageKey: null, mimeType: null, created: false }),
    registerArrivalFn: async () => ({
      recorded: true,
      replayed: false,
      attendanceSession: {
        expectedStartAt: new Date(EXPECTED_START_AT),
        arrivalReportedAt: new Date(ARRIVAL_REPORTED_AT)
      },
      validation: {
        validationStatus: 'AUTO_VALIDATED',
        attendanceStatus: 'ON_TIME',
        reportedPunctuality: 'ON_TIME',
        riskFlags: []
      }
    })
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ ok: false, error: error.message }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function arrivalForm() {
  const form = new FormData();
  form.set('idempotencyKey', 'arrival_notice_test_123456');
  form.set('latitude', '4.7111');
  form.set('longitude', '-74.0721');
  form.set('accuracyMeters', '12');
  form.set('clientCapturedAt', '2026-08-28T12:41:54.000Z');
  form.set('captureMode', 'ONLINE_WEB');
  form.set('photoConsent', 'false');
  return form;
}

function cookieHeader() {
  return `${WORKER_PORTAL_SESSION_COOKIE_NAME}=${SESSION_TOKEN}; ${WORKER_PORTAL_INSTALLATION_COOKIE_NAME}=${INSTALLATION_ID}`;
}

test('el resultado exitoso de ARRIVAL expone las horas persistidas que alimentan el aviso', async () => {
  await withArrivalServer(async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/assignment-notice-test/llegada`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader(),
        'X-Requested-With': 'worker-portal'
      },
      body: arrivalForm()
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.markType, 'ARRIVAL');
    assert.equal(payload.recorded, true);
    assert.equal(payload.expectedStartAt, EXPECTED_START_AT);
    assert.equal(payload.arrivalReportedAt, ARRIVAL_REPORTED_AT);
    assert.notEqual(payload.arrivalReportedAt, '2026-08-28T12:41:54.000Z');
  });
});

test('el aviso usa el texto aprobado para minutos antes y después', async () => {
  const source = await portalViewSource();
  const { arrivalTimingMessage: format } = noticeFormatters(noticeRuntime(source));
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

test('solo una respuesta exitosa y realmente registrada produce el mensaje confirmado', async () => {
  const source = await portalViewSource();
  const { confirmedArrivalMessage } = noticeFormatters(noticeRuntime(source));
  const valid = {
    ok: true,
    recorded: true,
    markType: 'ARRIVAL',
    expectedStartAt: EXPECTED_START_AT,
    arrivalReportedAt: ARRIVAL_REPORTED_AT
  };

  assert.equal(
    confirmedArrivalMessage(valid),
    'Tu marcación de entrada quedó registrada. Llegaste 18 minutos antes de la hora programada.'
  );
  assert.equal(confirmedArrivalMessage({ ...valid, ok: false }), '');
  assert.equal(confirmedArrivalMessage({ ...valid, recorded: false }), '');
  assert.equal(confirmedArrivalMessage({ ...valid, markType: 'DEPARTURE' }), '');
  assert.equal(confirmedArrivalMessage({ ...valid, arrivalReportedAt: EXPECTED_START_AT }), '');
});

test('online usa la respuesta confirmada y deja la heurística anterior solo como fallback', async () => {
  const source = await portalViewSource();
  const runtime = noticeRuntime(source);
  const loaderIndex = source.indexOf('/public/worker-biometric.js');
  const noticeIndex = source.indexOf('// arrival-time-notice:begin');

  assert.ok(loaderIndex > noticeIndex, 'el observador debe instalarse antes del flujo compartido PWA/Android');
  assert.match(source, /id="arrival-time-toast" class="async-toast" role="status" aria-live="polite"/);
  assert.match(runtime, /window\.fetch = async \(\.\.\.args\)/);
  assert.match(runtime, /response\.clone\(\)\.json\(\)/);
  assert.match(runtime, /payload\?\.ok !== true \|\| payload\?\.recorded !== true \|\| payload\?\.markType !== 'ARRIVAL'/);
  assert.match(runtime, /removePendingArrival\(assignmentId\)/);
  assert.match(runtime, /window\.sessionStorage\.setItem\(CONFIRMED_NOTICE_KEY, message\)/);
  assert.match(runtime, /consumeConfirmedArrivalNotice\(\)/);
  assert.match(runtime, /window\.localStorage/);
  assert.match(runtime, /resolvePendingArrivalNotices\(\)/);
  assert.doesNotMatch(runtime, /\b(?:window\.)?alert\s*\(/);
  assert.doesNotMatch(runtime, /\b(?:window\.)?confirm\s*\(/);
  assert.doesNotMatch(runtime, /\b(?:window\.)?prompt\s*\(/);
});
