import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAttachment } from '../src/services/attachmentAnalyzer.js';
import { buildSafeContextualFallbackText } from '../src/services/contextualReply.js';
import { looksLikeCvFilenameText } from '../src/services/cvFlow.js';
import { sanitizeRequiredDocumentsForBot, generateInterviewOffer, generateBookingConfirmation, preserveConfiguredInterviewDocuments } from '../src/services/naturalReply.js';
import { CV_UNSAFE_FALLBACK_REPLY, sanitizeOutboundReply } from '../src/services/replySafety.js';
import { buildVacancyStateForModel } from '../src/services/conversationEngine.js';

function assertNoForbiddenHvTerms(reply) {
  assert.doesNotMatch(reply, /foto/i);
  assert.doesNotMatch(reply, /impresa/i);
  assert.doesNotMatch(reply, /como la tengas?/i);
  assert.doesNotMatch(reply, /minerva\s*1003/i);
}

test('fallbacks críticos piden HV solo como archivo PDF o DOCX', () => {
  for (const situation of ['attachment_resume_photo', 'attachment_other_doc', 'attachment_unreadable', 'attachment_id_doc']) {
    const text = buildSafeContextualFallbackText({ situation });
    assert.match(text, /PDF o DOCX/i);
    assertNoForbiddenHvTerms(text);
  }
});

test('image/jpeg no cuenta como CV válido y pide reenviar en PDF o DOCX', async () => {
  const analysis = await analyzeAttachment({ buffer: Buffer.from('fake image bytes'), mimeType: 'image/jpeg', filename: 'hv.jpg' });
  const saveCv = analysis.classification === 'CV_VALID';
  const hasCv = saveCv;
  const reply = buildSafeContextualFallbackText({ situation: 'attachment_resume_photo' });

  assert.equal(saveCv, false);
  assert.equal(hasCv, false);
  assert.equal(analysis.classification, 'CV_IMAGE_ONLY');
  assert.match(reply, /PDF o DOCX/i);
  assertNoForbiddenHvTerms(reply);
});

test('texto con nombre de archivo no cuenta como HV adjunta', () => {
  const input = 'hoja de vida minerva 1003.pdf';
  assert.equal(looksLikeCvFilenameText(input), true);
  const candidatePatch = {};
  assert.equal(candidatePatch.cvStorageKey, undefined);
  assert.equal(candidatePatch.cvData, undefined);
  assert.equal(candidatePatch.hasCv, undefined);
  const reply = 'Para registrar tu hoja de vida necesito que adjuntes el archivo real en PDF o Word/DOCX; escribir solo el nombre del archivo no es suficiente.';
  assert.match(reply, /archivo real en PDF o Word\/DOCX/i);
});

test('documentos de entrevista salen de la información de la vacante sin forzar PDF/DOCX', async () => {
  const requiredDocuments = 'Traer hoja de vida Minerva 1003 o impresa, como la tenga, y cédula original.';
  const sanitized = sanitizeRequiredDocumentsForBot(requiredDocuments);
  assert.match(sanitized, /hoja de vida Minerva 1003 o impresa, como la tenga, y cédula original/i);
  assert.doesNotMatch(sanitized, /PDF|DOCX/i);

  const reply = await generateInterviewOffer({
    formattedDate: 'jueves 14 de mayo a las 9:00 a. m.',
    vacancy: { requiredDocuments },
    candidateName: 'Ana Perez'
  });
  assert.match(reply, /Para la entrevista, lleva hoja de vida Minerva 1003 o impresa, como la tenga, y cédula original/i);
  assert.doesNotMatch(reply, /configurad/i);
  assert.doesNotMatch(reply, /PDF|DOCX/i);

  const confirmation = await generateBookingConfirmation({
    formattedDate: 'jueves 14 de mayo a las 9:00 a. m.',
    vacancy: { requiredDocuments },
    candidateName: 'Ana Perez'
  });
  assert.match(confirmation, /Para la entrevista, lleva hoja de vida Minerva 1003 o impresa, como la tenga, y cédula original/i);
  assert.doesNotMatch(confirmation, /configurad/i);
  assert.doesNotMatch(confirmation, /PDF|DOCX/i);
});

test('caso Alfonso usa documentos de la vacante, no formato de carga de HV', async () => {
  const reply = await generateInterviewOffer({
    formattedDate: 'sábado 16 de mayo a las 10:00 a. m.',
    vacancy: { requiredDocuments: 'Hoja de vida\nCédula original' },
    candidateName: 'Alfonso Perez'
  });

  assert.match(reply, /Para la entrevista, lleva Hoja de vida y Cédula original/i);
  assert.doesNotMatch(reply, /configurad/i);
  assert.doesNotMatch(reply, /PDF|DOCX/i);
});

test('naturalReply no usa fullName pendiente o rechazado como nombre en respuestas contextuales', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const reply = await generateInterviewOffer({
    formattedDate: 'jueves 14 de mayo a las 9:00 a. m.',
    vacancy: { requiredDocuments: 'Traer hoja de vida Minerva 1003 o impresa, como la tenga, y cédula original.' },
    candidate: { fullName: 'Buenas Tardes', missingFields: ['fullName'] }
  });

  assert.doesNotMatch(reply, /Buenas Tardes/i);
  assert.doesNotMatch(reply, /PDF|DOCX/i);

  if (previousKey) process.env.OPENAI_API_KEY = previousKey;
});

test('si la IA intenta agregar PDF/DOCX en documentación de entrevista, se restaura lo indicado en la vacante', () => {
  const reply = preserveConfiguredInterviewDocuments(
    'Alfonso, te compartimos entrevista para el sábado 16 de mayo a las 10:00 a.m.; debe traer hoja de vida en PDF o Word/DOCX y cédula original. ¿Te queda bien ese horario?',
    'Hoja de vida y cédula original'
  );

  assert.match(reply, /debe traer Hoja de vida y cédula original/i);
  assert.doesNotMatch(reply, /PDF|DOCX/i);
});

test('estado de vacante para el motor expone documentación de entrevista saneada', () => {
  const state = buildVacancyStateForModel({
    title: 'Operario de planta',
    role: 'Operario',
    city: 'Medellín',
    isActive: true,
    acceptingApplications: true,
    requiredDocuments: 'Hoja de vida Minerva 1003 física o impresa, como la tenga, y cédula original'
  });

  assert.match(state.interviewDocumentation, /Hoja de vida Minerva 1003 física o impresa, como la tenga, y cédula original/i);
  assert.doesNotMatch(state.interviewDocumentation, /PDF|DOCX/i);
});

test('replySafety bloquea salida peligrosa sobre HV', () => {
  const result = sanitizeOutboundReply({ reply: 'Puedes enviarme la hoja de vida en foto o como la tengas.' });
  assert.equal(result.blocked, true);
  assert.equal(result.reply, CV_UNSAFE_FALLBACK_REPLY);
});
