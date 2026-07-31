import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { extractLegacyWordText } from './legacyWordText.js';
import {
  assessExtractedCvText,
  detectCvDocumentMetadata
} from './cvDocumentMetadata.js';

const MAX_TEXT_LENGTH = 12000;

function normalizeText(value = '') {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function extractionMetadata(detected) {
  return {
    detectedKind: detected.kind,
    detectedMimeType: detected.mimeType,
    detectedExtension: detected.extension,
    detectionSource: detected.source,
    metadataMismatch: detected.metadataMismatch,
    metadataConflict: detected.metadataConflict,
    signatureKind: detected.signatureKind,
    mimeKind: detected.mimeKind,
    extensionKind: detected.extensionKind
  };
}

function safeExtractionError(error) {
  const code = String(error?.code || error?.name || 'unknown_error').trim();
  return code.slice(0, 120);
}

export async function extractCvText(buffer, options = {}) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { ok: false, text: '', reason: 'missing_buffer' };
  }

  const detected = detectCvDocumentMetadata(buffer, {
    mimeType: options.mimeType,
    fileName: options.fileName
  });
  const metadata = extractionMetadata(detected);

  if (detected.kind === 'pdf') {
    try {
      const result = await pdfParse(buffer);
      const rawText = normalizeText(result?.text || '');
      if (!rawText) {
        return { ok: false, text: '', reason: 'empty_pdf_text', quality: assessExtractedCvText(''), ...metadata };
      }

      const quality = assessExtractedCvText(rawText);
      if (!quality.useful) {
        return {
          ok: true,
          text: '',
          rawText,
          reason: 'low_quality_pdf_text',
          quality,
          ...metadata
        };
      }

      return { ok: true, text: rawText, reason: 'pdf_text_extracted', quality, ...metadata };
    } catch (error) {
      return {
        ok: false,
        text: '',
        reason: 'text_extraction_failed',
        error: safeExtractionError(error),
        ...metadata
      };
    }
  }

  if (detected.kind === 'doc') {
    const result = extractLegacyWordText(buffer);
    const text = normalizeText(result.text);
    return {
      ...result,
      text,
      quality: assessExtractedCvText(text),
      ...metadata
    };
  }

  if (detected.kind === 'docx') {
    try {
      const result = await mammoth.extractRawText({ buffer });
      const text = normalizeText(result?.value || '');
      return {
        ok: Boolean(text),
        text,
        reason: text ? 'docx_text_extracted' : 'empty_docx_text',
        quality: assessExtractedCvText(text),
        ...metadata
      };
    } catch (error) {
      return {
        ok: false,
        text: '',
        reason: 'text_extraction_failed',
        error: safeExtractionError(error),
        ...metadata
      };
    }
  }

  return {
    ok: false,
    text: '',
    reason: 'unsupported_file_type',
    ...metadata
  };
}
