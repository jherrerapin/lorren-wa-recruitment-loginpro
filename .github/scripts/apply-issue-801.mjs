import fs from 'node:fs';
import assert from 'node:assert/strict';

function transformLines(path, transforms) {
  const lines = fs.readFileSync(path, 'utf8').split('\n');
  const counts = Object.fromEntries(transforms.map((item) => [item.id, 0]));
  const next = lines.map((line) => {
    for (const item of transforms) {
      if (item.match(line)) {
        counts[item.id] += 1;
        return item.replace(line);
      }
    }
    return line;
  });
  for (const item of transforms) {
    assert.equal(counts[item.id], 1, `${item.id}: se esperaba una línea y se encontraron ${counts[item.id]}`);
  }
  fs.writeFileSync(path, next.join('\n'));
}

transformLines('test/aiFirstRecruitmentGuards.test.js', [
  {
    id: 'test_title_doc',
    match: (line) => line.includes("test('HV .doc o storage sin MIME/nombre PDF/DOCX no cuenta como CV válido'"),
    replace: () => "test('HV .doc auténtico cuenta como válido y metadatos incompletos no', () => {"
  },
  {
    id: 'doc_assertion',
    match: (line) => line.includes("cvMimeType: 'application/msword'") && line.includes("hoja-vida.doc") && line.includes('false);'),
    replace: (line) => line.replace('false);', 'true);')
  },
  {
    id: 'test_title_formats',
    match: (line) => line.includes("test('E: HV imagen no cuenta como CV válido y seguridad pide PDF/DOCX'"),
    replace: () => "test('E: HV imagen no cuenta como CV válido y seguridad pide PDF, DOC o DOCX', async () => {"
  },
  {
    id: 'safe_reply_formats',
    match: (line) => line.includes('assert.match(safe.reply'),
    replace: () => '  assert.match(safe.reply, /PDF, DOC o DOCX/i);'
  }
]);

transformLines('test/hardeningP0Delta.test.js', [
  {
    id: 'test_title_unreadable',
    match: (line) => line.includes("test('documento no CV se clasifica OTHER y no CV_VALID'"),
    replace: () => "test('PDF ilegible se clasifica UNREADABLE y no CV_VALID', async () => {"
  },
  {
    id: 'classification_unreadable',
    match: (line) => line.trim() === "assert.equal(result.classification, 'OTHER');",
    replace: () => "  assert.equal(result.classification, 'UNREADABLE');\n  assert.equal(result.rationale, 'empty_text');"
  }
]);

console.log('Contratos de HV alineados con PDF/DOC/DOCX y UNREADABLE.');
