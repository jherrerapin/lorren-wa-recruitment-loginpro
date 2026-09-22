import axios from 'axios';
import { LEAD_ORIGIN_SCHEMA } from '../ai/leadOriginSchema.js';
import { OPENAI_EXTRACTION_MODEL } from './openAiModelConfig.js';

const URL = 'https://api.openai.com/v1/responses';
const MODEL = OPENAI_EXTRACTION_MODEL;

function parseOutput(data = {}) {
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.parsed && typeof part.parsed === 'object') return part.parsed;
      if (typeof part?.text === 'string') {
        try { return JSON.parse(part.text); } catch {}
      }
    }
  }
  return null;
}

export async function classifyLeadOrigin(text = '') {
  if (!process.env.OPENAI_API_KEY) return null;
  const payload = {
    model: MODEL,
    input: [
      {
        role: 'system',
        content: [{
          type: 'input_text',
          text: 'Classify lead origin semantically. PERSON is valid only when the message explicitly states that an identifiable person referred, recommended, invited, shared the opportunity with, or otherwise directly originated the contact. Experience, desired job, employer names, roles, cities, greetings, or ordinary conversation are not person-origin evidence. If evidence is unclear, return UNKNOWN. For PERSON, evidence must be an exact contiguous excerpt copied from the user message and label must name the person supported by that excerpt. For UNKNOWN or OTHER, evidence and label may be null. Output JSON only.'
        }]
      },
      { role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ message: String(text || '').slice(0, 1200) }) }] }
    ],
    text: { format: { type: 'json_schema', name: LEAD_ORIGIN_SCHEMA.name, strict: LEAD_ORIGIN_SCHEMA.strict, schema: LEAD_ORIGIN_SCHEMA.schema } }
  };
  const response = await axios.post(URL, payload, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 12000
  });
  return parseOutput(response.data);
}
