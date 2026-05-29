import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guardReplyAgainstReadinessDrift } from '../src/services/replySafety.js';

test('acopla solicitudes de datos al readiness y reemplaza campos no pendientes', () => {
  const result = guardReplyAgainstReadinessDrift(
    'Gracias, Cristhian. Me falta solo confirmar el correo para completar tu registro y seguir con el proceso.',
    {
      missingFields: ['documentNumber'],
      missingFieldLabels: ['numero de documento'],
      hasValidCv: false
    }
  );

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'profile_request_outside_readiness');
  assert.deepEqual(result.requestedFieldsOutsideReadiness, ['email']);
  assert.match(result.reply, /numero de documento/i);
  assert.doesNotMatch(result.reply, /correo|email/i);
});

test('mantiene libertad de redaccion cuando pide un dato faltante real', () => {
  const reply = 'Cristhian, para seguir solo me falta confirmar tu numero de documento.';
  const result = guardReplyAgainstReadinessDrift(reply, {
    missingFields: ['documentNumber'],
    missingFieldLabels: ['numero de documento']
  });

  assert.equal(result.blocked, false);
  assert.equal(result.reply, reply);
});

test('permite cualquier dato cuando readiness lo marca como faltante real', () => {
  const reply = 'Para continuar, confírmame tu correo.';
  const result = guardReplyAgainstReadinessDrift(reply, {
    missingFields: ['email'],
    missingFieldLabels: ['correo']
  });

  assert.equal(result.blocked, false);
  assert.equal(result.reply, reply);
});


test('el prompt expone a la IA el alcance operativo del turno desde readiness y vacante', () => {
  const source = readFileSync(new URL('../src/services/conversationEngine.js', import.meta.url), 'utf8');

  assert.match(source, /ALCANCE OPERATIVO DEL TURNO/);
  assert.match(source, /pide exclusivamente lo que aparece pendiente en READINESS/);
  assert.match(source, /No agregues datos por costumbre de reclutamiento/);
  assert.match(source, /usa solo ESTADO CURADO DE LA VACANTE/);
});
