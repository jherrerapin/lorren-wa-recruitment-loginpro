import axios from 'axios';
import { LEAD_ORIGIN_SCHEMA } from '../ai/leadOriginSchema.js';

const URL = 'https://api.openai.com/v1/responses';
const MODEL = process.env.OPENAI_EXTRACTION_MODEL || 'gpt-5.4-mini-2026-03-17';

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
      { role: 'system', content: [{ type: 'input_text', text: 'Classify the lead origin semantically. Do not use fixed word lists, regex, or literal matching. If evidence is unclear, return UNKNOWN. Output JSON only.' }] },
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
