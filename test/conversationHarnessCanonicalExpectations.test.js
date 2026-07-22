import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationCases } from './fixtures/conversationCases.js';
import { normalizeTransportMode } from '../src/services/transportMode.js';

function caseById(id) {
  const conversationCase = conversationCases.find((item) => item.id === id);
  assert.ok(conversationCase, `debe existir el escenario ${id}`);
  return conversationCase;
}

test('el saludo del harness exige ciudad y vacante sin fijar una frase legacy', () => {
  const greeting = caseById('greeting-not-name');
  const expected = greeting.expect.lastReplyIncludes.map((item) => item.toLowerCase());

  assert.ok(expected.some((item) => item.includes('desde que ciudad')));
  assert.ok(expected.some((item) => item.includes('para que vacante')));
  assert.ok(greeting.expect.absentFields.includes('fullName'));
});

test('los escenarios de ciudad exigen pedir vacante sin autoasignar', () => {
  for (const id of [
    'city-with-multiple-vacancies-asks-which-one',
    'city-only-does-not-auto-assign-even-with-single-active-city-vacancy'
  ]) {
    const conversationCase = caseById(id);
    const expected = conversationCase.expect.lastReplyIncludes.map((item) => item.toLowerCase());
    assert.ok(expected.some((item) => item.includes('gracias por contarme desde donde escribes')));
    assert.ok(expected.some((item) => item.includes('para que vacante o cargo')));
  }

  const cityOnly = caseById('city-only-does-not-auto-assign-even-with-single-active-city-vacancy');
  assert.equal(cityOnly.expect.candidate.vacancyId, null);
  assert.equal(cityOnly.expect.candidate.currentStep, 'GREETING_SENT');
});

test('bus usa el valor canónico Publico', () => {
  const busCase = caseById('bus-and-independent-recognized');
  assert.equal(normalizeTransportMode('bus'), 'Publico');
  assert.equal(busCase.expect.candidate.transportMode, normalizeTransportMode('bus'));
});
