import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignCandidateLocationFields,
  getCandidateResidenceValue
} from '../src/services/candidateData.js';

test('vacante Bogotá conserva una residencia externa válida en lugar de borrarla', () => {
  const vacancy = { city: 'Bogota' };
  const aligned = alignCandidateLocationFields(
    { locality: 'Facatativa', neighborhood: 'Facatativa' },
    vacancy,
    { clearAlternate: true }
  );

  assert.equal(aligned.locality, null);
  assert.equal(aligned.neighborhood, 'Facatativa');
  assert.equal(getCandidateResidenceValue(aligned, vacancy), 'Facatativa');
});

test('vacante Bogotá conserva la semántica existente para localidades y municipios canonizados', () => {
  const vacancy = { city: 'Bogota' };
  const suba = alignCandidateLocationFields({ locality: 'Suba', neighborhood: 'Suba' }, vacancy, { clearAlternate: true });
  const soacha = alignCandidateLocationFields({ locality: 'Soacha', neighborhood: 'Soacha' }, vacancy, { clearAlternate: true });

  assert.equal(suba.locality, 'Suba');
  assert.equal(suba.neighborhood, null);
  assert.equal(soacha.locality, null);
  assert.equal(soacha.neighborhood, 'Soacha Cundinamarca');
});

test('vacante Bogotá sigue descartando texto que no tiene forma de residencia', () => {
  const aligned = alignCandidateLocationFields(
    { locality: 'Auxiliar de bodega', neighborhood: 'Auxiliar de bodega' },
    { city: 'Bogota' },
    { clearAlternate: true }
  );

  assert.equal(aligned.locality, null);
  assert.equal(aligned.neighborhood, null);
});
