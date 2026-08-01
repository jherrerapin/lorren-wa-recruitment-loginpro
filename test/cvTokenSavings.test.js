import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearCvIntelligenceCachesForTest,
  reviewVacancyCandidates
} from '../src/services/cvIntelligence.js';

function structuredResponse(parsed, usage = null) {
  return {
    data: {
      output: [{ content: [{ parsed }] }],
      ...(usage ? { usage } : {})
    }
  };
}

function vacancy() {
  return {
    id: 'vacancy-token-test',
    title: 'Líder de operación',
    city: 'Neiva',
    requirements: 'Técnico o tecnólogo con un año de experiencia logística y manejo de personal.',
    roleDescription: 'Coordina personal y operación logística.'
  };
}

function candidate(id, targetVacancy, overrides = {}) {
  const cvStorageKey = `candidates/${id}/hv.pdf`;
  return {
    id,
    vacancyId: targetVacancy.id,
    fullName: `Persona ${id}`,
    phone: `300${id}`,
    status: 'REGISTRADO',
    transportMode: 'Moto',
    locality: 'Neiva',
    neighborhood: null,
    zone: null,
    cvStorageKey,
    cvData: null,
    cvOriginalName: `${id}.pdf`,
    cvMimeType: 'application/pdf',
    updatedAt: new Date('2026-07-31T12:00:00.000Z'),
    vacancy: targetVacancy,
    attachmentAnalyses: [{
      id: `analysis-${id}`,
      classification: 'CV_VALID',
      confidence: 0.94,
      rawResponse: {
        documentReference: `storage:${cvStorageKey}`,
        extracted: {
          city: 'Neiva',
          locality: 'Neiva',
          experienceSummary: 'Experiencia en coordinación logística, inventarios y manejo de personal.',
          lastRole: 'Líder de operación',
          educationSummary: 'Tecnólogo en logística',
          estimatedExperienceMonths: 24,
          skills: Array.from({ length: 22 }, (_, index) => `Habilidad ${index + 1}`),
          certifications: Array.from({ length: 14 }, (_, index) => `Certificación ${index + 1}`),
          experience: Array.from({ length: 8 }, (_, index) => ({
            role: `Cargo ${index + 1}`,
            company: `Empresa ${index + 1}`,
            duration: '12 meses',
            responsibilities: Array.from({ length: 7 }, (_, item) => `Responsabilidad ${item + 1}`)
          }))
        }
      }
    }],
    ...overrides
  };
}

function profileResult() {
  return {
    summary: 'Perfil técnico o tecnológico con liderazgo logístico.',
    criteria: [{
      id: 'logistica',
      label: 'Experiencia logística',
      description: 'Experiencia relacionada con operación logística y manejo de personal.',
      priority: 'REQUIRED',
      minimumMonths: 12,
      keywords: ['logística', 'operación', 'personal']
    }],
    warnings: []
  };
}

function matchResult(candidateId, score = 88) {
  return {
    candidateId,
    level: score >= 75 ? 'STRONG' : 'POSSIBLE',
    score,
    reasons: ['Experiencia logística relacionada.'],
    evidence: ['Coordinación de personal e inventarios.'],
    gaps: []
  };
}

function persistentPrisma(targetVacancy, initialCandidates) {
  let candidates = [...initialCandidates];
  let candidateWhere = null;
  const profiles = new Map();
  const comparisons = new Map();
  const usage = [];
  const comparisonWrites = [];

  return {
    setCandidates(next) { candidates = [...next]; },
    stores: { profiles, comparisons, usage, comparisonWrites },
    getCandidateWhere() { return candidateWhere; },
    vacancy: {
      findUnique: async ({ where }) => where.id === targetVacancy.id ? targetVacancy : null
    },
    candidate: {
      findMany: async ({ where }) => {
        candidateWhere = where;
        return candidates;
      }
    },
    cvReviewProfile: {
      findUnique: async ({ where }) => profiles.get(where.fingerprint) || null,
      upsert: async ({ where, create, update }) => {
        const row = profiles.get(where.fingerprint)
          ? { ...profiles.get(where.fingerprint), ...update }
          : { ...create };
        profiles.set(where.fingerprint, row);
        return row;
      }
    },
    cvCandidateComparison: {
      findMany: async ({ where }) => {
        const fingerprints = new Set(where.fingerprint.in);
        return [...comparisons.values()].filter((row) => fingerprints.has(row.fingerprint));
      },
      upsert: async ({ where, create, update }) => {
        comparisonWrites.push({ where, create, update });
        const row = comparisons.get(where.fingerprint)
          ? { ...comparisons.get(where.fingerprint), ...update }
          : { ...create };
        comparisons.set(where.fingerprint, row);
        return row;
      }
    },
    cvAnalysisUsage: {
      create: async ({ data }) => {
        usage.push({ ...data });
        return data;
      }
    }
  };
}

const desiredProfile = 'Prioriza formación técnica o tecnológica, un año de logística y manejo de personal.';
const usage = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 600, cache_write_tokens: 50 },
  output_tokens: 120,
  output_tokens_details: { reasoning_tokens: 30 },
  total_tokens: 1120
};

