import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidateData } from '../src/infrastructure/llm/aiExtractionService.js';
import { interpretLorrenSupportTicket } from '../src/services/lorrenSupportTicketInterpreter.js';

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

test('rechaza una asignación cuando rol y ciudad empatan en más de una vacante', async () => {
  const ambiguousVacancies = [
    { id: 'vac-bodega-am', role: 'Auxiliar de bodega', title: 'Auxiliar de bodega mañana', city: 'Bogotá' },
    { id: 'vac-bodega-pm', role: 'Auxiliar de bodega', title: 'Auxiliar de bodega tarde', city: 'Bogotá' }
  ];
  const result = await extractCandidateData(
    'Vi el anuncio de auxiliar de bodega en Bogotá',
    ['vacancyId'],
    { activeVacancies: ambiguousVacancies, candidateCity: 'Bogotá', candidateSummary: {} },
    completion({
      intent: 'apply_intent',
      vacancyId: 'vac-bodega-am',
      roleHint: 'auxiliar de bodega',
      cityHint: 'Bogotá',
      fields: {},
      fieldEvidence: {},
      turnType: 'PROVIDE_DATA'
    })
  );

  assert.equal(result.extractedFields, undefined);
  assert.deepEqual(result.detectedFields, {
    roleHint: 'auxiliar de bodega',
    cityHint: 'Bogotá'
  });
});

test('un id de vacante inactiva no desplaza la coincidencia activa disponible', async () => {
  const result = await extractCandidateData(
    'Auxiliar de bodega en Ibagué',
    ['vacancyId'],
    { activeVacancies: [vacancies[0]], candidateCity: 'Ibagué', candidateSummary: {} },
    completion({
      intent: 'apply_intent',
      vacancyId: 'vac-inactiva-especifica',
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

 test('la interpretación de tickets restringe el módulo a las pestañas existentes', async () => {
  const result = await interpretLorrenSupportTicket('El informe inventó un módulo nuevo', {
    apiKey: null
  });

  assert.equal(result.module, 'RECLUTAMIENTO');
});


test('intérprete de tickets pide implicaciones necesarias y separa incógnitas de negocio', async () => {
  let requestBody;
  const parsed = {
    title: 'Configurar tarifas de producción',
    module: 'DESPACHO',
    type: 'MEJORA',
    summary: 'Configurar tarifas según modalidad.',
    currentBehavior: null,
    expectedBehavior: 'La configuración debe ser coherente con la modalidad.',
    suggestedScope: 'Modelar la modalidad y sus tarifas.',
    functionalImplications: ['La modalidad debe persistirse y validarse antes de aplicar tarifas.'],
    businessUnknowns: [],
    confidence: 'ALTA',
    suggestedPriority: 'NORMAL'
  };
  const result = await interpretLorrenSupportTicket('Si es producción debe permitir concepto y tarifa.', {
    apiKey: 'test-key',
    httpClient: {
      async post(_url, body) {
        requestBody = body;
        return { data: { output: [{ content: [{ parsed }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } };
      }
    }
  });

  assert.deepEqual(result.functionalImplications, parsed.functionalImplications);
  assert.deepEqual(result.businessUnknowns, []);
  const systemText = requestBody.input[0].content[0].text;
  assert.match(systemText, /condiciones funcionales necesarias/i);
  assert.match(systemText, /inspeccionando el sistema/i);
  assert.match(systemText, /dos o más resultados plausibles/i);
});
