import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  ReplySimilarityThreshold,
  isRepeatedPurposeOrAction,
  isSubstantiallySimilarReply,
  normalizeReplySignature,
  replyTokenCount,
  tokenOverlapRatio
} from '../src/services/replySimilarityPolicy.js';
import { buildContextualReply } from '../src/services/contextualReply.js';

test('replySimilarityPolicy centraliza normalización, conteo y overlap base', () => {
  assert.equal(normalizeReplySignature('Envíame tu HV, por favor.'), 'enviame tu hv por favor');
  assert.equal(replyTokenCount('Sí, correcto'), 2);
  assert.equal(tokenOverlapRatio('Para continuar necesito tu documento', 'Necesito tu documento para continuar'), 1);
});

test('replySimilarityPolicy conserva decisiones base: repetición exacta, overlap alto y fallback', () => {
  assert.equal(isSubstantiallySimilarReply('Correcto', 'Correcto', { threshold: ReplySimilarityThreshold.LOOP_GUARD }), true);
  assert.equal(
    isSubstantiallySimilarReply(
      'Para continuar necesito tu número de documento completo',
      'Necesito tu número de documento completo para continuar',
      { threshold: ReplySimilarityThreshold.LOOP_GUARD }
    ),
    true
  );
  assert.equal(
    isSubstantiallySimilarReply(
      'Gracias por escribir, seguimos con tu postulación',
      'La entrevista está registrada para mañana en la sede indicada',
      { threshold: ReplySimilarityThreshold.LOOP_GUARD }
    ),
    false
  );
});

test('replySimilarityPolicy no marca replies cortos como repetidos salvo igualdad exacta', () => {
  assert.equal(isSubstantiallySimilarReply('Sí correcto', 'Correcto sí'), false);
  assert.equal(isSubstantiallySimilarReply('Correcto', 'Correcto'), true);
});

test('replySimilarityPolicy usa propósito o acción cuando existe aunque el overlap sea bajo', () => {
  assert.equal(
    isSubstantiallySimilarReply(
      'Compárteme tu hoja de vida en formato PDF o Word para continuar con tu postulación.',
      'Necesito adjuntar tu currículum en archivo PDF o Word antes de continuar.',
      { threshold: ReplySimilarityThreshold.LOOP_GUARD }
    ),
    false
  );

  assert.equal(
    isRepeatedPurposeOrAction(
      { raw: { responsePurpose: 'request_cv', actions: [{ type: 'request_cv' }] } },
      { rawPayload: { responsePurpose: 'request_cv', actions: [{ type: 'request_cv' }] } }
    ),
    true
  );
});

function withAxiosMock(handler, fn) {
  const original = axios.post.bind(axios);
  axios.post = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      axios.post = original;
    });
}

test('contextualReply conserva repeat guard exacto y usa el fallback explícito del turno', async () => {
  process.env.OPENAI_API_KEY = 'test-key';

  await withAxiosMock(async () => ({
    data: { output: [{ content: [{ parsed: { reply: 'Correcto', escalateHuman: false, reason: 'ok' } }] }] }
  }), async () => {
    const exact = await buildContextualReply({
      situation: 'continue_flow',
      recentMessages: [{ body: 'Correcto' }],
      fallbackText: 'Seguimos con tu proceso.'
    });
    assert.equal(exact.fallbackUsed, true);
    assert.equal(exact.reason, 'repeat_guard');
    assert.equal(exact.text, 'Seguimos con tu proceso.');
  });

  await withAxiosMock(async () => ({
    data: { output: [{ content: [{ parsed: { reply: 'Sí correcto', escalateHuman: false, reason: 'ok' } }] }] }
  }), async () => {
    const shortSimilar = await buildContextualReply({
      situation: 'continue_flow',
      recentMessages: [{ body: 'Correcto sí' }]
    });
    assert.equal(shortSimilar.fallbackUsed, false);
    assert.equal(shortSimilar.text, 'Sí correcto');
  });

  delete process.env.OPENAI_API_KEY;
});

test('mismo outbound con replies de longitudes distintas no cambia inconsistente la decisión corta del guard', () => {
  const previous = 'Correcto sí';
  assert.equal(isSubstantiallySimilarReply('Sí correcto', previous), false);
  assert.equal(isSubstantiallySimilarReply('Sí correcto gracias', previous), false);
});