test('filtra estados y una revisión persistida idéntica hace cero llamadas a OpenAI', async () => {
  clearCvIntelligenceCachesForTest();
  const targetVacancy = vacancy();
  const candidates = [candidate('one', targetVacancy), candidate('two', targetVacancy, { status: 'APROBADO' })];
  const prisma = persistentPrisma(targetVacancy, candidates);
  const requests = [];
  const openAiPost = async (payload) => {
    requests.push(payload);
    if (payload.text.format.name === 'loren_desired_candidate_profile') {
      return structuredResponse(profileResult(), usage);
    }
    const input = JSON.parse(payload.input[1].content[0].text);
    assert.equal(input.candidates[0].sources.cv.experience.length, 5);
    assert.equal(input.candidates[0].sources.cv.experience[0].responsibilities.length, 4);
    assert.equal(input.candidates[0].sources.cv.skills.length, 15);
    assert.equal(input.candidates[0].sources.cv.certifications.length, 10);
    assert.equal(typeof payload.prompt_cache_key, 'string');
    return structuredResponse({      results: input.candidates.map((item) => matchResult(item.candidateId))
    }, usage);
  };

  const first = await reviewVacancyCandidates(
    prisma,
    { vacancyId: targetVacancy.id, desiredProfile },
    { openAiPost, model: 'gpt-5.6-terra' }
  );
  assert.equal(first.ok, true);
  assert.deepEqual(prisma.getCandidateWhere().status.in, ['REGISTRADO', 'CONTACTADO', 'APROBADO']);
  assert.equal(requests.length, 2);
  assert.equal(prisma.stores.profiles.size, 1);
  assert.equal(prisma.stores.comparisons.size, 2);

  clearCvIntelligenceCachesForTest();
  requests.length = 0;
  const second = await reviewVacancyCandidates(
    prisma,
    { vacancyId: targetVacancy.id, desiredProfile },
    { openAiPost, model: 'gpt-5.6-terra' }
  );
  assert.equal(second.ok, true);
  assert.equal(requests.length, 0);
  assert.deepEqual(second.groups.strong.map((item) => item.candidate.id), ['one', 'two']);
});

test('un candidato nuevo procesa únicamente ese candidato y cambios relevantes invalidan su huella', async () => {
  clearCvIntelligenceCachesForTest();
  const targetVacancy = vacancy();
  const firstCandidate = candidate('existing', targetVacancy);
  const prisma = persistentPrisma(targetVacancy, [firstCandidate]);
  const requests = [];
  const openAiPost = async (payload) => {
    requests.push(payload);
    if (payload.text.format.name === 'loren_desired_candidate_profile') {
      return structuredResponse(profileResult());
    }
    const input = JSON.parse(payload.input[1].content[0].text);
    return structuredResponse({ results: input.candidates.map((item) => matchResult(item.candidateId)) });
  };

  await reviewVacancyCandidates(prisma, { vacancyId: targetVacancy.id, desiredProfile }, { openAiPost });
  clearCvIntelligenceCachesForTest();
  requests.length = 0;
  const newCandidate = candidate('new', targetVacancy, { status: 'CONTACTADO' });
  prisma.setCandidates([firstCandidate, newCandidate]);
  await reviewVacancyCandidates(prisma, { vacancyId: targetVacancy.id, desiredProfile }, { openAiPost });
  assert.equal(requests.length, 1);
  const newInput = JSON.parse(requests[0].input[1].content[0].text);
  assert.deepEqual(newInput.candidates.map((item) => item.candidateId), ['new']);

  clearCvIntelligenceCachesForTest();
  requests.length = 0;
  prisma.setCandidates([{ ...firstCandidate, transportMode: 'Bicicleta' }, newCandidate]);
  await reviewVacancyCandidates(prisma, { vacancyId: targetVacancy.id, desiredProfile }, { openAiPost });
  assert.equal(requests.length, 1);
  const changedInput = JSON.parse(requests[0].input[1].content[0].text);
  assert.deepEqual(changedInput.candidates.map((item) => item.candidateId), ['existing']);
});

test('no persiste una comparación parcial y registra usage sin PII', async () => {
  clearCvIntelligenceCachesForTest();
  const targetVacancy = vacancy();
  const candidates = [candidate('partial-one', targetVacancy), candidate('partial-two', targetVacancy)];
  const prisma = persistentPrisma(targetVacancy, candidates);
  const openAiPost = async (payload) => {
    if (payload.text.format.name === 'loren_desired_candidate_profile') {
      return structuredResponse(profileResult(), usage);
    }
    const input = JSON.parse(payload.input[1].content[0].text);
    if (input.candidates.length === 1) return structuredResponse({ results: [] }, usage);
    return structuredResponse({ results: [matchResult(input.candidates[0].candidateId)] }, usage);
  };

  const result = await reviewVacancyCandidates(
    prisma,
    { vacancyId: targetVacancy.id, desiredProfile },
    { openAiPost }
  );
  assert.equal(result.ok, true);
  assert.equal(prisma.stores.comparisons.size, 0);
  assert.equal(prisma.stores.comparisonWrites.length, 0);
  assert.ok(prisma.stores.usage.length >= 2);
  for (const row of prisma.stores.usage) {
    assert.equal(row.inputTokens, 1000);
    assert.equal(row.cachedInputTokens, 600);
    assert.equal(row.cacheWriteTokens, 50);
    assert.equal(row.outputTokens, 120);
    assert.equal(row.reasoningTokens, 30);
    assert.equal(row.totalTokens, 1120);
    assert.equal(Object.hasOwn(row, 'prompt'), false);
    assert.equal(Object.hasOwn(row, 'response'), false);
    assert.equal(Object.hasOwn(row, 'phone'), false);
    assert.equal(Object.hasOwn(row, 'documentNumber'), false);
  }
});
