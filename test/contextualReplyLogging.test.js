import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { buildContextualReply } from '../src/services/contextualReply.js';

test('un fallo de OpenAI registra diagnóstico limitado sin exponer credenciales', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const originalPost = axios.post;
  const originalError = console.error;
  const logs = [];

  process.env.OPENAI_API_KEY = 'api-key-production-secret';
  axios.post = async () => {
    const error = new Error('request failed access_token=meta-secret authorization=Bearer-secret');
    error.code = 'ERR_BAD_REQUEST';
    error.response = { status: 401, config: { headers: { Authorization: 'Bearer api-key-production-secret' } } };
    error.stack = `Error: Bearer api-key-production-secret\n${'x'.repeat(900)}`;
    throw error;
  };
  console.error = (...args) => logs.push(args);

  try {
    const result = await buildContextualReply({ situation: 'attachment_unreadable' });

    assert.equal(result.fallbackUsed, true);
    assert.equal(result.reason, 'responses_error');
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], '[CONTEXTUAL_REPLY_ERROR]');

    const serialized = JSON.stringify(logs[0][1]);
    assert.doesNotMatch(serialized, /meta-secret|api-key-production-secret|Bearer-secret/);
    assert.match(serialized, /REDACTED/);
    assert.ok(String(logs[0][1].stack || '').length <= 500);
    assert.equal(logs[0][1].status, 401);
    assert.equal(logs[0][1].code, 'ERR_BAD_REQUEST');
  } finally {
    axios.post = originalPost;
    console.error = originalError;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});
