import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeBogotaLocalidad } from '../src/services/geographyNormalization.js';
import { normalizeCityKey, dedupeCitiesByNormalizedName } from '../src/services/cityOptions.js';
import { normalizeTransportMode } from '../src/services/transportMode.js';
import { normalizeCandidateFields, parseNaturalData } from '../src/services/candidateData.js';

test('caracteriza localidades bogotanas exactas, aliases y Soacha no-localidad', () => {
  assert.equal(normalizeBogotaLocalidad('Suba'), 'Suba');
  assert.equal(normalizeBogotaLocalidad('Lisboa'), 'Suba');
  assert.equal(normalizeBogotaLocalidad('Patio Bonito'), 'Kennedy');
  assert.equal(normalizeBogotaLocalidad('Puente Aranda'), 'Puente Aranda');
  assert.equal(normalizeBogotaLocalidad('Soacha'), null);
});

test('caracteriza equivalencias de ciudad con tildes y espacios', () => {
  assert.equal(normalizeCityKey(' Bogotá  D.C. '), normalizeCityKey('Bogota D.C.'));
  assert.equal(normalizeCityKey(' Ibagué '), normalizeCityKey('Ibague'));
  assert.deepEqual(
    dedupeCitiesByNormalizedName([
      { id: 'bogota-1', name: 'Bogotá' },
      { id: 'bogota-2', name: ' Bogota ' },
      { id: 'ibague-1', name: 'Ibagué' },
      { id: 'city_auto', name: 'Bogota' }
    ]).map((city) => city.id),
    ['bogota-1', 'ibague-1']
  );
});

test('caracteriza transporte canonico, negaciones de vehiculo y typos existentes', () => {
  assert.equal(normalizeTransportMode('Moto'), 'Moto');
  assert.equal(normalizeTransportMode('motocicleta'), 'Moto');
  assert.equal(normalizeTransportMode('Bicicleta'), 'Bicicleta');
  assert.equal(normalizeTransportMode('bicivleta'), 'Bicicleta');
  assert.equal(normalizeTransportMode('bivivleta'), 'Bicicleta');
  assert.equal(normalizeTransportMode('bisicleta'), 'Bicicleta');
  assert.equal(normalizeTransportMode('Carro'), 'Carro');
  assert.equal(normalizeTransportMode('vehículo propio'), 'Carro');
  assert.equal(normalizeTransportMode('Público'), 'Publico');
  assert.equal(normalizeTransportMode('TransMilenio'), 'Publico');
  assert.equal(normalizeTransportMode('no cuento con vehículo'), 'Publico');
  assert.equal(normalizeTransportMode('sin moto'), 'Publico');
});

test('normalizeCandidateFields conserva campos para mensajes naturales representativos', () => {
  const cases = [
    {
      input: parseNaturalData('Transporte: moto, edad 28, barrio Jordán, CC 10203040, tengo 2 años de experiencia, sin restricciones, mi nombre es ana sofia perez'),
      expected: {
        fullName: 'Ana Sofia Perez',
        documentType: 'CC',
        documentNumber: '10203040',
        age: 28,
        neighborhood: 'Jordán',
        medicalRestrictions: 'Sin restricciones médicas',
        transportMode: 'Moto',
        experienceInfo: 'Sí',
        experienceTime: '2 años',
        experienceSummary: 'tengo 2 años de experiencia'
      }
    },
    {
      input: parseNaturalData('Cristian David Mahecha puentes\nCedula de ciudadania\n1233895932\nBogota calle 80\nNo tengo restricciones medicas\nTransporte bicicleta'),
      expected: {
        fullName: 'Cristian David Mahecha Puentes',
        documentType: 'CC',
        documentNumber: '1233895932',
        medicalRestrictions: 'Sin restricciones médicas',
        transportMode: 'Bicicleta'
      }
    },
    {
      input: parseNaturalData('Desde Soacha, tengo carro y no tengo restricciones medicas'),
      expected: {
        locality: 'Soacha Cundinamarca',
        medicalRestrictions: 'Sin restricciones médicas',
        transportMode: 'Carro'
      }
    }
  ];

  for (const { input, expected } of cases) {
    assert.deepEqual(normalizeCandidateFields(input), expected);
  }
});

test('transportMode.js puede importarse sin imports de parches con efectos laterales', async () => {
  const source = fs.readFileSync('src/services/transportMode.js', 'utf8');
  assert.doesNotMatch(source, /dispatchWorkerExitReasonSafePatch|dispatchWhatsappConfirmationPatch/);

  const module = await import(`../src/services/transportMode.js?pure-check=${Date.now()}`);
  assert.equal(module.normalizeTransportMode('moto'), 'Moto');
});
