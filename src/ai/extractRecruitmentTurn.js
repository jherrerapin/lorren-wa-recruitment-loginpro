import axios from 'axios';
import { RECRUITMENT_EXTRACTION_SCHEMA } from './recruitmentExtractionSchema.js';
import { OPENAI_EXTRACTION_MODEL } from '../services/openAiModelConfig.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MODEL = OPENAI_EXTRACTION_MODEL;

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

function emptyEvidence() {
  return { snippet: null, confidence: 0, source: 'fallback', relation: 'UNKNOWN' };
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
      fullName: emptyEvidence(),
      age: emptyEvidence(),
      documentType: emptyEvidence(),
      documentNumber: emptyEvidence(),
      gender: emptyEvidence(),
      locality: emptyEvidence(),
      neighborhood: emptyEvidence(),
      transportMode: emptyEvidence(),
      medicalRestrictions: emptyEvidence(),
      experienceInfo: emptyEvidence(),
      experienceTime: emptyEvidence()
    },
    conflicts: [],
    attachment: { mentioned: false, kindHint: null },
    replyIntent: 'continue_flow'
  };
}

function parseStructuredOutput(data = {}) {
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
Tu tarea no es responder al candidato; debes comprender el turno y devolver únicamente el JSON del schema.

Usa candidateMessage junto con currentStep, pendingFields, lastBotQuestion, recentConversation, vacancy y candidateKnownData.

Para cada campo no null devuelve fieldEvidence con:
- snippet: fragmento exacto y mínimo del mensaje que sostiene el valor;
- confidence: confianza realista;
- source: origen de la interpretación;
- relation: relación semántica del fragmento con el candidato.

relation solo puede ser:
- SELF_ATTRIBUTE: el candidato afirma que ese dato es suyo, por ejemplo "mi CC es...", "vivo en...", "me movilizo en...";
- DIRECT_ANSWER: respuesta al campo que Lórren acaba de pedir, aunque sea breve, por ejemplo un nombre solo después de preguntar nombre;
- QUESTION_MENTION: el dato aparece únicamente dentro de una pregunta del candidato;
- THIRD_PARTY: describe a otra persona;
- VACANCY_CONTEXT: describe la vacante, requisito, ubicación de trabajo, ejemplo o condición, no al candidato;
- UNKNOWN: no hay base suficiente para una relación más precisa.

Regla central: QUESTION_MENTION, THIRD_PARTY, VACANCY_CONTEXT y UNKNOWN no son atributos personales del candidato. No conviertas esas menciones en fields salvo que el mismo turno contenga además una cláusula independiente SELF_ATTRIBUTE o DIRECT_ANSWER para ese campo; en ese caso el snippet debe apuntar exclusivamente a esa cláusula válida.

Una pregunta puede coexistir con datos personales. Ejemplos:
- "Mi CC es 1234567890. ¿Puedo ir en moto?" => documentType/documentNumber son SELF_ATTRIBUTE; moto es QUESTION_MENTION y NO es transportMode.
- "Andrés Felipe Henao Patiño, ¿cuál es el horario?" después de que Lórren pidió nombre => fullName DIRECT_ANSWER; la pregunta no invalida el nombre.
- "¿La vacante queda en El Salado?" => El Salado VACANCY_CONTEXT/QUESTION_MENTION, no residencia.

No inventes valores por plausibilidad. Si no existe evidencia textual concreta, deja el campo en null.

Criterios de entidad:
- fullName: identidad real del candidato. Un saludo, cargo, rasgo, intención, pregunta o secuencia de palabras con forma nominal no es un nombre. Un nombre desnudo es válido como DIRECT_ANSWER solo si pendingFields o lastBotQuestion muestran que Lórren acaba de pedirlo.
- documentType/documentNumber: solo CC y PPT son documentos válidos para avanzar. Distingue "¿necesito CC?" (QUESTION_MENTION) de "mi CC es..." (SELF_ATTRIBUTE) o "CC 123..." como DIRECT_ANSWER cuando el documento estaba pendiente.
- age: no confundas edad con dirección, cédula, experiencia ni cantidades laborales.
- gender: solo con evidencia lingüística del propio candidato; nunca por el nombre ni por tratamientos como "señora" dirigidos a otra persona.
- locality/neighborhood: residencia del candidato, no ciudad/sector de la vacante.
- transportMode: medio que el candidato declara usar/tener; una pregunta sobre si puede ir en moto no es su transporte.
- medicalRestrictions: condición declarada por el candidato o respuesta directa a esa pregunta; preguntas generales sobre restricciones no son su condición.
- experienceInfo/experienceTime: experiencia propia o respuesta directa al campo; requisitos de la vacante no son experiencia del candidato.

Clasifica turnType por el propósito principal. Si el propósito principal es preguntar, usa ASK_QUESTION aun cuando el mismo turno contenga un dato personal válido.
Devuelve solo JSON válido bajo el schema estricto.`
          }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: JSON.stringify(buildContextPayload(text, context)) }]
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
        fieldEvidence: { ...base.fieldEvidence, ...(parsed?.fieldEvidence || {}) }
      },
      model: MODEL,
      usage: extractUsage(response.data)
    };
  } catch (error) {
    return {
      used: true,
      status: 'error',
      extraction: fallbackResult(),
      model: MODEL,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      error
    };
  }
}
