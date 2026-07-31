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

function cachedCandidateForReview(id, vacancy) {
  const storageKey = `candidates/${id}/hv.pdf`;
  return {
    id,
    fullName: `Persona ${id}`,
    phone: `300${id}`,
    vacancyId: vacancy.id,
    transportMode: 'Moto',
    locality: 'La Estrella',
    neighborhood: null,
    zone: null,
    cvStorageKey: storageKey,
    cvData: null,
    cvOriginalName: `${id}.pdf`,
    cvMimeType: 'application/pdf',
    updatedAt: new Date('2026-07-31T12:00:00.000Z'),
    vacancy,
    attachmentAnalyses: [{
      id: `analysis-${id}`,
      classification: 'CV_VALID',
      confidence: 0.9,
      summary: 'Hoja de vida legible.',
      rawResponse: {
        documentReference: `storage:${storageKey}`,
        extracted: {
          city: vacancy.city,
          locality: 'La Estrella',
          experienceSummary: 'Experiencia en operación logística y manejo de inventarios.',
          lastRole: 'Auxiliar de operación',
          educationSummary: 'Bachiller',
          estimatedExperienceMonths: 18,
          skills: ['Inventarios', 'Logística'],
          certifications: [],
          experience: []
        }
      }
    }]
  };
}

function interpretedOperationProfile() {
  return {
    summary: 'Perfil de operación logística.',
    criteria: [{
      id: 'operation',
      label: 'Experiencia logística',
      description: 'Experiencia relacionada con operación logística.',
      priority: 'REQUIRED',
      minimumMonths: null,
      keywords: ['logística', 'operación']
    }],
    warnings: []
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
  assert.match(requests[0].input[0].content[0].text, /vacante ni en la solicitud del coordinador/i);
  assert.match(requests[0].input[0].content[0].text, /significado y el contexto/i);

  const matchPayload = JSON.parse(requests[1].input[1].content[0].text);
  assert.equal(
    matchPayload.comparisonProfile.interpretedProfile.criteria[0].label,
    'Manejo de personal'
  );
  assert.equal(matchPayload.comparisonProfile.vacancy.requirements, vacancy.requirements);
  assert.equal(matchPayload.comparisonProfile.coordinatorRequest, desiredProfile);
  assert.equal(matchPayload.candidates[0].sources.cv.estimatedExperienceMonths, 24);
  assert.deepEqual(matchPayload.candidates[0].sources.cv.skills, ['Inventarios', 'Excel', 'Manejo de personal']);
  assert.equal(matchPayload.candidates[0].sources.registration.transportMode, 'Moto');
  assert.equal(matchPayload.candidates[0].sources.registration.residence, 'La Estrella');
  assert.equal(Object.hasOwn(matchPayload.candidates[0], 'age'), false);
  assert.equal(Object.hasOwn(matchPayload.candidates[0], 'gender'), false);
  assert.match(requests[1].input[0].content[0].text, /usa la hoja de vida/i);
  assert.match(requests[1].input[0].content[0].text, /medio de transporte y residencia/i);
  assert.match(requests[1].input[0].content[0].text, /significado y contexto/i);
});

test('un fallo completo del lote usa un único reintento y no genera llamadas individuales masivas', async () => {
  const requests = [];
  const vacancy = {
    id: 'vacancy-batch-failure',
    title: 'Auxiliar de operación',
    city: 'Bogotá',
    requirements: 'Experiencia relacionada con operación logística.',
    roleDescription: 'Apoya cargue, descargue e inventarios.'
  };
  const candidates = Array.from(
    { length: 8 },
    (_, index) => cachedCandidateForReview(`batch-${index + 1}`, vacancy)
  );
  const prisma = {
    vacancy: {
      findUnique: async () => vacancy
    },
    candidate: {
      findMany: async () => candidates
    }
  };
  const openAiPost = async (payload) => {
    requests.push(payload);
    if (payload.text.format.name === 'loren_desired_candidate_profile') {
      return structuredResponse(interpretedOperationProfile());
    }
    throw new Error('simulated comparison timeout');
  };

  const result = await reviewVacancyCandidates(
    prisma,
    {
      vacancyId: vacancy.id,
      desiredProfile: 'Prioriza experiencia equivalente en cargue, descargue o inventarios.'
    },
    { openAiPost, model: 'test-cv-model' }
  );

  const matchRequests = requests.filter(
    (payload) => payload.text.format.name === 'loren_candidate_profile_matches'
  );
  assert.equal(requests.length, 3);
  assert.equal(matchRequests.length, 2);
  assert.equal(matchRequests.every((payload) => {
    const input = JSON.parse(payload.input[1].content[0].text);
    return input.candidates.length === candidates.length;
  }), true);
  assert.equal(result.stats.readable, candidates.length);
  assert.equal(result.stats.manual, candidates.length);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /único reintento controlado/i);
  assert.equal(
    result.groups.manual.every((item) => /comparación automática del lote/i.test(item.manualReason)),
    true
  );
});

test('los lotes comparten un máximo global de tres reintentos individuales', async () => {
  const requests = [];
  const vacancy = {
    id: 'vacancy-shared-retry-budget',
    title: 'Auxiliar de operación',
    city: 'Bogotá',
    requirements: 'Experiencia relacionada con operación logística.',
    roleDescription: 'Apoya cargue, descargue e inventarios.'
  };
  const candidates = Array.from(
    { length: 35 },
    (_, index) => cachedCandidateForReview(`shared-${index + 1}`, vacancy)
  );
  const prisma = {
    vacancy: {
      findUnique: async () => vacancy
    },
    candidate: {
      findMany: async () => candidates
    }
  };
  const openAiPost = async (payload) => {
    requests.push(payload);
    if (payload.text.format.name === 'loren_desired_candidate_profile') {
      return structuredResponse(interpretedOperationProfile());
    }
    const input = JSON.parse(payload.input[1].content[0].text);
    if (input.candidates.length !== 1) {
      return structuredResponse({ results: [] });
    }
    const candidateId = input.candidates[0].candidateId;
    return structuredResponse({
      results: [{
        candidateId,
        level: 'LOW',
        score: 20,
        reasons: ['La información disponible es limitada.'],
        evidence: ['Experiencia operativa general.'],
        gaps: ['Falta confirmar experiencia específica.']
      }]
    });
  };

  const result = await reviewVacancyCandidates(
    prisma,
    {
      vacancyId: vacancy.id,
      desiredProfile: 'Prioriza experiencia equivalente en cargue, descargue o inventarios.'
    },
    { openAiPost, model: 'test-cv-model' }
  );

  const matchRequests = requests.filter(
    (payload) => payload.text.format.name === 'loren_candidate_profile_matches'
  );
  const individualRequests = matchRequests.filter((payload) => {
    const input = JSON.parse(payload.input[1].content[0].text);
    return input.candidates.length === 1;
  });
  assert.equal(individualRequests.length, 3);
  assert.equal(result.stats.low, 3);
  assert.equal(result.stats.manual, 32);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /respuestas válidas omitieron perfiles/i);
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
