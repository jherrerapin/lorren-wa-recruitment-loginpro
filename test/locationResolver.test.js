import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LocationEntityType,
  LocationQuestionAction,
  buildLocationQuestion,
  buildResidenceFieldsFromLocation,
  decideLocationQuestion,
  resolveLocationEntity
} from '../src/services/locationResolver.js';

test('Bogota ciudad pide localidad, no barrio', () => {
  const entity = resolveLocationEntity('Bogotá');

  assert.equal(entity.type, LocationEntityType.BOGOTA_CITY);
  assert.equal(decideLocationQuestion({ entity }), LocationQuestionAction.ASK_BOGOTA_LOCALITY);
  assert.equal(buildLocationQuestion(LocationQuestionAction.ASK_BOGOTA_LOCALITY), 'Gracias. ¿En qué localidad vives?');
});

test('localidad de Bogota se acepta como residencia', () => {
  const entity = resolveLocationEntity('Engativá');
  const fields = buildResidenceFieldsFromLocation(entity);

  assert.equal(entity.type, LocationEntityType.BOGOTA_LOCALITY);
  assert.equal(entity.name, 'Engativá');
  assert.equal(decideLocationQuestion({ entity }), LocationQuestionAction.ACCEPT);
  assert.deepEqual(fields, { locality: 'Engativá', neighborhood: null, zone: 'Engativá' });
});

test('municipio del area Bogota Sabana se guarda sin pedir barrio', () => {
  for (const value of ['Soacha', 'Funza', 'Mosquera', 'Madrid', 'Cota']) {
    const entity = resolveLocationEntity(value);
    const fields = buildResidenceFieldsFromLocation(entity);

    assert.equal(entity.type, LocationEntityType.BOGOTA_AREA_MUNICIPALITY);
    assert.equal(decideLocationQuestion({ entity }), LocationQuestionAction.ACCEPT);
    assert.equal(fields.locality, null);
    assert.match(fields.neighborhood, /Cundinamarca/);
  }
});

test('otra ciudad con vacante propia pide barrio', () => {
  const entity = resolveLocationEntity('Ibagué');

  assert.equal(entity.type, LocationEntityType.OTHER_CITY_OR_PLACE);
  assert.equal(decideLocationQuestion({ entity, isBogotaAreaFlow: false }), LocationQuestionAction.ASK_NEIGHBORHOOD);
  assert.equal(buildLocationQuestion(LocationQuestionAction.ASK_NEIGHBORHOOD), 'Gracias. ¿En qué barrio vives?');
});

test('otra ciudad en flujo Bogota/Sabana se acepta como ubicacion sin barrio', () => {
  const entity = resolveLocationEntity('Facatativá');

  assert.equal(entity.type, LocationEntityType.BOGOTA_AREA_MUNICIPALITY);
  assert.equal(decideLocationQuestion({ entity, isBogotaAreaFlow: true }), LocationQuestionAction.ACCEPT);
});
