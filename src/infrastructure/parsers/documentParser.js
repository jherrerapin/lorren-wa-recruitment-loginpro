import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const PDF_MIME_TYPE = 'application/pdf';
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARACTERS = 100_000;

function normalizedMimeType(value) {
  return typeof value === 'string'
    ? value.split(';', 1)[0].trim().toLowerCase()
    : '';
}

function normalizedExtractedText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  return text.slice(0, MAX_EXTRACTED_TEXT_CHARACTERS);
}

/**
 * Extract plain text from a supported CV document without retaining its binary.
 * Parsing is best-effort: unsupported, malformed or unreadable documents return null.
 */
export async function extractDocumentText(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_DOCUMENT_BYTES) {
    return null;
  }

  try {
    const normalizedType = normalizedMimeType(mimeType);
    if (normalizedType === PDF_MIME_TYPE) {
      const result = await pdfParse(buffer);
      return normalizedExtractedText(result?.text);
    }
    if (normalizedType === DOCX_MIME_TYPE) {
      const result = await mammoth.extractRawText({ buffer });
      return normalizedExtractedText(result?.value);
    }
    return null;
  } catch {
    return null;
  }
}

export const documentParser = Object.freeze({ extractDocumentText });

export default documentParser;
