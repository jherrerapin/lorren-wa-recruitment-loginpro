import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const adminRoute = fs.readFileSync('src/routes/admin.js', 'utf8');
const listView = fs.readFileSync('src/views/list.ejs', 'utf8');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `No se encontró ${name}`);
  assert.notEqual(end, -1, `No se encontró el límite de ${name}`);
  return source.slice(start, end);
}

test('la búsqueda documental general compara el número y no el tipo de documento', () => {
  const source = functionSource(adminRoute, 'candidateMatchesSearch', 'normalizeGenderInput');

  assert.match(source, /candidate\?\.documentNumber/);
  assert.doesNotMatch(source, /documentType/);
  assert.match(source, /normalizeDigits\(candidate\?\.documentNumber\)/);
});

test('la búsqueda documental por vacante compara el número y no el tipo de documento', () => {
  const source = functionSource(listView, 'candidateMatchesVacancySearch', 'candidateObservationSnippet');

  assert.match(source, /candidate\.documentNumber/);
  assert.doesNotMatch(source, /documentType/);
  assert.match(source, /replace\(\/\\D\+\/g, ''\)/);
});

test('documento y celular permanecen como criterios separados', () => {
  const generalSource = functionSource(adminRoute, 'candidateMatchesSearch', 'normalizeGenderInput');
  const vacancySource = functionSource(listView, 'candidateMatchesVacancySearch', 'candidateObservationSnippet');

  assert.match(generalSource, /search\?\.field \|\| 'document'\) === 'phone'/);
  assert.match(generalSource, /candidate\?\.phone/);
  assert.match(vacancySource, /search\.field === 'phone'/);
  assert.match(vacancySource, /candidate && candidate\.phone/);
});
