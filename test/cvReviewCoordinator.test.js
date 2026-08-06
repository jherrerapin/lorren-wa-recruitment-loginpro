import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCvReviewCandidateWhere,
  calibrateCvReviewResult,
  colombiaRegistrationDayBounds,
  matchLevelFromScore,
  normalizeCvReviewDateRange,
  reviewVacancyCandidates
} from '../src/services/cvReviewCoordinator.js';
import { clearCvIntelligenceCachesForTest } from '../src/services/cvIntelligence.js';
import { renderCvAnalysisPageForTest } from '../src/routes/lorenV2CvAnalysis.js';

beforeEach(() => clearCvIntelligenceCachesForTest());

function structuredResponse(parsed) {
  return { data: { output: [{ content: [{ parsed }] }] } };
}

function cachedCandidate(vacancy) {
  const storageKey = 'candidates/candidate-range/cv.pdf';
  return {
    id: 'candidate-range',
    vacancyId: vacancy.id,
    fullName: 'Persona Rango',
    phone: '3001234567',
    documentType: 'CC',
    documentNumber: '123456789',
    createdAt: new Date('2026-07-15T14:30:00.000Z'),
    updatedAt: new Date('2026-08-01T14:30:00.000Z'),
    status: 'REGISTRADO',
    locality: 'La Estrella',
    neighborhood: null,
    zone: null,
    transportMode: 'Moto',
    cvStorageKey: storageKey,
    cvData: null,
    cvOriginalName: 'cv.pdf',
    cvMimeType: 'application/pdf',
    vacancy,
    attachmentAnalyses: [{
      id: 'analysis-range',
      classification: 'CV_VALID',
      confidence: 0.92,
      analysedAt: new Date('2026-07-16T12:00:00.000Z'),
      rawResponse: {
        documentReference: `storage:${storageKey}`,
        extracted: {
          city: vacancy.city,
          locality: 'La Estrella',
          experienceSummary: 'Dos años en operación logística e inventarios.',
          lastRole: 'Auxiliar logístico',
          educationSummary: 'Bachiller',
          estimatedExperienceMonths: 24,
          skills: ['Inventarios', 'Cargue y descargue'],
          certifications: [],
          experience: []
        }
      }
    }]
  };
}

function containsCreatedAtRange(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.createdAt?.gte || value.createdAt?.lte) return true;
  return Object.values(value).some(containsCreatedAtRange);
}

test('el rango usa días completos de Colombia y rechaza fechas imposibles o invertidas', () => {
  const bounds = colombiaRegistrationDayBounds('2026-07-10');
  assert.equal(bounds.start.toISOString(), '2026-07-10T05:00:00.000Z');
  assert.equal(bounds.end.toISOString(), '2026-07-11T04:59:59.999Z');

  const valid = normalizeCvReviewDateRange({ dateFrom: '2026-07-10', dateTo: '2026-07-10' });
  assert.equal(valid.ok, true);
  assert.equal(valid.createdAtWhere.gte.toISOString(), bounds.start.toISOString());
  assert.equal(valid.createdAtWhere.lte.toISOString(), bounds.end.toISOString());

  assert.equal(normalizeCvReviewDateRange({ dateFrom: '2026-02-31' }).reason, 'date_range_invalid');
  assert.equal(normalizeCvReviewDateRange({ dateFrom: '2026-07-12', dateTo: '2026-07-10' }).reason, 'date_range_inverted');
});

