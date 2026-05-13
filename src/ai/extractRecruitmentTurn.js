import axios from 'axios';
import { RECRUITMENT_EXTRACTION_SCHEMA } from './recruitmentExtractionSchema.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MODEL = process.env.OPENAI_EXTRACTION_MODEL || 'gpt-5.4-mini-2026-03-17';

function extractUsage(data = {}) {
  const usage = data?.usage || {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (inputTokens + outputTokens);
  return {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0
  };
}

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
      experienceInfo: null,
      experienceTime: null
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
      experienceInfo: { snippet: null, confidence: 0, source: 'fallback' },
      experienceTime: { snippet: null, confidence: 0, source: 'fallback' }
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
- Usa SIEMPRE candidateMessage junto con conversationContext.currentStep, pendingFields, lastBotQuestion, recentConversation, vacancy y candidateKnownData.
- Interpreta respuestas implícitas solo cuando el candidato está respondiendo claramente a un campo pendiente o a la última pregunta del bot.
- Distingue intención conversacional, datos personales, correcciones, dudas y adjuntos. Un saludo, cortesía, confirmación simple, pregunta general o frase de interés NO es un dato personal.
- No extraigas fullName, neighborhood, locality, gender, documentType, documentNumber ni age desde saludos, cortesías, confirmaciones simples, preguntas generales o frases de interés por la vacante.
- Si un campo no tiene evidencia textual concreta del candidato en este turno, déjalo en null. No inventes ni completes por plausibilidad.
- Cada campo no null debe traer fieldEvidence con snippet exacto del mensaje del candidato, confidence realista y source específico. El snippet debe sostener directamente ese campo.
- Si el turno no responde claramente a un campo pendiente o a lastBotQuestion, deja el campo en null y registra conflicto cuando aplique.

Criterios por campo:
- fullName: acepta solo identidad personal real. Debe haber contexto de recolección de nombre (pendingFields, lastBotQuestion), una frase explícita como "mi nombre es", "me llamo", "soy [nombre]", o un bloque de datos personales. No conviertas intención, cargo, vacante, saludo ni cortesía en nombre.
- neighborhood/locality: acepta solo residencia/zona real. Busca evidencia como "vivo en", "resido en", "barrio", "localidad", "zona", "sector", "municipio", o que lastBotQuestion/pendingFields pidan residencia. No confundas cargo, vacante, ciudad de operación ni frase social con barrio/localidad.
- gender: detecta FEMALE solo con evidencia lingüística suficiente como "soy mujer", "femenino", "candidata", "estoy interesada", "quedo atenta". Detecta MALE con evidencia equivalente como "soy hombre", "masculino", "candidato", "estoy interesado", "quedo atento". Nunca infieras género solo por el nombre; si no hay evidencia, usa null o UNKNOWN.
- age: no confundas edad con números de dirección, calle, carrera, cédula, experiencia ni cantidades de personal.
- documentType/documentNumber: para avanzar en este flujo solo CC y PPT son válidos. CE, pasaporte u otros pueden mencionarse en conflictos/trazabilidad, pero no los marques como documento válido del proceso.
- residence: no confundas ciudad desde donde escribe, ciudad de operación o ciudad de la vacante con barrio/localidad de residencia.

Devuelve solo JSON válido bajo el schema estricto.`
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
      model: MODEL,
      usage: extractUsage(response.data)
    };
  } catch (error) {
    return { used: true, status: 'error', extraction: fallbackResult(), model: MODEL, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, error };
  }
}
