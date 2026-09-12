import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/services/vacancyDashboardSearchExpansion.js', 'utf8');

function sourceBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `No se encontró ${startMarker}`);
  assert.notEqual(end, -1, `No se encontró ${endMarker}`);
  return source.slice(start, end);
}

test('un rango completo global consulta todos los candidatos autorizados del estado sin exigir vacancyId ni take', () => {
  const scopes = sourceBlock(
    'const COMPLETE_RANGE_LEGACY_SCOPES',
    'export function historicalBulkCandidateStatuses'
  );
  for (const scope of ['approved', 'contacted', 'contracted', 'rejected', 'all']) {
    assert.match(scopes, new RegExp(`'${scope}'`));
  }

  const loader = sourceBlock(
    'async function loadCompleteLegacyDateRangeCandidates',
    'export function applyApplicantDateRangeToVacancyLists'
  );
  assert.doesNotMatch(loader, /if\s*\(\s*!vacancyId/);
  assert.match(loader, /\.\.\.\(vacancyId\s*\?\s*\[\{\s*vacancyId\s*\}\]\s*:\s*\[\]\)/);
  assert.match(loader, /\.\.\.\(createdAt\s*\?\s*\[\{\s*createdAt\s*\}\]\s*:\s*\[\]\)/);
  assert.doesNotMatch(loader, /\btake\s*:/);
});

test('Todos conserva la semántica canónica y Aprobados tiene scope explícito', () => {
  const matcher = sourceBlock(
    'function candidateMatchesCompleteLegacyScope',
    'async function loadCompleteLegacyDateRangeCandidates'
  );
  assert.match(matcher, /options\.approvedOnly\s*\|\|\s*scope\s*===\s*'approved'/);
  assert.match(matcher, /if\s*\(status\s*===\s*'RECHAZADO'\)\s*return false/);
  assert.match(matcher, /return options\.isDev\s*\|\|\s*status\s*!==\s*'NUEVO'/);
});

test('la lista exhaustiva vuelve a aplicar la búsqueda activa antes de renderizar', () => {
  const enhancer = sourceBlock(
    'export async function enhanceLegacyApplicantList',
    'function escapeHtml'
  );
  assert.match(enhancer, /field:\s*normalizeString\(query\.searchField\)\s*===\s*'phone'\s*\?\s*'phone'\s*:\s*'document'/);
  assert.match(enhancer, /text:\s*normalizeString\(query\.searchText\)/);
  assert.match(enhancer, /candidateMatchesVacancyDashboardSearch\(candidate, search\)/);
  assert.match(enhancer, /candidateMatchesApplicantDateRange\(candidate, dateRange\)/);
});
