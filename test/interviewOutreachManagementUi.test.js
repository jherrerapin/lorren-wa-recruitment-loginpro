import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const uiSource = readFileSync(
  new URL('../src/public/interview-outreach-management.js', import.meta.url),
  'utf8'
);
const routeSource = readFileSync(
  new URL('../src/routes/interviewOutreachManagement.js', import.meta.url),
  'utf8'
);

test('la gestión visual cubre confirmación previa y asistencia real como controles separados', () => {
  for (const token of [
    "['PENDING', 'Pendiente']",
    "['CONFIRMED', 'Confirmó']",
    "['DECLINED', 'No asistirá']",
    "['ATTENDED', 'Asistió']",
    "['NO_SHOW', 'No asistió']"
  ]) {
    assert.match(uiSource, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(uiSource, /Confirmación de citación/);
  assert.match(uiSource, /Asistencia real/);
});

test('el perfil permite evaluación decimal, observación opcional y campos complementarios', () => {
  assert.match(uiSource, /type = 'number'/);
  assert.match(uiSource, /ratingInput\.min = '1'/);
  assert.match(uiSource, /ratingInput\.max = '5'/);
  assert.match(uiSource, /ratingInput\.step = '0\.01'/);
  assert.match(uiSource, /Guardar evaluación/);
  assert.match(uiSource, /Agregar campo complementario/);
  assert.match(uiSource, /observationEnabled/);
  assert.match(uiSource, /complementaryFields/);
});

test('la UI no solicita actor y no introduce diálogos nativos', () => {
  assert.doesNotMatch(uiSource, /actor\s*:/);
  assert.doesNotMatch(uiSource, /updatedBy\s*:/);
  assert.doesNotMatch(uiSource, /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
});

test('la activación se inyecta una sola vez solo en dashboard y detalle de candidato', () => {
  assert.match(routeSource, /data-interview-outreach-management/);
  assert.match(routeSource, /req\.path === '\/'/);
  assert.match(routeSource, /\^\\\/candidates\\\/\[\^\/\]\+\$/);
  assert.match(routeSource, /!body\.includes\('data-interview-outreach-management'\)/);
  assert.match(routeSource, /\/public\/interview-outreach-management\.js/);
});

test('el dashboard consume únicamente la API autorizada de gestión por vacante', () => {
  assert.match(uiSource, /\/vacancies\/\$\{encodeURIComponent\(vacancyId\)\}/);
  assert.match(uiSource, /\/candidates\/\$\{encodeURIComponent\(candidateId\)\}/);
  assert.doesNotMatch(uiSource, /\/webhook/);
});
