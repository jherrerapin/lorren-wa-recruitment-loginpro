import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  sendMessage,
  WhatsAppDeliveryError
} from '../src/infrastructure/transport/whatsappClient.js';

async function withWhatsAppEnvironment(run) {
  const previousUrl = process.env.WHATSAPP_API_URL;
  const previousToken = process.env.WHATSAPP_TOKEN;
  const previousPost = axios.post;

  try {
    process.env.WHATSAPP_API_URL = 'https://graph.facebook.com/v23.0/phone-id/messages';
    process.env.WHATSAPP_TOKEN = 'test-secret-token';
    await run();
  } finally {
    axios.post = previousPost;
    if (previousUrl === undefined) delete process.env.WHATSAPP_API_URL;
    else process.env.WHATSAPP_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = previousToken;
  }
}

test('envía un payload text cuando no hay opciones interactivas', async () => {
  await withWhatsAppEnvironment(async () => {
    let request = null;
    axios.post = async (...args) => {
      request = args;
      return { data: { messages: [{ id: 'wamid.outbound-1' }] } };
    };

    const result = await sendMessage('573001112233', 'Hola, continuemos.');

    assert.deepEqual(result, { messages: [{ id: 'wamid.outbound-1' }] });
    assert.equal(request[0], process.env.WHATSAPP_API_URL);
    assert.deepEqual(request[1], {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '573001112233',
      type: 'text',
      text: {
        preview_url: false,
        body: 'Hola, continuemos.'
      }
    });
    assert.equal(request[2].headers.Authorization, 'Bearer test-secret-token');
    assert.equal(request[2].timeout, 15000);
  });
});

test('envía hasta tres opciones como botones reply interactivos', async () => {
  await withWhatsAppEnvironment(async () => {
    let payload = null;
    axios.post = async (_url, body) => {
      payload = body;
      return { data: { messages: [{ id: 'wamid.outbound-2' }] } };
    };

    await sendMessage('573001112233', '¿Estás de acuerdo?', [
      { id: 'pool:accept', label: 'Sí, de acuerdo' },
      { id: 'pool:reject', label: 'No, gracias' }
    ]);

    assert.deepEqual(payload, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '573001112233',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '¿Estás de acuerdo?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'pool:accept', title: 'Sí, de acuerdo' } },
            { type: 'reply', reply: { id: 'pool:reject', title: 'No, gracias' } }
          ]
        }
      }
    });
  });
});

test('rechaza más de tres botones antes de llamar a Meta', async () => {
  await withWhatsAppEnvironment(async () => {
    let called = false;
    axios.post = async () => {
      called = true;
    };

    await assert.rejects(
      sendMessage('573001112233', 'Selecciona', [
        { id: '1', label: 'Uno' },
        { id: '2', label: 'Dos' },
        { id: '3', label: 'Tres' },
        { id: '4', label: 'Cuatro' }
      ]),
      (error) => error instanceof WhatsAppDeliveryError
        && /more than 3 buttons/.test(error.message)
    );
    assert.equal(called, false);
  });
});

test('rechaza botones duplicados o títulos que exceden el límite', async () => {
  await withWhatsAppEnvironment(async () => {
    await assert.rejects(
      sendMessage('573001112233', 'Selecciona', [
        { id: 'same', label: 'Uno' },
        { id: 'same', label: 'Dos' }
      ]),
      WhatsAppDeliveryError
    );
    await assert.rejects(
      sendMessage('573001112233', 'Selecciona', [
        { id: 'long', label: 'Este título supera veinte caracteres' }
      ]),
      WhatsAppDeliveryError
    );
  });
});

test('convierte errores HTTP de Meta en WhatsAppDeliveryError descriptivo', async () => {
  await withWhatsAppEnvironment(async () => {
    axios.post = async () => {
      const error = new Error('Request failed');
      error.response = {
        status: 400,
        data: { error: { code: 131009, message: 'Invalid parameter' } }
      };
      error.config = { headers: { Authorization: 'Bearer test-secret-token' } };
      throw error;
    };

    await assert.rejects(
      sendMessage('573001112233', 'Hola'),
      (error) => error instanceof WhatsAppDeliveryError
        && error.status === 400
        && error.providerCode === 131009
        && /HTTP 400/.test(error.message)
        && !error.message.includes('test-secret-token')
    );
  });
});

test('reporta configuración faltante sin intentar la petición', async () => {
  await withWhatsAppEnvironment(async () => {
    delete process.env.WHATSAPP_TOKEN;
    let called = false;
    axios.post = async () => {
      called = true;
    };

    await assert.rejects(
      sendMessage('573001112233', 'Hola'),
      (error) => error instanceof WhatsAppDeliveryError
        && /WHATSAPP_TOKEN/.test(error.message)
    );
    assert.equal(called, false);
  });
});
