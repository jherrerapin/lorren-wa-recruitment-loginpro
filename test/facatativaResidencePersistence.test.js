import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignCandidateLocationFields,
  getCandidateResidenceValue
} from '../src/services/candidateData.js';

const bogotaVacancy = { id: 'TEST-VACANCY-BOGOTA', city: 'Bogota' };

test('Facatativá se conserva como residencia soportada en una vacante Bogotá', () => {
  const aligned = alignCandidateLocationFields(
    { locality: 'Facatativá', neighborhood: 'Facatativá' },
    bogotaVacancy,
    { clearAlternate: true }
  );

  assert.equal(aligned.locality, null);
  assert.equal(aligned.neighborhood, 'Facatativa Cundinamarca');
  assert.equal(getCandidateResidenceValue(aligned, bogotaVacancy), 'Facatativa Cundinamarca');
});

test('las normalizaciones existentes para Bogotá y municipios soportados no cambian', () => {
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
