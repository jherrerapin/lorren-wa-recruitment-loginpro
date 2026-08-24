import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVacancyApplicationCycleScript,
  historicalBulkCandidateStatuses
} from '../src/services/vacancyDashboardSearchExpansion.js';

const cycleMetadata = {
  'vacancy-test': {
    vacancyId: 'vacancy-test',
    cityName: 'Ciudad Prueba',
    cycleStartedAt: '2026-08-01T12:00:00.000Z',
    showHistory: true,
    historicalCandidateCount: 8,
    visibleCandidateCount: 8
  }
};

function clientScriptBody(script = '') {
  return String(script)
    .replace(/^\s*<script>\s*/, '')
    .replace(/\s*<\/script>\s*$/, '');
}

test('cambio masivo histórico conserva los estados de reclutamiento permitidos por rol', () => {
  assert.deepEqual(
    historicalBulkCandidateStatuses('admin'),
    ['REGISTRADO', 'APROBADO', 'CONTACTADO', 'RECHAZADO']
  );
  assert.deepEqual(
    historicalBulkCandidateStatuses('dev'),
    ['NUEVO', 'REGISTRADO', 'APROBADO', 'CONTACTADO', 'RECHAZADO']
  );
  assert.equal(historicalBulkCandidateStatuses('admin').includes('CONTRATADO'), false);
});

test('el histórico por vacante añade selección múltiple y reutiliza la transición individual existente', () => {
  const script = buildVacancyApplicationCycleScript(cycleMetadata, 'admin');

  assert.match(script, /data-vacancy-bulk-status/);
  assert.match(script, /data-history-candidate-id/);
  assert.match(script, /Seleccionar visibles/);
  assert.match(script, /Aplicar a seleccionados/);
  assert.match(script, /\/admin\/candidates\//);
  assert.match(script, /\/status/);
  assert.match(script, /bulkStatuses = \["REGISTRADO","APROBADO","CONTACTADO","RECHAZADO"\]/);
  assert.doesNotMatch(script, /\/bulk-status/);
  assert.doesNotThrow(() => new Function(clientScriptBody(script)));
});

test('los controles masivos solo se activan en histórico y excluyen contratados', () => {
  const script = buildVacancyApplicationCycleScript(cycleMetadata, 'dev');

  assert.match(script, /!meta\.showHistory \|\| !meta\.cycleStartedAt/);
  assert.match(script, /row\.querySelector\('\.badge-contratado'\)/);
  assert.match(script, /Contratados se gestionan individualmente/);
  assert.match(script, /bulkStatuses = \["NUEVO","REGISTRADO","APROBADO","CONTACTADO","RECHAZADO"\]/);
  assert.doesNotMatch(script, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotThrow(() => new Function(clientScriptBody(script)));
});
