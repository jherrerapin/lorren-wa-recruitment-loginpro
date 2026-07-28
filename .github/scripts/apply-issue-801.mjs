import fs from 'node:fs';
import assert from 'node:assert/strict';

function replacePattern(source, pattern, replacement, label) {
  if (source.includes(replacement)) return source;
  assert.match(source, pattern, `${label}: patrón no encontrado`);
  return source.replace(pattern, replacement);
}

const guardPath = 'test/aiFirstRecruitmentGuards.test.js';
let guard = fs.readFileSync(guardPath, 'utf8');
guard = replacePattern(
  guard,
  /test\('HV \.doc o storage sin MIME\/nombre PDF\/DOCX no cuenta como CV válido', \(\) => \{/,
  `test('HV .doc auténtico cuenta como válido y metadatos incompletos no', () => {`,
  'nombre del contrato .doc'
);
guard = replacePattern(
  guard,
  /assert\.equal\(hasValidCv\(candidate\(\{ cvMimeType: 'application\/msword', cvOriginalName: 'hoja-vida\.doc' \}\)\), false\);/,
  `assert.equal(hasValidCv(candidate({ cvMimeType: 'application/msword', cvOriginalName: 'hoja-vida.doc' })), true);`,
  'aserción .doc válido'
);
guard = replacePattern(
  guard,
  /test\('E: HV imagen no cuenta como CV válido y seguridad pide PDF\/DOCX', async \(\) => \{/,
  `test('E: HV imagen no cuenta como CV válido y seguridad pide PDF, DOC o DOCX', async () => {`,
  'nombre del contrato de formatos'
);
guard = replacePattern(
  guard,
  /assert\.match\(safe\.reply, \/PDF o Word\\\/DOCX\/i\);/,
  `assert.match(safe.reply, /PDF, DOC o DOCX/i);`,
  'texto seguro de formatos'
);
fs.writeFileSync(guardPath, guard);

const hardeningPath = 'test/hardeningP0Delta.test.js';
let hardening = fs.readFileSync(hardeningPath, 'utf8');
hardening = replacePattern(
  hardening,
  /test\('documento no CV se clasifica OTHER y no CV_VALID', async \(\) => \{/,
  `test('PDF ilegible se clasifica UNREADABLE y no CV_VALID', async () => {`,
  'nombre del contrato de PDF ilegible'
);
hardening = replacePattern(
  hardening,
  /assert\.notEqual\(result\.classification, 'CV_VALID'\);\s*assert\.equal\(result\.classification, 'OTHER'\);/,
  `assert.notEqual(result.classification, 'CV_VALID');
  assert.equal(result.classification, 'UNREADABLE');
  assert.equal(result.rationale, 'empty_text');`,
  'clasificación vigente de PDF ilegible'
);
fs.writeFileSync(hardeningPath, hardening);

console.log('Contratos de HV alineados con PDF/DOC/DOCX y UNREADABLE.');
