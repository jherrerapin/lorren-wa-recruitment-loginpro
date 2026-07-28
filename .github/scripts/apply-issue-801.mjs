import fs from 'node:fs';
import assert from 'node:assert/strict';

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `${label}: se esperaba una coincidencia y se encontraron ${count}`);
  return source.replace(before, after);
}

const guardPath = 'test/aiFirstRecruitmentGuards.test.js';
let guard = fs.readFileSync(guardPath, 'utf8');
guard = replaceOnce(
  guard,
  `test('HV .doc o storage sin MIME/nombre PDF/DOCX no cuenta como CV válido', () => {
  assert.equal(hasValidCv(candidate({ cvMimeType: 'application/msword', cvOriginalName: 'hoja-vida.doc' })), false);`,
  `test('HV .doc auténtico cuenta como válido y metadatos incompletos no', () => {
  assert.equal(hasValidCv(candidate({ cvMimeType: 'application/msword', cvOriginalName: 'hoja-vida.doc' })), true);`,
  'contrato .doc válido'
);
guard = replaceOnce(
  guard,
  `test('E: HV imagen no cuenta como CV válido y seguridad pide PDF/DOCX', async () => {`,
  `test('E: HV imagen no cuenta como CV válido y seguridad pide PDF, DOC o DOCX', async () => {`,
  'nombre del contrato de formatos'
);
guard = replaceOnce(
  guard,
  `  assert.match(safe.reply, /PDF o Word\/DOCX/i);`,
  `  assert.match(safe.reply, /PDF, DOC o DOCX/i);`,
  'texto seguro de formatos'
);
fs.writeFileSync(guardPath, guard);

const hardeningPath = 'test/hardeningP0Delta.test.js';
let hardening = fs.readFileSync(hardeningPath, 'utf8');
hardening = replaceOnce(
  hardening,
  `test('documento no CV se clasifica OTHER y no CV_VALID', async () => {`,
  `test('PDF ilegible se clasifica UNREADABLE y no CV_VALID', async () => {`,
  'nombre del contrato de PDF ilegible'
);
hardening = replaceOnce(
  hardening,
  `  assert.notEqual(result.classification, 'CV_VALID');
  assert.equal(result.classification, 'OTHER');`,
  `  assert.notEqual(result.classification, 'CV_VALID');
  assert.equal(result.classification, 'UNREADABLE');
  assert.equal(result.rationale, 'empty_text');`,
  'clasificación vigente de PDF ilegible'
);
fs.writeFileSync(hardeningPath, hardening);

console.log('Contratos de HV alineados con PDF/DOC/DOCX y UNREADABLE.');
