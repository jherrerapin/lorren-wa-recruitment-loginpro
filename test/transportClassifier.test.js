import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TransportKind,
  buildOwnTransportQuestion,
  classifyTransportKind,
  hasOwnTransport,
  needsOwnTransportQuestion
} from '../src/services/transportClassifier.js';

test('clasifica moto, carro y bicicleta como transporte propio', () => {
  assert.equal(classifyTransportKind('tengo moto').kind, TransportKind.OWN);
  assert.equal(classifyTransportKind('cuento con carro').kind, TransportKind.OWN);
  assert.equal(classifyTransportKind('voy en bicicleta').kind, TransportKind.OWN);
  assert.equal(hasOwnTransport('moto'), true);
});

test('clasifica transporte publico y variantes como publico', () => {
  assert.equal(classifyTransportKind('transporte público').kind, TransportKind.PUBLIC);
  assert.equal(classifyTransportKind('voy en transmilenio').kind, TransportKind.PUBLIC);
  assert.equal(classifyTransportKind('me toca en bus').kind, TransportKind.PUBLIC);
  assert.equal(hasOwnTransport('sitp'), false);
});

test('activa pregunta de transporte propio solo para Siberia cuando falta transporte', () => {
  assert.equal(needsOwnTransportQuestion({ operationKey: 'siberia', transportMode: null }), true);
  assert.equal(needsOwnTransportQuestion({ operationKey: 'SIBERIA', transportMode: 'moto' }), false);
  assert.equal(needsOwnTransportQuestion({ operationKey: 'montevideo', transportMode: null }), false);
  assert.equal(buildOwnTransportQuestion(), 'Para esa zona, ¿cuentas con medio de transporte propio?');
});
