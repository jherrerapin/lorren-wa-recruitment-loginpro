import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearCvIntelligenceCachesForTest,
  groupCandidateReviewResults,
  reviewVacancyCandidates
} from '../src/services/cvIntelligence.js';
import { renderCvAnalysisPageForTest } from '../src/routes/lorenV2CvAnalysis.js';

beforeEach(() => {
  clearCvIntelligenceCachesForTest();
});

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

function interpretedOperationProfile(overrides = {}) {
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
    warnings: [],
    ...overrides
  };
}

function reviewPrisma(vacancy, candidates) {
  return {
    vacancy: {
      findUnique: async ({ where } = {}) => !where || where.id === vacancy.id ? vacancy : null
    },
    candidate: {
      findMany: async () => candidates
    }
  };
}

function matchResult(candidateId, { level = 'STRONG', score = 88 } = {}) {
  return {
    candidateId,
    level,
    score,
    reasons: ['Cumple experiencia relacionada con la operación.'],
    evidence: ['Experiencia en operación logística e inventarios.'],
    gaps: []
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
    ...cachedCandidateForReview('candidate-cv-review', vacancy),
    fullName: 'Persona de Prueba',
    phone: '3001234567',
    documentType: 'CC',
    documentNumber: '123456789',
    age: 31,
    gender: 'FEMALE',
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
    reviewPrisma(vacancy, [candidate]),
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
  assert.equal(matchPayload.comparisonProfile.interpretedProfile.criteria[0].label, 'Manejo de personal');
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
  const openAiPost = async (payload) => {
    requests.push(payload);
    if (payload.text.format.name === 'loren_desired_candidate_profile') {
      return structuredResponse(interpretedOperationProfile());
    }
    throw new Error('simulated comparison timeout');
  };

  const result = await reviewVacancyCandidates(
    reviewPrisma(vacancy, candidates),
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

test('el fallo técnico del último lote unitario consume el presupuesto global de tres reintentos', async () => {
  const requests = [];
  const singleRequestCounts = new Map();
  const vacancy = {
    id: 'vacancy-unit-batch-budget',
    title: 'Auxiliar de operación',
    city: 'Bogotá',
    requirements: 'Experiencia relacionada con operación logística.',
    roleDescription: 'Apoya cargue, descargue e inventarios.'
  };
  const candidates = Array.from(
    { length: 13 },
    (_, index) => cachedCandidateForReview(`unit-${index + 1}`, vacancy)
  );
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
    const requestCount = (singleRequestCounts.get(candidateId) || 0) + 1;
    singleRequestCounts.set(candidateId, requestCount);
    if (candidateId === 'unit-13' && requestCount === 1) {
      throw new Error('simulated unit batch timeout');
    }
    return structuredResponse({ results: [matchResult(candidateId, { level: 'LOW', score: 20 })] });
  };

  const result = await reviewVacancyCandidates(
    reviewPrisma(vacancy, candidates),
    {
      vacancyId: vacancy.id,
      desiredProfile: 'Prioriza experiencia equivalente en cargue, descargue o inventarios.'
    },
    { openAiPost, model: 'test-cv-model' }
  );

  const matchRequests = requests.filter(
    (payload) => payload.text.format.name === 'loren_candidate_profile_matches'
  );
  const singleCandidateRequests = matchRequests.filter((payload) => {
    const input = JSON.parse(payload.input[1].content[0].text);
    return input.candidates.length === 1;
  });
  assert.equal(singleCandidateRequests.length, 2);
  assert.equal(result.stats.low, 1);
  assert.equal(result.stats.manual, 12);
  assert.equal(result.warnings.length, 1);
});

test('dos revisiones idénticas reutilizan una comparación completa y conservan el resultado', async () => {
  const requests = [];
  let matchCalls = 0;
  const vacancy = {
    id: 'vacancy-stable-cache',
    title: 'Líder de operación',
    city: 'Neiva',
    requirements: 'Mínimo un año en operaciones logísticas y manejo de personal.',
    roleDescription: 'Coordina personal y operación.'
  };
  const candidate = cachedCandidateForReview('stable-candidate', vacancy);
  const openAiPost = async (payload) => {
    requests.push(payload);
    if (payload.text.format.name === 'loren_desired_candidate_profile') {
      return structuredResponse(interpretedOperationProfile());
    }
    matchCalls += 1;
    return structuredResponse({
      results: [matchResult(candidate.id, matchCalls === 1
        ? { level: 'STRONG', score: 93 }
        : { level: 'LOW', score: 8 })]
    });
  };
  const input = {
    vacancyId: vacancy.id,
    desiredProfile: 'Busco técnico o tecnólogo con un año en logística y manejo de personal.'
  };
  const options = { openAiPost, model: 'test-stable-model' };
  const prisma = reviewPrisma(vacancy, [candidate]);

  const first = await reviewVacancyCandidates(prisma, input, options);
  const second = await reviewVacancyCandidates(prisma, input, options);

  assert.equal(first.stats.strong, 1);
  assert.equal(second.stats.strong, 1);
  assert.equal(second.groups.strong[0].match.score, 93);
  assert.equal(matchCalls, 1);
  assert.equal(requests.length, 2);
});

test('una respuesta parcial no se almacena y obliga nuevas consultas', async () => {
  let profileCalls = 0;
  let matchCalls = 0;
  const vacancy = {
    id: 'vacancy-partial-cache',
    title: 'Auxiliar de operación',
    city: 'Neiva',
    requirements: 'Experiencia logística.',
    roleDescription: 'Apoya la operación.'
  };
  const candidate = cachedCandidateForReview('partial-candidate', vacancy);
  const openAiPost = async (payload) => {
    if (payload.text.format.name === 'loren_desired_candidate_profile') {
      profileCalls += 1;
      return structuredResponse(interpretedOperationProfile());
    }
    matchCalls += 1;
    return structuredResponse({ results: [] });
  };
  const input = {
    vacancyId: vacancy.id,
    desiredProfile: 'Busco experiencia relacionada con operación logística.'
  };
  const options = { openAiPost, model: 'test-partial-model' };
  const prisma = reviewPrisma(vacancy, [candidate]);

  await reviewVacancyCandidates(prisma, input, options);
  await reviewVacancyCandidates(prisma, input, options);

  assert.equal(profileCalls, 1);
  assert.equal(matchCalls, 4);
});

test('el schema exige exactamente un resultado por candidato y limita el tamaño de la respuesta', async () => {
  const requests = [];
  const vacancy = {
    id: 'vacancy-schema-contract',
    title: 'Auxiliar de operación',
    city: 'Neiva',
    requirements: 'Experiencia logística.',
    roleDescription: 'Apoya operación e inventarios.'
  };
  const candidates = [
    cachedCandidateForReview('schema-1', vacancy),
    cachedCandidateForReview('schema-2', vacancy)
  ];
  const openAiPost = async (payload) => {
    requests.push(payload);
    if (payload.text.format.name === 'loren_desired_candidate_profile') {
      return structuredResponse(interpretedOperationProfile());
    }
    return structuredResponse({ results: candidates.map((candidate) => matchResult(candidate.id)) });
  };

  await reviewVacancyCandidates(
    reviewPrisma(vacancy, candidates),
    {
      vacancyId: vacancy.id,
      desiredProfile: 'Busco experiencia relacionada con operación logística.'
    },
    { openAiPost, model: 'test-schema-model' }
  );

  const matchRequest = requests.find(
    (payload) => payload.text.format.name === 'loren_candidate_profile_matches'
  );
  const resultsSchema = matchRequest.text.format.schema.properties.results;
  assert.equal(resultsSchema.minItems, 2);
  assert.equal(resultsSchema.maxItems, 2);
  assert.equal(resultsSchema.items.properties.reasons.maxItems, 4);
  assert.equal(resultsSchema.items.properties.evidence.maxItems, 5);
  assert.equal(resultsSchema.items.properties.gaps.maxItems, 4);
});

test('los operadores no ven diagnósticos técnicos y dev sí los conserva', () => {
  const warning = 'No fue posible ejecutar un lote después de un reintento controlado.';
  const interpretedWarning = 'La vacante está ubicada en Neiva y conviene validar disponibilidad de traslado.';
  const candidate = {
    id: 'manual-candidate',
    fullName: 'Persona Manual',
    phone: '3000000000'
  };
  const manualResult = {
    candidate,
    analysis: null,
    match: null,
    manualReason: 'No fue posible ejecutar la comparación automática del lote después de un reintento.'
  };
  const review = {
    ok: true,
    interpretedProfile: interpretedOperationProfile({ warnings: [interpretedWarning] }),
    modelUsed: 'gpt-5.6-terra',
    warnings: [warning],
    truncated: false,
    stats: { total: 1, readable: 1, strong: 0, possible: 0, low: 0, manual: 1 },
    groups: { strong: [], possible: [], low: [], manual: [manualResult] }
  };

  const operatorHtml = renderCvAnalysisPageForTest({
    req: { userRole: 'reclutador' },
    vacancies: [],
    review
  });
  assert.doesNotMatch(operatorHtml, /Modelo usado|gpt-|OpenAI|reintent|lote/i);
  assert.doesNotMatch(operatorHtml, /Neiva y conviene validar disponibilidad de traslado/i);
  assert.doesNotMatch(operatorHtml, /columnas editables para responsable/i);
  assert.match(operatorHtml, /Revísalo manualmente/i);

  const devHtml = renderCvAnalysisPageForTest({
    req: { userRole: 'dev' },
    vacancies: [],
    review
  });
  assert.match(devHtml, /Diagnóstico técnico/i);
  assert.match(devHtml, /gpt-5\.6-terra/i);
  assert.match(devHtml, /reintento controlado/i);
  assert.doesNotMatch(devHtml, /Neiva y conviene validar disponibilidad de traslado/i);
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
