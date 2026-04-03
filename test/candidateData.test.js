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

test('normaliza experiencia negativa a No y tiempo 0', () => {
  const parsed = parseNaturalData('no tengo experiencia');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.experienceInfo, 'No');
  assert.equal(normalized.experienceTime, '0');
});

test('normaliza experiencia afirmativa a Sí', () => {
  const parsed = parseNaturalData('sí tengo experiencia');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.experienceInfo, 'Sí');
});

test('normaliza tiempo válido forzando experiencia Sí', () => {
  const parsed = parseNaturalData('6 meses de experiencia');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.experienceInfo, 'Sí');
  assert.equal(normalized.experienceTime, '6 meses');
});

test('normaliza ausencia de restricciones médicas', () => {
  const parsed = parseNaturalData('no tengo restricciones');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.medicalRestrictions, 'Sin restricciones médicas');
});

test('captura datos en orden libre con transporte al inicio y nombre al final', () => {
  const parsed = parseNaturalData('Transporte: moto, edad 28, barrio Jordán, CC 10203040, tengo 2 años de experiencia, sin restricciones, mi nombre es ana sofia perez');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.transportMode, 'Moto');
  assert.equal(normalized.age, 28);
  assert.equal(normalized.neighborhood, 'Jordán');
  assert.equal(normalized.documentType, 'CC');
  assert.equal(normalized.documentNumber, '10203040');
  assert.equal(normalized.experienceInfo, 'Sí');
  assert.equal(normalized.experienceTime, '2 años');
  assert.equal(normalized.medicalRestrictions, 'Sin restricciones médicas');
  assert.equal(normalized.fullName, 'Ana Sofia Perez');
});

test('normaliza tipo documental cédula de ciudadanía a CC', () => {
  const parsed = parseNaturalData('tipo Cédula ciudadanía 1122334455');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.documentType, 'CC');
  assert.equal(normalized.documentNumber, '1122334455');
});

test('captura barrio ciudadela simon bolívar en title case', () => {
  const parsed = parseNaturalData('vivo en ciudadela simon bolivar y tengo moto');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.neighborhood, 'Ciudadela Simon Bolivar');
});

test('no confunde edad con tiempo de experiencia', () => {
  const parsed = parseNaturalData('tengo 22 años');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.age, 22);
  assert.equal(normalized.experienceTime, undefined);
});

test('extrae tiempo de experiencia solo con contexto laboral', () => {
  const parsed = parseNaturalData('cuento con 2 años de experiencia');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.experienceInfo, 'Sí');
  assert.equal(normalized.experienceTime, '2 años');
});

test('normaliza negación de transporte sin convertirla en moto', () => {
  const parsed = parseNaturalData('no tengo moto');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.transportMode, 'Sin medio de transporte');
});

test('documento con puntos o prefijo no contamina edad', () => {
  const parsed = parseNaturalData('CC.1022333444 tengo 19 años');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.documentNumber, '1022333444');
  assert.equal(normalized.age, 19);
});

test('negación compuesta de transporte termina en sin medio de transporte', () => {
  const parsed = parseNaturalData('no tengo moto ni bicicleta');
  const normalized = normalizeCandidateFields(parsed);
  assert.equal(normalized.transportMode, 'Sin medio de transporte');
});
