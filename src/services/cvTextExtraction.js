import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const MAX_TEXT_LENGTH = 12000;

function normalizeText(value = '') {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function isPdf(mimeType = '', fileName = '') {
  return String(mimeType || '').includes('pdf') || String(fileName || '').toLowerCase().endsWith('.pdf');
}

function isDocx(mimeType = '', fileName = '') {
  const name = String(fileName || '').toLowerCase();
  return name.endsWith('.docx') || String(mimeType || '').includes('wordprocessingml.document');
}

export async function extractCvText(buffer, options = {}) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { ok: false, text: '', reason: 'missing_buffer' };
  }

  const mimeType = options.mimeType || '';
  const fileName = options.fileName || '';

  if (isPdf(mimeType, fileName)) {
    const result = await pdfParse(buffer);
    const text = normalizeText(result?.text || '');
    return { ok: Boolean(text), text, reason: text ? 'pdf_text_extracted' : 'empty_pdf_text' };
  }

  if (isDocx(mimeType, fileName)) {
    const result = await mammoth.extractRawText({ buffer });
    const text = normalizeText(result?.value || '');
    return { ok: Boolean(text), text, reason: text ? 'docx_text_extracted' : 'empty_docx_text' };
  }

  return { ok: false, text: '', reason: 'unsupported_file_type' };
}
