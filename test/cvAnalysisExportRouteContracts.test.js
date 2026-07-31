import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/lorenV2CvAnalysis.js', 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `No se encontró ${startMarker}`);
  assert.notEqual(end, -1, `No se encontró ${endMarker}`);
  return source.slice(start, end);
}

test('la pantalla ofrece Excel completo y descarga independiente por sección', () => {
  const resultRendering = between('function renderExportForm', 'function errorMessage');

  assert.match(resultRendering, /Descargar Excel completo/);
  assert.match(resultRendering, /Descargar esta sección/);
  assert.match(resultRendering, /name="reviewToken"/);
  assert.match(resultRendering, /name="group"/);
  for (const group of ['strong', 'possible', 'low', 'manual']) {
    assert.match(resultRendering, new RegExp(`renderResultGroup\\([^\\n]+${group}`));
  }
});

test('la descarga usa la misma instantánea mostrada y no vuelve a ejecutar la IA', () => {
  const exportRoute = between("router.post('/export'", "router.post('/:candidateId/analyze'");

  assert.match(exportRoute, /loadCvReviewExportSnapshot/);
  assert.match(exportRoute, /sendCvAnalysisWorkbook/);
  assert.match(exportRoute, /buildVacancyAccessWhere/);
  assert.match(exportRoute, /snapshot\.vacancy\.id/);
  assert.doesNotMatch(exportRoute, /reviewVacancyCandidates\s*\(/);
  assert.doesNotMatch(exportRoute, /analyzeCandidateCv\s*\(/);
  assert.match(exportRoute, /status\(410\)/);
  assert.match(exportRoute, /status\(403\)/);
});

test('la revisión guarda una instantánea reducida vinculada a la sesión', () => {
  const runRoute = between("router.post('/run'", "router.post('/export'");

  assert.match(runRoute, /createCvReviewExportSnapshot\(review\)/);
  assert.match(runRoute, /getCvReviewExportOwnerKey\(req\)/);
  assert.match(runRoute, /storeCvReviewExportSnapshot/);
  assert.match(runRoute, /reviewToken/);
});
