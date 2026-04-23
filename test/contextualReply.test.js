import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  buildContextualReply,
  deriveAttachmentDecision,
  shouldEscalateHumanReview
} from '../src/services/contextualReply.js';

function withAxiosMock(handler, fn) {
  const original = axios.post.bind(axios);
  axios.post = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      axios.post = original;
    });
}

test('foto de HV no se guarda como HV final y pide PDF/DOCX con situación AI-first', () => {
  const decision = deriveAttachmentDecision('CV_IMAGE_ONLY');
  assert.equal(decision.saveCv, false);
  assert.equal(decision.situation, 'attachment_resume_photo');
  assert.equal(decision.fallbackIntent, 'request_cv_pdf_word');
});

test('cédula no se guarda como HV y mantiene situación contextual de documento de identidad', () => {
  const decision = deriveAttachmentDecision('ID_DOC');
  assert.equal(decision.saveCv, false);
  assert.equal(decision.situation, 'attachment_id_doc');
  assert.equal(decision.fallbackIntent, 'attachment_id_doc');
});

test('certificado u otro documento no se guarda como HV', () => {
  const decision = deriveAttachmentDecision('OTHER');
  assert.equal(decision.saveCv, false);
  assert.equal(decision.situation, 'attachment_other_doc');
});

test('archivo ilegible solicita reenvío vía situación contextual', () => {
  const decision = deriveAttachmentDecision('UNREADABLE');
  assert.equal(decision.saveCv, false);
  assert.equal(decision.situation, 'attachment_unreadable');
});

test('dos adjuntos seguidos generan respuestas distintas cuando el modelo entrega variantes', async () => {
  process.env.OPENAI_API_KEY = 'test-key';

  await withAxiosMock(async (_url, payload) => {
    const raw = payload?.input?.[1]?.content?.[0]?.text || '{}';
    const parsed = JSON.parse(raw);
    const reply = parsed.situation === 'attachment_id_doc'
      ? 'Gracias por el documento de identidad. Para seguir, compárteme tu hoja de vida en PDF o DOCX.'
      : 'Recibí el archivo. ¿Me lo envías nuevamente en PDF o DOCX para revisarlo bien?';

    return {
      data: {
        output: [{ content: [{ parsed: { reply, escalateHuman: false, reason: 'ok' } }] }]
      }
    };
  }, async () => {
    const first = await buildContextualReply({
      situation: 'attachment_id_doc',
      inboundText: 'te envio mi cedula',
      recentMessages: []
    });
    const second = await buildContextualReply({
      situation: 'attachment_unreadable',
      inboundText: 'no abre el archivo?',
      recentMessages: [{ body: first.text }]
    });

    assert.notEqual(first.text, second.text);
  });

  delete process.env.OPENAI_API_KEY;
});

test('pregunta + adjunto responde natural con foco en la situación', async () => {
  process.env.OPENAI_API_KEY = 'test-key';

  await withAxiosMock(async () => ({
    data: {
      output: [{ content: [{ parsed: { reply: 'Sí, el proceso sigue activo. Además, el archivo llegó como foto; envíame la HV en PDF o DOCX.', escalateHuman: false, reason: 'answered_then_continue' } }] }]
    }
  }), async () => {
    const result = await buildContextualReply({
      situation: 'attachment_resume_photo',
      inboundText: '¿el proceso sigue? te mandé foto de mi hoja de vida',
      recentMessages: [{ body: 'Compárteme tu hoja de vida en PDF o DOCX.' }]
    });
    assert.match(result.text, /proceso sigue activo/i);
    assert.match(result.text, /PDF|DOCX/i);
  });

  delete process.env.OPENAI_API_KEY;
});

test('si el modelo falla, responsePolicy actúa como fallback', async () => {
  process.env.OPENAI_API_KEY = 'test-key';

  await withAxiosMock(async () => {
    throw new Error('network timeout');
  }, async () => {
    const result = await buildContextualReply({
      situation: 'attachment_unreadable',
      recentMessages: []
    });
    assert.equal(result.fallbackUsed, true);
    assert.match(result.text, /PDF|DOCX/i);
  });

  delete process.env.OPENAI_API_KEY;
});

test('si hay baja confianza real, se marca escalamiento humano', () => {
  const escalate = shouldEscalateHumanReview({
    attachmentAnalysis: { classification: 'UNREADABLE', confidence: 0.1 }
  });
  assert.equal(escalate, true);
});
