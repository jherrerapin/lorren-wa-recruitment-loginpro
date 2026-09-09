import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  loadDispatchWhatsappPhoneConversation,
  recordDispatchWhatsappMessageAudit,
  recordDispatchWhatsappProviderStatusAudit
} from '../src/services/dispatchWhatsappMonitor.js';
import { processDispatchWhatsappProviderStatus } from '../src/services/dispatchWhatsappWebhookService.js';

const testPhone = `57${'3'}${'0'.repeat(9)}`;
const testWamid = 'wamid.TEST-DISPATCH-STATUS';

function outboundAuditRow(metadata = {}) {
  return {
    id: 'audit-test-1',
    entityType: 'DISPATCH_WHATSAPP_MESSAGE',
    entityId: `dispatch-wa:outbound:${testWamid}`,
    entityLabel: testPhone,
    action: 'DISPATCH_WHATSAPP_OUTBOUND',
    createdAt: new Date('2026-09-08T23:30:00.000Z'),
    metadata: {
      scope: 'operational',
      direction: 'OUTBOUND',
      phone: testPhone,
      body: 'Mensaje operativo de prueba.',
      messageType: 'TEXT',
      messageId: '',
      providerMessageId: testWamid,
      source: 'TEST_OUTBOUND',
      occurredAt: '2026-09-08T23:30:00.000Z',
      providerStatus: 'ACCEPTED',
      providerStatusAt: '2026-09-08T23:30:00.000Z',
      providerDiagnostic: null,
      ...metadata
    }
  };
}

test('outbound auditado distingue aceptación inicial de entrega real', async () => {
  let created = null;
  const prismaClient = {
    devAuditEvent: {
      findFirst: async () => null,
      create: async ({ data }) => { created = data; return data; }
    }
  };

  const result = await recordDispatchWhatsappMessageAudit({
    prismaClient,
    scope: 'operational',
    direction: 'OUTBOUND',
    phone: testPhone,
    body: 'Mensaje operativo de prueba.',
    messageType: 'TEXT',
    providerMessageId: testWamid,
    source: 'TEST_OUTBOUND',
    occurredAt: new Date('2026-09-08T23:30:00.000Z')
  });

  assert.equal(result.recorded, true);
  assert.equal(created.metadata.providerStatus, 'ACCEPTED');
  assert.equal(created.metadata.providerDiagnostic, null);
});

test('FAILED de Meta actualiza la misma auditoría y sanitiza el diagnóstico', async () => {
  const longRecipient = '9'.repeat(12);
  let updated = null;
  const row = outboundAuditRow();
  const prismaClient = {
    devAuditEvent: {
      findFirst: async () => row,
      update: async ({ data }) => { updated = data; return { ...row, ...data }; }
    }
  };

  const result = await recordDispatchWhatsappProviderStatusAudit({
    prismaClient,
    scope: 'operational',
    providerMessageId: testWamid,
    providerStatus: 'FAILED',
    statusPayload: {
      id: testWamid,
      status: 'failed',
      timestamp: '1788910800',
      errors: [{
        code: 131026,
        title: 'Message undeliverable',
        message: `Bearer TEST_SECRET recipient=${longRecipient}`,
        error_data: { details: 'Delivery failed after initial acceptance.' }
      }]
    }
  });

  assert.equal(result.recorded, true);
  assert.equal(updated.metadata.providerStatus, 'FAILED');
  assert.match(updated.metadata.providerDiagnostic, /code=131026/);
  assert.match(updated.metadata.providerDiagnostic, /Message undeliverable/);
  assert.doesNotMatch(updated.metadata.providerDiagnostic, /TEST_SECRET/);
  assert.doesNotMatch(updated.metadata.providerDiagnostic, new RegExp(longRecipient));
});

test('monitor DEV muestra el estado FAILED y su causa sanitizada en la conversación', async () => {
  const row = outboundAuditRow({
    providerStatus: 'FAILED',
    providerStatusAt: '2026-09-08T23:31:00.000Z',
    providerDiagnostic: 'code=131026 title=Message undeliverable'
  });
  const prismaClient = {
    dispatchWhatsappContactWindow: { findUnique: async () => null },
    dispatchWhatsappConfirmation: { findMany: async () => [] },
    devAuditEvent: { findMany: async () => [row] }
  };

  const conversation = await loadDispatchWhatsappPhoneConversation({ prismaClient, phone: testPhone });
  assert.equal(conversation.messageHistory.length, 1);
  assert.equal(conversation.messageHistory[0].providerStatus, 'FAILED');
  assert.match(conversation.messageHistory[0].body, /\[Meta: FAILED\]/);
  assert.match(conversation.messageHistory[0].body, /code=131026/);
});

test('callback de un outbound auditado se procesa aunque no exista DispatchWhatsappConfirmation', async () => {
  const row = outboundAuditRow();
  let updated = null;
  const prismaClient = {
    devAuditEvent: {
      findFirst: async () => row,
      update: async ({ data }) => { updated = data; return { ...row, ...data }; }
    },
    dispatchWhatsappConfirmation: {
      findFirst: async () => null
    }
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await processDispatchWhatsappProviderStatus({
      scope: 'operational',
      prismaClient,
      status: {
        id: testWamid,
        status: 'failed',
        errors: [{ code: 131026, title: 'Message undeliverable' }]
      }
    });
    assert.equal(result.handled, true);
    assert.equal(result.linkUpdated, false);
    assert.equal(result.auditUpdated, true);
    assert.equal(updated.metadata.providerStatus, 'FAILED');
  } finally {
    console.warn = originalWarn;
  }
});

test('alerta de novedad conserva wamid y la observabilidad técnica sigue restringida al monitor DEV', () => {
  const adminAlerts = fs.readFileSync(new URL('../src/services/dispatchWhatsappAdminAlerts.js', import.meta.url), 'utf8');
  const webhook = fs.readFileSync(new URL('../src/services/dispatchWhatsappWebhookService.js', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/dispatchWhatsappNotifications.js', import.meta.url), 'utf8');

  assert.match(adminAlerts, /return \{ sent: true, userId: user\.id, phone, providerMessageId \}/);
  assert.match(webhook, /source: 'NOVELTY_ADMIN_ALERT'/);
  assert.match(webhook, /recordDispatchWhatsappProviderStatusAudit/);
  assert.match(route, /router\.get\('\/monitor', requireDevMonitor/);
  assert.match(route, /if \(!isDev\)[\s\S]*lastError: publicLastError/);
});
