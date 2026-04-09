import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidateTextMessages, getMultilineWindowMs, summarizeConsolidatedInput } from '../src/services/multiline.js';

test('consolida 3 a 5 mensajes consecutivos en un solo bloque de contexto', () => {
  const consolidated = consolidateTextMessages([
    { body: 'moto' },
    { body: 'CC 11223344' },
    { body: 'edad 26' },
    { body: 'barrio picaleña' },
    { body: 'nombre completo: juan david lopez' }
  ]);

  assert.match(consolidated, /moto/);
  assert.match(consolidated, /CC 11223344/);
  assert.match(consolidated, /nombre completo/);
  assert.equal(consolidated.split('\n').length, 5);
});

test('resumen consolidado sanitiza documento y edad', () => {
  const summary = summarizeConsolidatedInput('CC 1099887766, edad 24, nombre: Carlos Perez');
  assert.match(summary, /\[doc_tipo\]/i);
  assert.match(summary, /\[doc\]/);
  assert.match(summary, /\[edad\]/);
  assert.doesNotMatch(summary, /1099887766/);
});

test('la ventana multilinea es larga al inicio y mas corta en un hilo ya resuelto', () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    const earlyWindow = getMultilineWindowMs({
      currentStep: 'MENU',
      vacancyResolved: false,
      text: 'ibague'
    });
    const resolvedWindow = getMultilineWindowMs({
      currentStep: 'ASK_CV',
      vacancyResolved: true,
      text: 'Si estoy interesado, que datos te doy?'
    });

    assert.equal(earlyWindow, 60000);
    assert.equal(resolvedWindow, 20000);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});
