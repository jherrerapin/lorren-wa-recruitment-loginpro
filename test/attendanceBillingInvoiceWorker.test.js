import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runAttendanceBillingInvoiceSweep } from '../src/workers/attendanceBillingInvoiceWorker.js';

const source = fs.readFileSync(new URL('../src/workers/attendanceBillingInvoiceWorker.js', import.meta.url), 'utf8');

test('el worker conserva una autoridad de barrido exportada', () => {
  assert.equal(typeof runAttendanceBillingInvoiceSweep, 'function');
});

test('la facturación no usa la línea operativa de Despacho', () => {
  assert.doesNotMatch(source, /dispatchWhatsappCloudClient/);
  assert.doesNotMatch(source, /sendDispatchWhatsappTextMessage/);
  assert.match(source, /deliverCybionixAttendanceApproval/);
  assert.match(source, /deliverCybionixAccountCharge/);
});

test('si el supervisor ya rechazó no se reenvía la solicitud de aprobación', () => {
  assert.match(source, /approvalState\.status !== 'REJECTED'/);
});
