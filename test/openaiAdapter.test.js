import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { generateReply } from '../src/infrastructure/llm/openaiAdapter.js';

const FALLBACK = 'En este momento estoy procesando tu solicitud, dame un momento por favor.';

async function withOpenAiEnvironment(run) {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_REPLY_MODEL;
  const previousPost = axios.post;

  try {
    process.env.OPENAI_API_KEY = 'test-api-key';
    process.env.OPENAI_REPLY_MODEL = 'gpt-4o-mini-test';
    await run();
  } finally {
    axios.post = previousPost;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENAI_REPLY_MODEL;
    else process.env.OPENAI_REPLY_MODEL = previousModel;
  }
}

test('genera una respuesta breve a partir de la directiva y el contexto seguro', async () => {
  await withOpenAiEnvironment(async () => {
    let request = null;
    axios.post = async (...args) => {
      request = args;
      return {
        data: {
          choices: [{ message: { content: 'Claro, ¿en qué ciudad resides?' } }]
        }
      };
    };

    const reply = await generateReply(
      'ASK_FOR_CITY',
      {
        vacancyRole: 'Auxiliar de bodega',
        phone: '573001112233',
        fieldsToPersist: { documentNumber: '1000123456' }
      },
      {
        candidate: {
          id: 'candidate-1',
          facts: {
            fullName: 'Ana Pérez',
            vacancyCity: 'Bogotá',
            currentStep: 'COLLECTING_DATA',
            phone: '573001112233',
            documentNumber: '1000123456'
          }
        }
      }
    );

    assert.equal(reply, 'Claro, ¿en qué ciudad resides?');
    assert.equal(request[0], 'https://api.openai.com/v1/chat/completions');
    assert.equal(request[1].model, 'gpt-4o-mini-test');
    assert.match(request[1].messages[0].content, /Eres Lórren/);
    assert.match(request[1].messages[0].content, /No inventes datos/);
    assert.match(request[1].messages[0].content, /ASK_WHICH_FLYER_SEEN/);
    assert.match(request[1].messages[0].content, /qué cargo específico vio/);
    assert.match(request[1].messages[0].content, /No preguntes por experiencia/);
    assert.match(request[1].messages[0].content, /No listes vacantes activas/);

    const userPayload = JSON.parse(request[1].messages[1].content);
    assert.equal(userPayload.directive, 'ASK_FOR_CITY');
    assert.equal(userPayload.parameters.vacancyRole, 'Auxiliar de bodega');
    assert.equal(userPayload.candidate.fullName, 'Ana Pérez');
    assert.equal(userPayload.candidate.vacancyCity, 'Bogotá');
    assert.equal(userPayload.parameters.phone, undefined);
    assert.equal(userPayload.parameters.fieldsToPersist.documentNumber, undefined);
    assert.equal(userPayload.candidate.phone, undefined);
    assert.equal(userPayload.candidate.documentNumber, undefined);
    assert.match(request[2].headers.Authorization, /^Bearer /);
  });
});

test('usa el texto de contingencia cuando falta la configuración', async () => {
  await withOpenAiEnvironment(async () => {
    delete process.env.OPENAI_API_KEY;
    let called = false;
    axios.post = async () => {
      called = true;
    };

    assert.equal(await generateReply('ASK_FOR_CITY', {}, {}), FALLBACK);
    assert.equal(called, false);
  });
});

test('ASK_WHICH_FLYER_SEEN conserva la pregunta correcta si OpenAI no está disponible', async () => {
  await withOpenAiEnvironment(async () => {
    delete process.env.OPENAI_API_KEY;
    const reply = await generateReply('ASK_WHICH_FLYER_SEEN', {}, {});

    assert.match(reply, /soy Lórren, del equipo de selección de LoginPro/);
    assert.match(reply, /qué cargo viste en el anuncio/);
    assert.doesNotMatch(reply, /experiencia|vacantes activas/i);
  });
});

test('usa el texto de contingencia ante rechazo o respuesta vacía de la API', async () => {
  await withOpenAiEnvironment(async () => {
    axios.post = async () => {
      throw new Error('provider unavailable');
    };
    assert.equal(await generateReply('ASK_FOR_CITY', {}, {}), FALLBACK);

    axios.post = async () => ({ data: { choices: [{ message: { content: '   ' } }] } });
    assert.equal(await generateReply('ASK_FOR_CITY', {}, {}), FALLBACK);
  });
});

test('una directiva inválida tampoco rompe el proceso', async () => {
  await withOpenAiEnvironment(async () => {
    assert.equal(await generateReply('   ', {}, {}), FALLBACK);
  });
});
