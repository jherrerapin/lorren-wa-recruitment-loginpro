import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { tryOpenAIParse, parseModelJson, summarizeOpenAIError, modelSupportsTemperature } from '../src/services/aiParser.js';

let previousExtractorFlag;

test.beforeEach(() => {
  previousExtractorFlag = process.env.FF_RESPONSES_EXTRACTOR;
  process.env.FF_RESPONSES_EXTRACTOR = 'false';
});

test.afterEach(() => {
  if (previousExtractorFlag === undefined) delete process.env.FF_RESPONSES_EXTRACTOR;
  else process.env.FF_RESPONSES_EXTRACTOR = previousExtractorFlag;
});

test('parseModelJson handles fenced json', () => {
  const parsed = parseModelJson('```json\n{"intent":"apply_intent","fullName":"Ana"}\n```');
  assert.equal(parsed.intent, 'apply_intent');
  assert.equal(parsed.fullName, 'Ana');
});

test('los modelos GPT-5 omiten temperature cuando usan razonamiento por defecto', () => {
  assert.equal(modelSupportsTemperature('gpt-5.6-terra'), false);
  assert.equal(modelSupportsTemperature('gpt-5.6-luna'), false);
  assert.equal(modelSupportsTemperature('gpt-4o-mini'), true);
});

test('tryOpenAIParse returns ok with parsed fields from chat completions', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  const previousTemperature = process.env.OPENAI_TEMPERATURE;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'gpt-4.1-mini';
  delete process.env.OPENAI_TEMPERATURE;

  const originalPost = axios.post;
  t.after(() => {
    axios.post = originalPost;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
    if (previousTemperature === undefined) delete process.env.OPENAI_TEMPERATURE;
    else process.env.OPENAI_TEMPERATURE = previousTemperature;
  });

  axios.post = async (url, payload) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(payload.response_format.type, 'json_object');
    assert.equal(Object.hasOwn(payload, 'temperature'), false);
    return {
      data: {
        choices: [
          {
            message: {
              content: '{"intent":"apply_intent","fullName":"Juan Pérez","age":28}'
            }
          }
        ]
      }
    };
  };

  const result = await tryOpenAIParse('hola soy Juan');
  assert.equal(result.status, 'ok');
  assert.equal(result.intent, 'apply_intent');
  assert.equal(result.parsedFields.fullName, 'Juan Pérez');
  assert.equal(result.parsedFields.age, 28);
  assert.equal(result.model, 'gpt-4.1-mini');
  assert.equal(result.temperature_omitted, true);
});

test('tryOpenAIParse includes optional temperature only when model supports it', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  const previousTemperature = process.env.OPENAI_TEMPERATURE;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  process.env.OPENAI_TEMPERATURE = '0.4';

  const originalPost = axios.post;
  t.after(() => {
    axios.post = originalPost;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
    if (previousTemperature === undefined) delete process.env.OPENAI_TEMPERATURE;
    else process.env.OPENAI_TEMPERATURE = previousTemperature;
  });

  axios.post = async (_url, payload) => {
    assert.equal(payload.temperature, 0.4);
    return { data: { choices: [{ message: { content: '{"intent":"apply_intent"}' } }] } };
  };

  const result = await tryOpenAIParse('hola');
  assert.equal(result.status, 'ok');
  assert.equal(result.temperature_omitted, false);
  assert.equal(result.temperature_value, 0.4);
});

test('tryOpenAIParse returns safe summarized error', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  const originalPost = axios.post;
  t.after(() => {
    axios.post = originalPost;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  axios.post = async () => {
    const err = new Error('Request failed with status code 400');
    err.name = 'AxiosError';
    err.code = 'ERR_BAD_REQUEST';
    err.response = {
      status: 400,
      data: {
        error: {
          message: 'Invalid input structure'
        },
        api_key: 'sk-secret'
      }
    };
    throw err;
  };

  const result = await tryOpenAIParse('texto');
  assert.equal(result.status, 'error');
  assert.match(result.error.message, /HTTP 400/);
  assert.match(result.error.message, /Invalid input structure/);
  assert.doesNotMatch(result.error.message, /sk-secret/);
});

test('summarizeOpenAIError uses OpenAI message when available', () => {
  const summary = summarizeOpenAIError({
    name: 'AxiosError',
    code: 'ERR_BAD_REQUEST',
    message: 'Request failed',
    response: { status: 400, data: { error: { message: 'Bad format in input' } } }
  });

  assert.match(summary, /AxiosError/);
  assert.match(summary, /HTTP 400/);
  assert.match(summary, /Bad format in input/);
});
