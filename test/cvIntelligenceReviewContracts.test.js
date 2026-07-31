import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupCandidateReviewResults,
  reviewVacancyCandidates
} from '../src/services/cvIntelligence.js';

function structuredResponse(parsed) {
  return {
    data: {
      output: [{ content: [{ parsed }] }]
    }
  };
}

test('el análisis combina requisitos de vacante, texto del coordinador, HV y registro sin mezclar fuentes', async () => {
  const requests = [];
  const vacancy = {
    id: 'vacancy-cv-review',
    title: 'Líder de operación',
    city: 'Medellín',
    requirements: 'Técnico o tecnólogo y mínimo 12 meses coordinando personal operativo.',
    roleDescription: 'Coordina cargue, descargue e inventarios.'
  };
  const candidate = {
    id: 'candidate-cv-review',
    fullName: 'Persona de Prueba',
    phone: '3001234567',
    documentType: 'CC',
    documentNumber: '123456789',
    age: 31,
    gender: 'FEMALE',
    transportMode: 'Moto',
    locality: 'La Estrella',
    neighborhood: null,
    zone: null,
    cvStorageKey: 'candidates/candidate-cv-review/hv.pdf',
    cvOriginalName: 'hoja-de-vida.pdf',
    cvMimeType: 'application/pdf',
    vacancy,
    attachmentAnalyses: [{
      id: 'analysis-cv-review',
      classification: 'CV_VALID',
      confidence: 0.93,
      summary: 'Experiencia operativa e inventarios.',
      rawResponse: {
        documentReference: 'storage:candidates/candidate-cv-review/hv.pdf',
        extracted: {
          city: 'Medellín',
          locality: 'La Estrella',
          experienceSummary: 'Dos años coordinando auxiliares de bodega y controlando inventarios.',
          lastRole: 'Líder de operación',
          educationSummary: 'Tecnólogo en logística',
          estimatedExperienceMonths: 24,
          skills: ['Inventarios', 'Excel', 'Manejo de personal'],
          certifications: ['Trabajo seguro'],
          experience: [{
            role: 'Líder de operación',
            company: 'Empresa de prueba',
            duration: '2 años',
            responsibilities: ['Coordinar personal', 'Controlar inventarios']
          }]
        }
      }
    }]
  };

  const prisma = {
    vacancy: {
      findUnique: async ({ where }) => where.id === vacancy.id ? vacancy : null
    },
    candidate: {
      findMany: async () => [candidate]
    }
  };

  const desiredProfile = 'Busco experiencia coordinando cargue y descargue, manejo de Excel y conocimiento de SAP.';
  const openAiPost = async (payload) => {
    requests.push(payload);
    if (requests.length === 1) {
      return structuredResponse({
        summary: 'Perfil operativo con liderazgo, inventarios y herramientas de oficina.',
        criteria: [
          {
            id: 'leadership',
            label: 'Manejo de personal',
            description: 'Experiencia coordinando personal operativo.',
            priority: 'REQUIRED',
            minimumMonths: 12,
            keywords: ['manejo de personal', 'coordinación']
          },
          {
            id: 'sap',
            label: 'SAP',
            description: 'Conocimiento de SAP solicitado por el coordinador.',
            priority: 'PREFERRED',
            minimumMonths: null,
            keywords: ['SAP']
          }
        ],
        warnings: []
      });
    }
    return structuredResponse({
      results: [{
        candidateId: candidate.id,
        level: 'STRONG',
        score: 88,
        reasons: ['Cumple experiencia mínima y evidencia liderazgo operativo.'],
        evidence: ['Dos años coordinando auxiliares de bodega.', 'Registro: medio de transporte Moto.'],
        gaps: ['Confirmar conocimiento de SAP.']
      }]
    });
  };

  const result = await reviewVacancyCandidates(
    prisma,
    { vacancyId: vacancy.id, desiredProfile },
    { openAiPost, model: 'test-cv-model' }
  );

  assert.equal(result.ok, true);
  assert.equal(result.stats.total, 1);
  assert.equal(result.stats.strong, 1);
  assert.equal(requests.length, 2);

  const profilePayload = JSON.parse(requests[0].input[1].content[0].text);
  assert.equal(profilePayload.vacancy.requirements, vacancy.requirements);
  assert.equal(profilePayload.vacancy.roleDescription, vacancy.roleDescription);
  assert.equal(profilePayload.coordinatorRequest, desiredProfile);
  assert.match(requests[0].input[0].content[0].text, /No agregues requisitos/i);
  assert.match(requests[0].input[0].content[0].text, /vacante o en la solicitud del coordinador/i);

  const matchPayload = JSON.parse(requests[1].input[1].content[0].text);
  assert.equal(matchPayload.interpretedProfile.criteria[0].label, 'Manejo de personal');
  assert.equal(matchPayload.candidates[0].sources.cv.estimatedExperienceMonths, 24);
  assert.deepEqual(matchPayload.candidates[0].sources.cv.skills, ['Inventarios', 'Excel', 'Manejo de personal']);
  assert.equal(matchPayload.candidates[0].sources.registration.transportMode, 'MOTO');
  assert.equal(matchPayload.candidates[0].sources.registration.residence, 'La Estrella');
  assert.equal(Object.hasOwn(matchPayload.candidates[0], 'age'), false);
  assert.equal(Object.hasOwn(matchPayload.candidates[0], 'gender'), false);
  assert.match(requests[1].input[0].content[0].text, /usa la hoja de vida/i);
  assert.match(requests[1].input[0].content[0].text, /medio de transporte y residencia/i);
});

test('la agrupación conserva el nivel y ordena cada sección de mayor a menor porcentaje', () => {
  const candidate = (id) => ({ id, fullName: id });
  const result = (id, level, score) => ({
    candidate: candidate(id),
    match: { candidateId: id, level, score, reasons: [], evidence: [], gaps: [] },
    manualReason: null
  });
  const manual = { candidate: candidate('manual'), match: null, manualReason: 'Documento ilegible' };

  const groups = groupCandidateReviewResults([
    result('strong-low', 'STRONG', 76),
    result('strong-high', 'STRONG', 95),
    result('possible-low', 'POSSIBLE', 48),
    result('possible-high', 'POSSIBLE', 70),
    result('low-low', 'LOW', 8),
    result('low-high', 'LOW', 33),
    manual
  ]);

  assert.deepEqual(groups.strong.map((item) => item.candidate.id), ['strong-high', 'strong-low']);
  assert.deepEqual(groups.possible.map((item) => item.candidate.id), ['possible-high', 'possible-low']);
  assert.deepEqual(groups.low.map((item) => item.candidate.id), ['low-high', 'low-low']);
  assert.deepEqual(groups.manual.map((item) => item.candidate.id), ['manual']);
});
