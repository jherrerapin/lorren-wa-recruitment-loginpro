import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { getHardeningFlags, isFeatureEnabled } from '../src/services/featureFlags.js';
import { tryOpenAIParse } from '../src/services/aiParser.js';

const HARDENING_FLAG_NAMES = [
  'FF_RESPONSES_EXTRACTOR',
  'FF_POLICY_LAYER',
  'FF_POSTGRES_JOB_QUEUE',
  'FF_ATTACHMENT_ANALYZER',
  'FF_SEMANTIC_SHORT_MEMORY',
  'FF_ASYNC_ADMIN_MEDIA_FORWARD'
];

function snapshotEnv(names = []) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot = {}) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test('los defaults canónicos reflejan el runtime del extractor y mantienen apagados los demás flags', () => {
  const previous = snapshotEnv(HARDENING_FLAG_NAMES);
  try {
    for (const name of HARDENING_FLAG_NAMES) delete process.env[name];

    assert.equal(isFeatureEnabled('FF_RESPONSES_EXTRACTOR'), true);
    assert.deepEqual(getHardeningFlags(), {
      responsesExtractor: true,
      policyLayer: false,
      postgresJobQueue: false,
      attachmentAnalyzer: false,
      semanticShortMemory: false,
      asyncAdminMediaForward: false
    });

    process.env.FF_RESPONSES_EXTRACTOR = 'false';
    assert.equal(isFeatureEnabled('FF_RESPONSES_EXTRACTOR'), false);
    assert.equal(getHardeningFlags().responsesExtractor, false);
  } finally {
    restoreEnv(previous);
  }
});

test('tryOpenAIParse usa Responses API cuando FF_RESPONSES_EXTRACTOR no está definido', async () => {
  const previous = snapshotEnv(['FF_RESPONSES_EXTRACTOR', 'OPENAI_API_KEY']);
  const originalPost = axios.post;
  delete process.env.FF_RESPONSES_EXTRACTOR;
  process.env.OPENAI_API_KEY = 'test-key';

  axios.post = async (url) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    return {
      data: {
        output: [{
          content: [{
            parsed: {
              turnType: 'PROVIDE_DATA',
              fields: { age: 28 },
              fieldEvidence: {
                age: { snippet: 'tengo 28 años', confidence: 0.99, source: 'candidate_message' }
              },
              conflicts: [],
              attachment: { mentioned: false, kindHint: null },
              replyIntent: 'continue_flow'
            }
          }]
        }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      }
    };
  };

  try {
    const result = await tryOpenAIParse('tengo 28 años');
    assert.equal(result.status, 'ok');
    assert.equal(result.parsedFields.age, 28);
    assert.equal(result.intent, 'continue_flow');
  } finally {
    axios.post = originalPost;
    restoreEnv(previous);
  }
});
