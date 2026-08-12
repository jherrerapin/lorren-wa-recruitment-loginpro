import assert from 'node:assert/strict';
import test from 'node:test';
import { collectWhatsappWebhookDiagnostics, logWhatsappWebhookDiagnostics } from '../src/services/whatsappWebhookDiagnostics.js';
import { extractMessages } from '../src/services/whatsapp.js';

function messagePayload(phoneNumberId = '123456789', wamid = 'wamid.TEST123') {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: '573001234567' }],
              messages: [
                {
                  id: wamid,
                  from: '573001234567',
                  type: 'text',
                  text: { body: 'contenido privado' }
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

test('diagnóstico de webhook expone solo phone_number_id y wamid de mensajes entrantes', () => {
  const payload = messagePayload();

  assert.deepEqual(collectWhatsappWebhookDiagnostics(payload), [
    {
      phone_number_id: '123456789',
      wamid: 'wamid.TEST123'
    }
  ]);
});

test('diagnóstico ignora notificaciones de estado sin messages', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '123456789' },
              statuses: [{ id: 'wamid.STATUS123', status: 'delivered' }]
            }
          }
        ]
      }
    ]
  };

  assert.deepEqual(collectWhatsappWebhookDiagnostics(payload), []);
});

test('diagnóstico soporta múltiples entries y changes sin incluir contenido ni remitente', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '111' },
              messages: [{ id: 'wamid.ONE', from: 'secret-1', text: { body: 'secret text 1' } }]
            }
          },
          {
            value: {
              metadata: { phone_number_id: '222' },
              messages: [{ id: 'wamid.TWO', from: 'secret-2', text: { body: 'secret text 2' } }]
            }
          }
        ]
      }
    ]
  };

  const result = collectWhatsappWebhookDiagnostics(payload);
  assert.deepEqual(result, [
    { phone_number_id: '111', wamid: 'wamid.ONE' },
    { phone_number_id: '222', wamid: 'wamid.TWO' }
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret|text/);
});

test('diagnóstico se imprime una sola vez por endpoint para el mismo payload', () => {
  const payload = messagePayload();
  const originalInfo = console.info;
  const lines = [];
  console.info = (...args) => lines.push(args.join(' '));
  try {
    logWhatsappWebhookDiagnostics(payload, '/webhook');
    logWhatsappWebhookDiagnostics(payload, '/webhook');
  } finally {
    console.info = originalInfo;
  }
  assert.equal(lines.filter((line) => line.includes('[WA_WEBHOOK_DIAG]')).length, 1);
});

test('reclutamiento ignora un mensaje destinado a otro phone_number_id', () => {
  const previous = process.env.META_PHONE_NUMBER_ID;
  process.env.META_PHONE_NUMBER_ID = 'recruitment-id';
  const originalInfo = console.info;
  console.info = () => {};
  try {
    assert.deepEqual(extractMessages(messagePayload('dispatch-id', 'wamid.DISPATCH')), []);
  } finally {
    console.info = originalInfo;
    if (previous === undefined) delete process.env.META_PHONE_NUMBER_ID;
    else process.env.META_PHONE_NUMBER_ID = previous;
  }
});

test('reclutamiento conserva mensajes de su propio phone_number_id', () => {
  const previous = process.env.META_PHONE_NUMBER_ID;
  process.env.META_PHONE_NUMBER_ID = 'recruitment-id';
  const originalInfo = console.info;
  console.info = () => {};
  try {
    const messages = extractMessages(messagePayload('recruitment-id', 'wamid.RECRUITMENT'));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 'wamid.RECRUITMENT');
  } finally {
    console.info = originalInfo;
    if (previous === undefined) delete process.env.META_PHONE_NUMBER_ID;
    else process.env.META_PHONE_NUMBER_ID = previous;
  }
});
