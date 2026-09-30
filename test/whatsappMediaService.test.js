import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadWhatsappMedia } from '../src/infrastructure/transport/whatsappMediaService.js';

test('descarga media con META_ACCESS_TOKEN y META_API_VERSION cuando faltan variables WHATSAPP', async () => {
  const keys = ['WHATSAPP_TOKEN', 'WHATSAPP_GRAPH_API_VERSION', 'META_ACCESS_TOKEN', 'META_API_VERSION'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_GRAPH_API_VERSION;
    process.env.META_ACCESS_TOKEN = 'meta-token';
    process.env.META_API_VERSION = 'v23.0';
    const requests = [];
    const httpClient = {
      async get(url, options) {
        requests.push({ url, options });
        return requests.length === 1
          ? { data: { url: 'https://lookaside.fbsbx.com/media-file' } }
          : { data: Buffer.from('document-bytes') };
      }
    };

    const buffer = await downloadWhatsappMedia('media-123', { httpClient });
    assert.equal(buffer.toString(), 'document-bytes');
    assert.equal(requests[0].url, 'https://graph.facebook.com/v23.0/media-123');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer meta-token');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer meta-token');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
