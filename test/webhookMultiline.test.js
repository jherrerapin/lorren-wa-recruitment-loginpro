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

test('la ventana multilinea usa 90 segundos para consolidar antes de razonar', () => {
  const previousEnv = process.env.NODE_ENV;
  const previousReasoning = process.env.LORREN_REASONING_WINDOW_MS;
  const previousMultiline = process.env.MULTILINE_SILENCE_WINDOW_MS;
  process.env.NODE_ENV = 'development';
  try {
    delete process.env.LORREN_REASONING_WINDOW_MS;
    delete process.env.MULTILINE_SILENCE_WINDOW_MS;

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

    assert.equal(earlyWindow, 90000);
    assert.equal(resolvedWindow, 90000);
  } finally {
    process.env.NODE_ENV = previousEnv;
    if (previousReasoning === undefined) delete process.env.LORREN_REASONING_WINDOW_MS;
    else process.env.LORREN_REASONING_WINDOW_MS = previousReasoning;
    if (previousMultiline === undefined) delete process.env.MULTILINE_SILENCE_WINDOW_MS;
    else process.env.MULTILINE_SILENCE_WINDOW_MS = previousMultiline;
  }
});

test('la ventana de razonamiento se puede configurar y queda acotada a 90 segundos', () => {
  const previousEnv = process.env.NODE_ENV;
  const previousReasoning = process.env.LORREN_REASONING_WINDOW_MS;
  process.env.NODE_ENV = 'development';
  process.env.LORREN_REASONING_WINDOW_MS = '120000';
  try {
    assert.equal(getMultilineWindowMs({ currentStep: 'ASK_CV', vacancyResolved: true }), 90000);
  } finally {
    process.env.NODE_ENV = previousEnv;
    if (previousReasoning === undefined) delete process.env.LORREN_REASONING_WINDOW_MS;
    else process.env.LORREN_REASONING_WINDOW_MS = previousReasoning;
  }
});
