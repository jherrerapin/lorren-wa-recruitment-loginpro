import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidateFields, parseNaturalData } from '../src/services/candidateData.js';
import { splitFieldDecisions } from '../src/services/debugTrace.js';

test('frase de intención no se persiste como fullName', () => {
  const normalized = normalizeCandidateFields({ fullName: 'me interesa' });
  const decisions = splitFieldDecisions(normalized, { fullName: null });
  assert.equal(decisions.suspiciousFullNameRejected, true);
  assert.equal(Object.hasOwn(decisions.persistedData, 'fullName'), false);
});

test('captura y normaliza nombre básico sin prefijo', () => {
  const parsed = parseNaturalData('camilo hernandez');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.fullName, 'Camilo Hernandez');
});

test('captura línea compacta completa con barrio implícito y restricciones negativas', () => {
  const input = 'camilo hernandez cc 4654646654 25 picalena si tengo 6 meses no tengo restricciones, moto';
  const parsed = parseNaturalData(input);
  const normalized = normalizeCandidateFields(parsed);

  assert.equal(normalized.fullName, 'Camilo Hernandez');
  assert.equal(normalized.documentType, 'CC');
  assert.equal(normalized.documentNumber, '4654646654');
  assert.equal(normalized.age, 25);
  assert.equal(normalized.neighborhood, 'Picalena');
  assert.equal(normalized.experienceInfo, 'Sí');
  assert.equal(normalized.experienceTime, '6 meses');
  assert.equal(normalized.medicalRestrictions, 'Sin restricciones médicas');
  assert.equal(normalized.transportMode, 'Moto');
});

test('normaliza restricciones médicas negativas a canonical', () => {
  const normalized = normalizeCandidateFields({ medicalRestrictions: 'no tengo restricciones' });
  assert.equal(normalized.medicalRestrictions, 'Sin restricciones médicas');
});

test('normaliza transportMode y neighborhood', () => {
  const normalized = normalizeCandidateFields({ transportMode: 'moto', neighborhood: 'picalena' });
  assert.equal(normalized.transportMode, 'Moto');
  assert.equal(normalized.neighborhood, 'Picalena');
});
