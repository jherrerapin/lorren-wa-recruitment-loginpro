import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLegacyWordText, isLegacyWordBuffer } from '../src/services/legacyWordText.js';

function createLegacyWordBuffer(text = '') {
  const signature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return Buffer.concat([signature, Buffer.alloc(16), Buffer.from(text, 'utf16le')]);
}

test('reconoce la firma OLE de Word clásico y extrae texto UTF-16LE', () => {
  const buffer = createLegacyWordBuffer('Hoja de vida con experiencia laboral');
  const result = extractLegacyWordText(buffer);

  assert.equal(isLegacyWordBuffer(buffer), true);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'doc_text_extracted');
  assert.match(result.text, /Hoja de vida con experiencia laboral/i);
});

test('rechaza un archivo renombrado a DOC que no sea contenedor OLE', () => {
  const buffer = Buffer.from('este contenido no corresponde a Word clásico');
  const result = extractLegacyWordText(buffer);

  assert.equal(isLegacyWordBuffer(buffer), false);
  assert.deepEqual(result, { ok: false, text: '', reason: 'invalid_doc_container' });
});

test('un contenedor DOC sin texto recuperable queda explícitamente vacío', () => {
  const result = extractLegacyWordText(createLegacyWordBuffer());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty_doc_text');
  assert.equal(result.text, '');
});
