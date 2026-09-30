import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectGenderFromEvidence,
  hasStrongGenderEvidence
} from '../src/services/genderEvidencePolicy.js';

test('detecta evidencia femenina y masculina autorreferida en distintas formas', () => {
  for (const text of [
    'Soy una chica y quiero postularme',
    'Soy operaria y estoy buscando empleo',
    'Nací mujer',
    'Me llamo María Pérez y estoy interesada en el cargo',
    'Soy técnica titulada y quedo disponible',
    'Quedo atenta'
  ]) {
    assert.equal(detectGenderFromEvidence(text), 'FEMALE', text);
  }

  for (const text of [
    'Soy un chico y quiero postularme',
    'Soy operario y estoy buscando empleo',
    'Nací hombre',
    'Me llamo Juan Pérez y estoy interesado en el cargo',
    'Soy técnico titulado y quedo disponible',
    'Quedo atento'
  ]) {
    assert.equal(detectGenderFromEvidence(text), 'MALE', text);
  }
});

test('no depende de una pregunta de género ni acepta abreviaturas aisladas', () => {
  assert.equal(detectGenderFromEvidence('F'), null);
  assert.equal(detectGenderFromEvidence('F', {
    lastBotQuestion: '¿Con qué género te identificas?'
  }), null);
  assert.equal(detectGenderFromEvidence('masculino', {
    lastBotQuestion: 'Indica tu sexo'
  }), 'MALE');
});

test('rechaza cortesías, referencias a terceros y deducciones por nombre', () => {
  for (const text of [
    'Sí señora, claro',
    'Mi esposa está interesada',
    'Es para mi hermana',
    'María Fernanda Pérez'
  ]) {
    assert.equal(detectGenderFromEvidence(text), null, text);
  }
  assert.equal(hasStrongGenderEvidence('FEMALE', 'María Fernanda Pérez'), false);
});

test('el nombre por sí solo nunca se convierte en género', () => {
  assert.equal(detectGenderFromEvidence('Me llamo María Fernanda Pérez'), null);
  assert.equal(detectGenderFromEvidence('Mi nombre es Juan Carlos Gómez'), null);
});
