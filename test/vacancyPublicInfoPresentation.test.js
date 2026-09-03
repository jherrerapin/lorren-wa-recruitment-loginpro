import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfessionalVacancyPresentation } from '../src/services/vacancyPublicInfo.js';

function buildVacancy(overrides = {}) {
  return {
    id: 'TEST-VACANCY-PUBLIC-INFO',
    title: 'Auxiliar Cargue y Descargue Siberia',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operationAddress: 'Parques Logísticos Siberia, Metropolitano, Tierrapuerto, Celta',
    roleDescription: 'Cargue y descargue de mercancía',
    requirements: 'Experiencia mínima de 3 meses',
    conditions: 'Vinculación inmediata',
    requiredDocuments: 'Documento de identidad y hoja de vida',
    operation: { city: { name: 'Bogota' } },
    ...overrides
  };
}

test('la ficha inicial prioriza la zona de trabajo y no expone la ciudad administrativa cuando existe una ubicación específica', () => {
  const presentation = buildProfessionalVacancyPresentation(buildVacancy(), { includeInterestPrompt: true });

  assert.match(presentation, /\*Vacante: Auxiliar Cargue y Descargue Siberia\*/);
  assert.match(presentation, /\*Zona de trabajo:\* Parques Logísticos Siberia, Metropolitano, Tierrapuerto, Celta/);
  assert.doesNotMatch(presentation, /\*Ciudad:\*\s*Bogota/i);
  assert.match(presentation, /¿Te interesa continuar con esta vacante\?/i);
});

test('la ficha inicial no adelanta documentación aunque requiredDocuments esté configurado', () => {
  const presentation = buildProfessionalVacancyPresentation(buildVacancy());

  assert.doesNotMatch(presentation, /Documentación para el proceso/i);
  assert.doesNotMatch(presentation, /Documento de identidad y hoja de vida/i);
});

test('una vacante sin zona de trabajo conserva la ciudad como ubicación pública', () => {
  const presentation = buildProfessionalVacancyPresentation(buildVacancy({
    title: 'Auxiliar de operación',
    city: 'Neiva',
    operationAddress: '',
    requiredDocuments: null,
    operation: { city: { name: 'Neiva' } }
  }));

  assert.match(presentation, /\*Ciudad:\* Neiva/);
  assert.doesNotMatch(presentation, /\*Zona de trabajo:\*/);
});

test('la documentación puede incluirse de forma explícita para una etapa posterior sin duplicar la autoridad', () => {
  const presentation = buildProfessionalVacancyPresentation(buildVacancy(), { includeDocuments: true });

  assert.match(presentation, /\*Documentación para el proceso\*/);
  assert.match(presentation, /Documento de identidad y hoja de vida/);
});
