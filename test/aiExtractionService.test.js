import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidateData } from '../src/infrastructure/llm/aiExtractionService.js';

const vacancies = [
  { id: 'vac-ibague', role: 'Cargue y Descargue', title: 'Auxiliar de bodega', city: 'Ibagué' },
  { id: 'vac-barranquilla', role: 'Cargue y Descargue', title: 'Auxiliar logístico', city: 'Barranquilla' }
];

function completion(content, inspectRequest = () => {}) {
  return {
    apiKey: 'test-key',
    model: 'test-model',
    httpClient: {
      async post(url, body, config) {
        inspectRequest(url, body, config);
        return { data: { choices: [{ message: { content: JSON.stringify(content) } }] } };
      }
    }
  };
}

test('resuelve una vacante solo al cruzar semánticamente rol y ciudad', async () => {
  const result = await extractCandidateData(
    'Me interesa lo de bodega y tengo 27 años',
    ['vacancyId', 'age'],
    {
      activeVacancies: vacancies,
      candidateCity: 'Ibagué',
      candidateSummary: { locality: 'Ibagué' }
    },
    completion({
      intent: 'provide_data',
      vacancyId: 'vac-ibague',
      roleHint: 'bodega',
      cityHint: 'Ibagué',
      fields: { age: 27 },
      fieldEvidence: {
        age: { snippet: 'tengo 27 años', confidence: 0.99, source: 'ai', relation: 'SELF_ATTRIBUTE' }
      },
      turnType: 'PROVIDE_DATA'
    }, (url, body, config) => {
      assert.match(url, /chat\/completions$/);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.match(body.messages[0].content, /cruzar SIEMPRE cargo Y ciudad/);
      assert.match(body.messages[0].content, /vac-ibague/);
      assert.match(body.messages[0].content, /Ibagué/);
      assert.equal(config.headers.Authorization, 'Bearer test-key');
    })
  );

  assert.deepEqual(result, {
    intent: 'PROVIDE_CANDIDATE_DATA',
    extractedFields: {
      age: 27,
      vacancyId: 'vac-ibague'
    },
    detectedFields: { roleHint: 'bodega', cityHint: 'Ibagué' }
  });
});

test('rechaza el vacancyId del modelo cuando la ciudad no coincide', async () => {
  const result = await extractCandidateData(
    'Vi el anuncio de bodega en Ibagué',
    ['vacancyId'],
    { activeVacancies: vacancies, candidateCity: null, candidateSummary: {} },
    completion({
      intent: 'apply_intent',
      vacancyId: 'vac-barranquilla',
      roleHint: 'bodega',
      cityHint: 'Ibagué',
      fields: {},
      fieldEvidence: {},
      turnType: 'PROVIDE_DATA'
    })
  );

  assert.equal(result.extractedFields, undefined);
  assert.deepEqual(result.detectedFields, { roleHint: 'bodega', cityHint: 'Ibagué' });
});

test('mantiene vacancyId nulo cuando todavía no existe una ciudad', async () => {
  const result = await extractCandidateData(
    'Me interesa trabajar en bodega',
    ['vacancyId'],
    { activeVacancies: vacancies, candidateCity: null, candidateSummary: {} },
    completion({
      intent: 'apply_intent',
      vacancyId: 'vac-ibague',
      roleHint: 'bodega',
      cityHint: null,
      fields: {},
      fieldEvidence: {},
      turnType: 'PROVIDE_DATA'
    })
  );

  assert.equal(result.extractedFields, undefined);
  assert.deepEqual(result.detectedFields, { roleHint: 'bodega' });
});

test('no invoca NLU cuando no hay texto o campos pendientes', async () => {
  let calls = 0;
  const dependencies = {
    apiKey: 'test-key',
    httpClient: { async post() {
      calls += 1;
      return {};
    } }
  };

  assert.equal(await extractCandidateData('', ['age'], {}, dependencies), null);
  assert.equal(await extractCandidateData('Tengo 27', [], {}, dependencies), null);
  assert.equal(calls, 0);
});
