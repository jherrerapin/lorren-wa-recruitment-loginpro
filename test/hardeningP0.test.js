import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSafeContextualFallbackText } from '../src/services/contextualReply.js';

test('fallback de archivo no válido explica el hecho y la acción necesaria', () => {
  const reply = buildSafeContextualFallbackText({ situation: 'attachment_other_doc' });

  assert.match(reply, /no corresponde a una hoja de vida/i);
  assert.match(reply, /PDF|DOCX/i);
  assert.doesNotMatch(reply, /perfecto|vamos bien|seguimos con lo puntual/i);
});
