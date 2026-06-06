import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ResidenceResolutionKind,
  ResidenceResolutionSource,
  hasResolvedResidence,
  resolveResidence,
  shouldAskBogotaLocality
} from '../src/services/residenceResolution.js';

test('Bogota ciudad queda como ciudad y pide localidad', () => {
  const result = resolveResidence({ text: 'Bogotá' });

  assert.equal(result.kind, ResidenceResolutionKind.BOGOTA_CITY);
  assert.equal(result.city, 'Bogotá');
  assert.equal(shouldAskBogotaLocality(result), true);
  assert.equal(hasResolvedResidence(result), false);
});

test('localidad de Bogota queda normalizada como residencia resuelta', () => {
  const result = resolveResidence({ text: 'Engativá' });

  assert.equal(result.kind, ResidenceResolutionKind.BOGOTA_LOCALITY);
  assert.equal(result.city, 'Bogotá');
  assert.equal(result.locality, 'Engativá');
  assert.equal(result.neighborhood, null);
  assert.equal(hasResolvedResidence(result), true);
});

test('municipio area Bogota Sabana queda como ubicacion completa sin localidad', () => {
  const result = resolveResidence({ text: 'Mosquera' });

  assert.equal(result.kind, ResidenceResolutionKind.BOGOTA_AREA_MUNICIPALITY);
  assert.equal(result.locality, null);
  assert.equal(result.neighborhood, 'Mosquera Cundinamarca');
  assert.equal(result.zone, 'Mosquera Cundinamarca');
  assert.equal(hasResolvedResidence(result), true);
});

test('geocoder confirmado tiene prioridad sobre fallback textual', () => {
  const result = resolveResidence({
    text: 'Patio Bonito',
    geocodedPlace: {
      displayName: 'Patio Bonito, Kennedy, Bogotá, Colombia',
      city: 'Bogotá',
      locality: 'Kennedy',
      neighborhood: 'Patio Bonito',
      confidence: 0.91
    }
  });

  assert.equal(result.source, ResidenceResolutionSource.GEOCODER);
  assert.equal(result.kind, ResidenceResolutionKind.BOGOTA_LOCALITY);
  assert.equal(result.city, 'Bogotá');
  assert.equal(result.locality, 'Kennedy');
  assert.equal(result.neighborhood, 'Patio Bonito');
  assert.equal(result.confidence, 0.91);
});

test('lugar no confirmado queda marcado para geocodificacion', () => {
  const result = resolveResidence({ text: 'Patio Bonito' });

  assert.equal(result.kind, ResidenceResolutionKind.OTHER_CITY);
  assert.equal(result.needsGeocoding, true);
});
