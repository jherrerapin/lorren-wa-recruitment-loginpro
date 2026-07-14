import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  buildContextualReply,
  buildSafeContextualFallbackText,
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

test('foto de HV usa respuesta determinística sin llamar IA', async () => {
  process.env.OPENAI_API_KEY = 'test-key';

  await withAxiosMock(async () => {
    throw new Error('no debe llamar IA para attachment_resume_photo');
  }, async () => {
    const result = await buildContextualReply({
      situation: 'attachment_resume_photo',
      inboundText: '¿el proceso sigue? te mandé foto de mi hoja de vida',
      recentMessages: [{ body: 'Compárteme tu hoja de vida en PDF o DOCX.' }]
    });
    assert.equal(result.usedModel, false);
    assert.match(result.text, /PDF|DOCX/i);
    assert.match(result.text, /no puedo registrarla/i);
  });

  delete process.env.OPENAI_API_KEY;
});

test('si el modelo falla, el fallback describe el problema real del archivo', async () => {
  process.env.OPENAI_API_KEY = 'test-key';

  await withAxiosMock(async () => {
    throw new Error('network timeout');
  }, async () => {
    const result = await buildContextualReply({
      situation: 'attachment_unreadable',
      recentMessages: []
    });
    assert.equal(result.fallbackUsed, true);
    assert.match(result.text, /no pude procesar/i);
    assert.match(result.text, /PDF|DOCX/i);
    assert.doesNotMatch(result.text, /ya te respondo|seguimos con lo puntual|dato puntual/i);
  });

  delete process.env.OPENAI_API_KEY;
});

test('fallback de dato pendiente menciona los campos reales y no una frase vacía', () => {
  const text = buildSafeContextualFallbackText({
    situation: 'request_missing_data',
    missingFields: ['documentType', 'neighborhood']
  });

  assert.match(text, /document type/i);
  assert.match(text, /neighborhood/i);
  assert.doesNotMatch(text, /dato puntual|vamos bien|seguimos/i);
});

test('fallback de HV válida reconoce el archivo y conserva lo pendiente', () => {
  const text = buildSafeContextualFallbackText({
    situation: 'attachment_cv_valid',
    missingFields: ['experienceSummary']
  });

  assert.match(text, /hoja de vida/i);
  assert.match(text, /asociada a tu registro/i);
  assert.match(text, /experience summary/i);
});

test('fallback explícito definido por la política del turno tiene prioridad', () => {
  const text = buildSafeContextualFallbackText({
    situation: 'continue_flow',
    fallbackText: 'La vacante está inactiva, pero puedo explicarte sus requisitos registrados.'
  });

  assert.equal(text, 'La vacante está inactiva, pero puedo explicarte sus requisitos registrados.');
});

test('contextual reply envía solo datos de vacante asignada incluyendo documentación de entrevista saneada', async () => {
  process.env.OPENAI_API_KEY = 'test-key';

  await withAxiosMock(async (_url, payload) => {
    const raw = payload?.input?.[1]?.content?.[0]?.text || '{}';
    const parsed = JSON.parse(raw);
    assert.equal(parsed.vacancy.title, 'Auxiliar logístico');
    assert.equal(parsed.vacancy.conditions, 'Turnos rotativos registrados');
    assert.match(parsed.vacancy.interviewDocumentation, /hoja de vida Minerva 1003 o impresa, como la tenga, y cédula original/i);
    assert.doesNotMatch(parsed.vacancy.interviewDocumentation, /PDF|DOCX/i);
    return {
      data: {
        output: [{ content: [{ parsed: { reply: 'La documentación registrada es hoja de vida Minerva 1003 o impresa, como la tenga, y cédula original.', escalateHuman: false, reason: 'ok' } }] }]
      }
    };
  }, async () => {
    const result = await buildContextualReply({
      situation: 'continue_flow',
      inboundText: '¿qué documentos llevo?',
      vacancy: {
        title: 'Auxiliar logístico',
        conditions: 'Turnos rotativos registrados',
        requiredDocuments: 'Traer hoja de vida Minerva 1003 o impresa, como la tenga, y cédula original.'
      },
      recentMessages: []
    });
    assert.equal(result.usedModel, true);
  });

  delete process.env.OPENAI_API_KEY;
});

test('si hay baja confianza real, se marca escalamiento humano', () => {
  const escalate = shouldEscalateHumanReview({
    attachmentAnalysis: { classification: 'UNREADABLE', confidence: 0.1 }
  });
  assert.equal(escalate, true);
});

test('contextual reply prompt identifica a Lórren como reclutadora de LoginPro Service y limita datos de vacante', async () => {
  process.env.OPENAI_API_KEY = 'test-key';

  await withAxiosMock(async (_url, payload) => {
    const systemText = payload?.input?.[0]?.content?.[0]?.text || '';
    assert.match(systemText, /Lórren, reclutadora de LoginPro Service/i);
    assert.match(systemText, /usa exclusivamente la vacante asignada/i);
    assert.match(systemText, /Si el dato no esta en esa vacante, di que no lo tienes registrado/i);
    return {
      data: {
        output: [{ content: [{ parsed: { reply: 'No tengo ese dato registrado en la vacante.', escalateHuman: false, reason: 'ok' } }] }]
      }
    };
  }, async () => {
    const result = await buildContextualReply({
      situation: 'continue_flow',
      inboundText: '¿qué beneficios tiene?',
      vacancy: { title: 'Auxiliar logístico' },
      recentMessages: []
    });
    assert.equal(result.usedModel, true);
  });

  delete process.env.OPENAI_API_KEY;
});
