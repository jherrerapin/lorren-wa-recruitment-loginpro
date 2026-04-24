import axios from 'axios';
import { RECRUITMENT_EXTRACTION_SCHEMA } from './recruitmentExtractionSchema.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MODEL = process.env.OPENAI_EXTRACTION_MODEL || 'gpt-5.4-mini-2026-03-17';

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

function buildContextPayload(text = '', context = {}) {
  return {
    candidateMessage: String(text || '').slice(0, 3000),
    conversationContext: {
      currentStep: context.currentStep || null,
      pendingFields: Array.isArray(context.pendingFields) ? context.pendingFields : [],
      lastBotQuestion: context.lastBotQuestion || null,
      recentConversation: Array.isArray(context.recentConversation) ? context.recentConversation.slice(-12) : [],
      vacancy: context.vacancy || null,
      candidateKnownData: context.candidateKnownData || null
    }
  };
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
            text: `Eres el módulo de comprensión conversacional de un reclutador por WhatsApp.
Tu tarea no es responder al candidato; tu tarea es entender el turno completo y devolver datos estructurados bajo el schema.

Principios de interpretación:
- Usa el mensaje actual junto con el contexto de conversación, especialmente la última pregunta del bot, el paso actual y los campos pendientes.
- Interpreta respuestas implícitas cuando el candidato responde a una pregunta anterior, aunque no repita el nombre técnico del campo.
- Distingue entre intención conversacional, datos del candidato, correcciones, dudas y adjuntos.
- No persistas como dato un fragmento que solo cumple función conversacional dentro del turno.
- No infieras datos sensibles o excluyentes sin evidencia verificable en el mensaje o en el contexto.
- Si el turno es ambiguo, deja el campo en null y registra el conflicto en vez de inventar.
- Cada campo que no sea null debe traer evidencia: snippet tomado del candidato, source y confidence.
- Devuelve solo JSON válido bajo el schema estricto.`
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: JSON.stringify(buildContextPayload(text, context))
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
    const base = fallbackResult();
    return {
      used: true,
      status: 'ok',
      extraction: {
        ...base,
        ...parsed,
        fields: { ...base.fields, ...(parsed?.fields || {}) },
        fieldEvidence: { ...base.fieldEvidence, ...(parsed?.fieldEvidence || {}) },
      },
      model: MODEL
    };
  } catch (error) {
    return { used: true, status: 'error', extraction: fallbackResult(), model: MODEL, error };
  }
}
