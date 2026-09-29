import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  parseWebhookPayload,
  verifySignature
} from '../src/infrastructure/transport/metaAdapter.js';

function signatureFor(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function webhookWithMessage(message) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'business-account-1',
      changes: [{
        field: 'messages',
        value: { messages: [message] }
      }]
    }]
  };
}

test('valida una firma HMAC SHA256 calculada sobre los bytes originales', () => {
  const rawBody = Buffer.from('{"object":"whatsapp_business_account"}', 'utf8');
  const secret = 'meta-app-secret';
  const signature = signatureFor(rawBody, secret);

  assert.equal(verifySignature(rawBody, signature, secret), true);
  assert.equal(verifySignature(rawBody.toString('utf8'), signature, secret), true);
  assert.equal(verifySignature(new Uint8Array(rawBody), signature, secret), true);
});

test('rechaza cuerpos alterados, secretos incorrectos y encabezados malformados', () => {
  const rawBody = Buffer.from('{"message":"Hola"}', 'utf8');
  const signature = signatureFor(rawBody, 'correct-secret');

  assert.equal(verifySignature(Buffer.from('{"message":"Adiós"}'), signature, 'correct-secret'), false);
  assert.equal(verifySignature(rawBody, signature, 'wrong-secret'), false);
  assert.equal(verifySignature(rawBody, 'sha256=1234', 'correct-secret'), false);
  assert.equal(verifySignature(rawBody, null, 'correct-secret'), false);
  assert.equal(verifySignature({}, signature, 'correct-secret'), false);
});

test('aplana un mensaje de texto y normaliza su timestamp', () => {
  const result = parseWebhookPayload(webhookWithMessage({
    id: 'wamid.text-1',
    from: '573001112233',
    timestamp: '1727100000',
    type: 'text',
    text: { body: '  Hola Lórren  ' }
  }));

  assert.deepEqual(result, {
    messageId: 'wamid.text-1',
    from: '573001112233',
    timestamp: new Date(1727100000 * 1000).toISOString(),
    type: 'text',
    text: 'Hola Lórren',
    payload: null
  });
});

test('normaliza respuestas interactivas de botones y listas', () => {
  const button = parseWebhookPayload(webhookWithMessage({
    id: 'wamid.button-1',
    from: '573001112233',
    timestamp: '1727100000',
    type: 'interactive',
    interactive: {
      type: 'button_reply',
      button_reply: { id: 'pool_consent:accept', title: 'Sí, de acuerdo' }
    }
  }));
  const list = parseWebhookPayload(webhookWithMessage({
    id: 'wamid.list-1',
    from: '573001112233',
    timestamp: '1727100000',
    type: 'interactive',
    interactive: {
      type: 'list_reply',
      list_reply: { id: 'vacancy:42', title: 'Auxiliar de bodega' }
    }
  }));

  assert.equal(button.type, 'interactive');
  assert.equal(button.text, 'Sí, de acuerdo');
  assert.equal(button.payload, 'pool_consent:accept');
  assert.equal(list.text, 'Auxiliar de bodega');
  assert.equal(list.payload, 'vacancy:42');
});

test('normaliza el formato button heredado de Meta', () => {
  const result = parseWebhookPayload(webhookWithMessage({
    id: 'wamid.legacy-button',
    from: '573001112233',
    type: 'button',
    button: { text: 'Sí autorizo', payload: 'consent:accept' }
  }));

  assert.deepEqual(result, {
    messageId: 'wamid.legacy-button',
    from: '573001112233',
    timestamp: null,
    type: 'interactive',
    text: 'Sí autorizo',
    payload: 'consent:accept'
  });
});

test('ignora estados de entrega, tipos no accionables y estructuras inválidas', () => {
  const statusPayload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.status', status: 'read' }] } }] }]
  };
  const imagePayload = webhookWithMessage({
    id: 'wamid.image',
    from: '573001112233',
    type: 'image',
    image: { id: 'media-1' }
  });

  assert.equal(parseWebhookPayload(statusPayload), null);
  assert.equal(parseWebhookPayload(imagePayload), null);
  assert.equal(parseWebhookPayload({ object: 'unexpected', entry: [] }), null);
  assert.equal(parseWebhookPayload(null), null);
});

test('recorre múltiples cambios hasta encontrar el primer mensaje accionable', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      { changes: [{ value: { statuses: [{ status: 'delivered' }] } }] },
      {
        changes: [{
          value: {
            messages: [
              { id: 'ignored-image', from: '1', type: 'image', image: { id: 'media' } },
              { id: 'actionable-text', from: '2', type: 'text', text: { body: 'Hola' } }
            ]
          }
        }]
      }
    ]
  };

  assert.equal(parseWebhookPayload(payload)?.messageId, 'actionable-text');
});