test('la vista previa usa los mismos estados, HV, acceso y createdAt que el análisis', () => {
  const dateRange = normalizeCvReviewDateRange({ dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  const where = buildCvReviewCandidateWhere({
    vacancyId: 'vacancy-range',
    accessWhere: { vacancy: { city: 'Medellín' } },
    dateRange
  });

  assert.equal(containsCreatedAtRange(where), true);
  assert.match(JSON.stringify(where), /REGISTRADO/);
  assert.match(JSON.stringify(where), /CONTACTADO/);
  assert.match(JSON.stringify(where), /APROBADO/);
  assert.match(JSON.stringify(where), /cvStorageKey/);
  assert.match(JSON.stringify(where), /vacancy-range/);
});

test('el rango se aplica antes del límite y la consulta se ordena por createdAt, no updatedAt', async () => {
  const vacancy = {
    id: 'vacancy-range',
    title: 'Auxiliar de operación',
    city: 'Medellín',
    requirements: 'Experiencia en operación logística.',
    roleDescription: 'Apoya inventarios, cargue y descargue.'
  };
  const candidate = cachedCandidate(vacancy);
  let candidateQuery = null;
  const prisma = {
    vacancy: { findUnique: async () => vacancy },
    candidate: {
      findMany: async (args) => {
        candidateQuery = args;
        return [candidate];
      }
    }
  };
  const requests = [];
  const openAiPost = async (payload) => {
    requests.push(payload);
    if (payload.text.format.name === 'loren_desired_candidate_profile') {
      return structuredResponse({
        summary: 'Perfil logístico.',
        criteria: [{
          id: 'logistica',
          label: 'Experiencia logística',
          description: 'Experiencia relacionada con la operación.',
          priority: 'REQUIRED',
          minimumMonths: null,
          keywords: ['logística']
        }],
        warnings: []
      });
    }
    return structuredResponse({
      results: [{
        candidateId: candidate.id,
        level: 'STRONG',
        score: 58,
        reasons: ['Tiene experiencia relacionada.'],
        evidence: ['Dos años en operación logística.'],
        gaps: ['Confirmar manejo de personal.']
      }]
    });
  };

  const review = await reviewVacancyCandidates(prisma, {
    vacancyId: vacancy.id,
    desiredProfile: 'Busco experiencia en logística, inventarios, cargue y descargue.',
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31'
  }, { openAiPost, model: 'test-cv-range-model' });

  assert.equal(review.ok, true);
  assert.equal(containsCreatedAtRange(candidateQuery.where), true);
  assert.deepEqual(candidateQuery.orderBy, [{ createdAt: 'desc' }, { id: 'asc' }]);
  assert.equal(candidateQuery.take, 121);
  assert.deepEqual(review.dateRange, {
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
    isActive: true
  });
  assert.equal(review.groups.possible[0].candidate.id, candidate.id);
  assert.equal(review.groups.possible[0].match.level, 'POSSIBLE');
  assert.equal(review.stats.strong, 0);
  assert.equal(review.stats.possible, 1);
  assert.equal(requests.length, 2);
});

test('el porcentaje siempre determina una categoría coherente', () => {
  assert.equal(matchLevelFromScore(75), 'STRONG');
  assert.equal(matchLevelFromScore(74.9), 'POSSIBLE');
  assert.equal(matchLevelFromScore(45), 'POSSIBLE');
  assert.equal(matchLevelFromScore(44.9), 'LOW');

  const calibrated = calibrateCvReviewResult({
    ok: true,
    results: [
      { candidate: { id: 'a' }, match: { level: 'LOW', score: 90 } },
      { candidate: { id: 'b' }, match: { level: 'STRONG', score: 50 } },
      { candidate: { id: 'c' }, match: null, manualReason: 'Manual' }
    ],
    stats: { readable: 2 }
  });
  assert.deepEqual(calibrated.groups.strong.map((item) => item.candidate.id), ['a']);
  assert.deepEqual(calibrated.groups.possible.map((item) => item.candidate.id), ['b']);
  assert.deepEqual(calibrated.groups.manual.map((item) => item.candidate.id), ['c']);
});

test('la pantalla ubica el filtro dentro de Análisis HV y explica que evita llamadas fuera del periodo', () => {
  const html = renderCvAnalysisPageForTest({
    req: {},
    vacancies: [{ id: 'vacancy-range', title: 'Auxiliar', city: 'Medellín' }],
    candidates: [],
    vacancyId: 'vacancy-range',
    dateRange: normalizeCvReviewDateRange({ dateFrom: '2026-07-01', dateTo: '2026-07-31' })
  });

  assert.match(html, /name="dateFrom" value="2026-07-01"/);
  assert.match(html, /name="dateTo" value="2026-07-31"/);
  assert.match(html, /fecha de registro del candidato/i);
  assert.match(html, /antes de leer documentos o consumir OpenAI/i);
  assert.match(html, /No hay candidatos elegibles con hoja de vida/i);
});

test('un rango inválido no consulta candidatos ni llama a OpenAI', async () => {
  let candidateQueries = 0;
  let aiCalls = 0;
  const review = await reviewVacancyCandidates({
    candidate: { findMany: async () => { candidateQueries += 1; return []; } }
  }, {
    vacancyId: 'vacancy-range',
    desiredProfile: 'Perfil suficientemente detallado para analizar.',
    dateFrom: '2026-08-10',
    dateTo: '2026-08-01'
  }, {
    openAiPost: async () => { aiCalls += 1; return null; }
  });

  assert.equal(review.ok, false);
  assert.equal(review.reason, 'date_range_inverted');
  assert.equal(candidateQueries, 0);
  assert.equal(aiCalls, 0);
});
