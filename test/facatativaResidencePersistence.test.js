import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignCandidateLocationFields,
  getCandidateResidenceValue
} from '../src/services/candidateData.js';

const bogotaVacancy = { id: 'TEST-VACANCY-BOGOTA', city: 'Bogota' };

test('una residencia externa válida no se borra al editar un candidato de una vacante Bogotá', () => {
  const aligned = alignCandidateLocationFields(
    { locality: 'Facatativá', neighborhood: 'Facatativá' },
    bogotaVacancy,
    { clearAlternate: true }
  );

  assert.equal(aligned.locality, null);
  assert.equal(aligned.neighborhood, 'Facatativá');
  assert.equal(getCandidateResidenceValue(aligned, bogotaVacancy), 'Facatativá');
});

test('la corrección conserva las normalizaciones existentes para Bogotá y municipios ya soportados', () => {
  const bogotaLocality = alignCandidateLocationFields(
    { locality: 'suba', neighborhood: 'suba' },
    bogotaVacancy,
    { clearAlternate: true }
  );
  const municipality = alignCandidateLocationFields(
    { locality: 'Soacha', neighborhood: 'Soacha' },
    bogotaVacancy,
    { clearAlternate: true }
  );

  assert.equal(bogotaLocality.locality, 'Suba');
  assert.equal(bogotaLocality.neighborhood, null);
  assert.equal(municipality.locality, null);
  assert.equal(municipality.neighborhood, 'Soacha Cundinamarca');
});

test('texto claramente no geográfico sigue descartándose como residencia', () => {
  const aligned = alignCandidateLocationFields(
    { locality: 'Auxiliar de bodega', neighborhood: 'Auxiliar de bodega' },
    bogotaVacancy,
    { clearAlternate: true }
  );

  assert.equal(aligned.locality, null);
  assert.equal(aligned.neighborhood, null);
  assert.equal(getCandidateResidenceValue(aligned, bogotaVacancy), null);
});
