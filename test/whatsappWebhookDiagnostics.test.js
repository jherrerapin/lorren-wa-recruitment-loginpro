import assert from 'node:assert/strict';
import test from 'node:test';
import { collectWhatsappWebhookDiagnostics } from '../src/services/whatsappWebhookDiagnostics.js';

test('diagnóstico de webhook expone solo phone_number_id y wamid de mensajes entrantes', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '123456789' },
              contacts: [{ wa_id: '573001234567' }],
              messages: [
                {
                  id: 'wamid.TEST123',
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
