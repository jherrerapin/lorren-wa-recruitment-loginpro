import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessExtractedCvText,
  buildHeaderSafeCvFilename,
  detectCvDocumentMetadata,
  normalizeStoredCvFilename
} from '../src/services/cvDocumentMetadata.js';

const OLE_BUFFER = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00
]);

test('firma PDF prevalece sobre MIME Word y registra la contradicción', () => {
  const detected = detectCvDocumentMetadata(Buffer.from('%PDF-1.7\ncontenido'), {
    mimeType: 'application/msword',
    fileName: 'HV WORD.pdf'
  });

  assert.equal(detected.kind, 'pdf');
  assert.equal(detected.mimeType, 'application/pdf');
  assert.equal(detected.metadataMismatch, true);
  assert.equal(detected.mimeKind, 'doc');
  assert.equal(detected.extensionKind, 'pdf');
});

test('Word clásico renombrado como PDF se identifica como DOC', () => {
  const detected = detectCvDocumentMetadata(OLE_BUFFER, {
    mimeType: 'application/pdf',
    fileName: 'HV.pdf'
  });

  assert.equal(detected.kind, 'doc');
  assert.equal(detected.mimeType, 'application/msword');
  assert.equal(detected.extension, '.doc');
  assert.equal(detected.metadataMismatch, true);
});

test('nombre Unicode combinado se convierte en encabezado HTTP seguro', () => {
  const name = 'HV JUAN SEBASTIA\u0301N MURCIA 2026 WORD.pdf';
  const safe = buildHeaderSafeCvFilename(name, { extension: '.pdf' });

  assert.equal(safe, 'HV JUAN SEBASTIAN MURCIA 2026 WORD.pdf');
  assert.doesNotMatch(safe, /[^\x20-\x7e]/);
  assert.doesNotMatch(safe, /["\\/\r\n]/);
  assert.equal(
    normalizeStoredCvFilename(name, { extension: '.pdf' }),
    'HV JUAN SEBASTIÁN MURCIA 2026 WORD.pdf'
  );
});

test('texto largo pero corrupto no se considera extracción útil', () => {
  const corrupted = `${'�'.repeat(40)} ${'x '.repeat(100)}`;
  const useful = 'Perfil profesional con experiencia laboral de dos años coordinando personal operativo, inventarios, despachos, seguridad, calidad y seguimiento de indicadores logísticos.';

  assert.equal(assessExtractedCvText(corrupted).useful, false);
  assert.equal(assessExtractedCvText(useful).useful, true);
});
