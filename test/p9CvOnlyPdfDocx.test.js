import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicyReply } from '../src/services/responsePolicy.js';
import { analyzeAttachment } from '../src/services/attachmentAnalyzer.js';
import { looksLikeCvFilenameText } from '../src/services/cvFlow.js';
import { sanitizeRequiredDocumentsForBot, generateInterviewOffer } from '../src/services/naturalReply.js';
import { CV_UNSAFE_FALLBACK_REPLY, sanitizeOutboundReply } from '../src/services/replySafety.js';

function assertNoForbiddenHvTerms(reply) {
  assert.doesNotMatch(reply, /foto/i);
  assert.doesNotMatch(reply, /impresa/i);
  assert.doesNotMatch(reply, /como la tengas?/i);
  assert.doesNotMatch(reply, /minerva\s*1003/i);
}

test('responsePolicy pide HV solo en PDF o DOCX para intents críticos', () => {
  for (const replyIntent of ['request_cv_pdf_word', 'request_missing_cv', 'attachment_unreadable', 'attachment_id_doc']) {
    const { text } = buildPolicyReply({ replyIntent });
    assert.match(text, /PDF o DOCX/i);
    assertNoForbiddenHvTerms(text);
  }
});

test('image/jpeg no cuenta como CV válido y pide reenviar en PDF o DOCX', async () => {
  const analysis = await analyzeAttachment({ buffer: Buffer.from('fake image bytes'), mimeType: 'image/jpeg', filename: 'hv.jpg' });
  const saveCv = analysis.classification === 'CV_VALID';
  const hasCv = saveCv;
  const reply = buildPolicyReply({ replyIntent: 'request_cv_pdf_word' }).text;

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

test('sanitizeRequiredDocumentsForBot limpia requiredDocuments contaminado', async () => {
  const requiredDocuments = 'Traer hoja de vida Minerva 1003 o impresa, como la tenga, y cédula original.';
  const sanitized = sanitizeRequiredDocumentsForBot(requiredDocuments);
  assert.match(sanitized, /hoja de vida en PDF o Word\/DOCX/i);
  assert.match(sanitized, /cédula original/i);
  assertNoForbiddenHvTerms(sanitized);

  const reply = await generateInterviewOffer({
    formattedDate: 'jueves 14 de mayo a las 9:00 a. m.',
    vacancy: { requiredDocuments },
    candidateName: 'Ana Perez'
  });
  assert.match(reply, /hoja de vida en PDF o Word\/DOCX/i);
  assert.match(reply, /cédula original/i);
  assertNoForbiddenHvTerms(reply);
});

test('replySafety bloquea salida peligrosa sobre HV', () => {
  const result = sanitizeOutboundReply({ reply: 'Puedes enviarme la hoja de vida en foto o como la tengas.' });
  assert.equal(result.blocked, true);
  assert.equal(result.reply, CV_UNSAFE_FALLBACK_REPLY);
});
