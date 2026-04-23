import axios from 'axios';
import { RECRUITMENT_EXTRACTION_SCHEMA } from './recruitmentExtractionSchema.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MODEL = 'gpt-5.4-mini-2026-03-17';

function fallbackResult() {
  return {
    turnType: 'OTHER',
    fields: {
      fullName: null,
      age: null,
      documentType: null,
      documentNumber: null,
      gender: null,
      locality: null,
      neighborhood: null,
      transportMode: null,
      medicalRestrictions: null,
      experienceInfo: null
    },
    fieldEvidence: {
      fullName: { snippet: null, confidence: 0, source: 'fallback' },
      age: { snippet: null, confidence: 0, source: 'fallback' },
      documentType: { snippet: null, confidence: 0, source: 'fallback' },
      documentNumber: { snippet: null, confidence: 0, source: 'fallback' },
      gender: { snippet: null, confidence: 0, source: 'fallback' },
      locality: { snippet: null, confidence: 0, source: 'fallback' },
      neighborhood: { snippet: null, confidence: 0, source: 'fallback' },
      transportMode: { snippet: null, confidence: 0, source: 'fallback' },
      medicalRestrictions: { snippet: null, confidence: 0, source: 'fallback' },
      experienceInfo: { snippet: null, confidence: 0, source: 'fallback' }
    },
    conflicts: [],
    attachment: { mentioned: false, kindHint: null },
    replyIntent: 'continue_flow'
  };
}

function parseStructuredOutput(data = {}) {
  const output = data?.output || [];
  for (const item of output) {
    const content = item?.content || [];
    for (const part of content) {
      const parsed = part?.parsed;
      if (parsed && typeof parsed === 'object') return parsed;
      const text = part?.text;
      if (typeof text === 'string') {
        try { return JSON.parse(text); } catch {}
      }
    }
  }
  return null;
}

export async function extractRecruitmentTurn({ text = '', context = {} } = {}) {
  if (!process.env.OPENAI_API_KEY) return { used: false, status: 'disabled', extraction: fallbackResult() };

  const payload = {
    model: MODEL,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'Extrae entidades de reclutamiento y evidencia. Si no hay evidencia suficiente usa null. No converses.'
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: JSON.stringify({ text: String(text || '').slice(0, 3000), context })
          }
        ]
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: RECRUITMENT_EXTRACTION_SCHEMA.name,
        strict: RECRUITMENT_EXTRACTION_SCHEMA.strict,
        schema: RECRUITMENT_EXTRACTION_SCHEMA.schema
      }
    }
  };

  try {
    const response = await axios.post(RESPONSES_URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    const parsed = parseStructuredOutput(response.data) || fallbackResult();
    return { used: true, status: 'ok', extraction: { ...fallbackResult(), ...parsed }, model: MODEL };
  } catch (error) {
    return { used: true, status: 'error', extraction: fallbackResult(), model: MODEL, error };
  }
}
