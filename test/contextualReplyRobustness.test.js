import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextualReply,
  buildSafeContextualFallbackText,
  shouldEscalateHumanReview
} from '../src/services/contextualReply.js';

const invalidContexts = [null, false, 0, 'texto', []];

test('fallback contextual tolera entradas nulas y primitivas', () => {
  for (const value of invalidContexts) {
    assert.doesNotThrow(() => buildSafeContextualFallbackText(value));
    assert.match(buildSafeContextualFallbackText(value), /recibí tu mensaje/i);
  }
});

test('buildContextualReply tolera entradas nulas y primitivas sin llamar al modelo', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    for (const value of invalidContexts) {
      const result = await buildContextualReply(value);
      assert.equal(result.fallbackUsed, true);
      assert.equal(result.reason, 'openai_disabled');
      assert.match(result.text, /recibí tu mensaje/i);
    }
  } finally {
    if (previousKey) process.env.OPENAI_API_KEY = previousKey;
  }
});

test('escalamiento tolera opciones inválidas y conserva resultado seguro', () => {
  for (const value of invalidContexts) {
    assert.equal(shouldEscalateHumanReview(value), false);
  }
});

test('campos llamados como propiedades del prototipo se tratan como texto y no como funciones', () => {
  for (const field of ['constructor', 'toString', 'valueOf']) {
    const text = buildSafeContextualFallbackText({
      situation: 'request_missing_data',
      missingFields: [field]
    });

    assert.equal(typeof text, 'string');
    assert.match(text, new RegExp(field, 'i'));
  }
});
