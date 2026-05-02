/**
 * aiParser.js
 * ──────────────────────────────────────────────────────────────────────
 *
 * OpenAI como reclutador humano: lee el mensaje completo, entiende el
 * contexto, extrae lo que puede con confianza, omite lo que no está claro.
 *
 * Ajuste privacidad:
 * - Antes de enviar texto a OpenAI se enmascaran datos personales.
 * - La extracción local recupera campos sensibles claros para no perder flujo.
 * - Se registra consumo de tokens sin almacenar prompts ni outputs.
 */

import axios from 'axios';
import { extractRecruitmentTurn } from '../ai/extractRecruitmentTurn.js';
import { isFeatureEnabled } from './featureFlags.js';
import {
  buildOpenAIPrivacyMetadata,
  maskTextForOpenAI,
  mergeLocalSensitiveFields,
  removeMaskedPlaceholdersFromFields
} from './openaiPrivacy.js';
import { logOpenAIUsage } from './openaiUsageLogger.js';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const REASONING_MODELS = ['o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini'];

function buildPrompt() {
  return `Eres un reclutador humano experto leyendo mensajes de WhatsApp de candidatos a empleo en Colombia.

Tu trabajo es entender lo que el candidato quiso decir, no lo que escribió literalmente.
Los candidatos escriben rápido, con errores, abreviaciones, sin tildes, con jerga colombiana.
Tú los entiendes como los entendería cualquier colombiano que trabaje en recursos humanos.

De cada mensaje extrae los datos del candidato que puedas identificar con confianza.
Devuelve SOLO un objeto JSON válido, sin explicaciones, sin texto adicional.

Privacidad:
El mensaje puede venir con etiquetas como [DOCUMENTO], [TELEFONO], [EMAIL], [NUMERO_LARGO] o [NOMBRE_CANDIDATO].
No reconstruyas ni inventes datos personales enmascarados.
Si un dato personal aparece enmascarado, omite ese campo; el backend lo gestionará de forma local.

Campos que puedes extraer (omite los que no estén presentes o no sean claros):

{
  "intent": string,           // Intención principal del mensaje
  "city": string,             // Ciudad desde donde escribe o donde quiere aplicar
  "roleHint": string,         // Cargo o vacante de interés, expresado de forma breve
  "fullName": string,         // Nombre completo — capitalizado correctamente
  "documentType": string,     // CC | PPT
  "documentNumber": string,   // Solo los dígitos
  "age": number,              // Edad en años — número entero
  "neighborhood": string,     // Barrio, sector, localidad donde vive
  "medicalRestrictions": string, // Lo que diga el candidato sobre su condición física
  "transportMode": string,    // Moto | Bicicleta | Sin medio de transporte | lo que diga
}

INTENT — usa uno de estos valores:
greeting | apply_intent | confirmation_yes | confirmation_no_or_correction |
thanks | farewell | cv_intent | faq | provide_data | provide_correction |
post_completion_ack | unsupported_file_or_message

Cómo pensar sobre los datos:

• Los humanos escriben la edad de mil formas. Un número de documento tiene muchos más dígitos que una edad.
• El barrio puede mencionarse con o sin la palabra "barrio".
• El transporte puede ser implícito: "tengo moto", "me muevo en bici", "sin vehículo".
• Si el candidato menciona una ciudad o un cargo de interés, extráelos en "city" y "roleHint" solo cuando estén razonablemente claros.
• Si algo no está claro en el mensaje, simplemente no lo incluyas en el JSON. Prefiere omitir a inventar.`;
}

function extractTextFromChatCompletion(data = {}) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : ''))
      .join('')
      .trim();
  }
  return '{}';
}

function parseModelJson(rawText = '{}') {
  const t = String(rawText || '').trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch {
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) { try { return JSON.parse(fenced[1].trim()); } catch { return {}; } }
    return {};
  }
}

function summarizeOpenAIError(error) {
  const status = error?.response?.status ? `HTTP ${error.response.status}` : null;
  const code = error?.code || null;
  const name = error?.name || 'Error';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 180) : null;
  const apiMessage = typeof error?.response?.data?.error?.message === 'string'
    ? error.response.data.error.message.slice(0, 220) : null;
  return [name, status, code, apiMessage || message || 'Unexpected error'].filter(Boolean).join(' | ');
}

function parseOptionalTemperature() {
  const raw = process.env.OPENAI_TEMPERATURE;
  if (!raw?.trim()) return { value: null, reason: 'missing' };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { value: null, reason: 'invalid' };
  if (parsed < 0 || parsed > 2) return { value: null, reason: 'out_of_range' };
  if (parsed === 1) return { value: null, reason: 'default_value' };
  return { value: parsed, reason: null };
}

function modelSupportsTemperature(model = '') {
  const n = String(model || '').trim().toLowerCase();
  return n ? !REASONING_MODELS.some((b) => n.startsWith(b)) : false;
}

function resolvePrisma(context = {}) {
  return context.prisma || context.db || null;
}

export async function tryOpenAIParse(text, context = {}) {
  if (!process.env.OPENAI_API_KEY) {
    return { used: false, status: 'disabled', intent: null, parsedFields: {} };
  }

  if (isFeatureEnabled('FF_RESPONSES_EXTRACTOR', false)) {
    const extracted = await extractRecruitmentTurn({ text, context });
    const extraction = extracted?.extraction || {};
    return {
      used: extracted.used,
      status: extracted.status,
      intent: extraction.replyIntent || null,
      parsedFields: extraction.fields || {},
      extraction,
      model: extracted.model || process.env.OPENAI_EXTRACTION_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5-2026-04-23'
    };
  }

  const model = process.env.OPENAI_MODEL || 'gpt-5.5-2026-04-23';
  const temp = parseOptionalTemperature();
  const useTemp = temp.value !== null && modelSupportsTemperature(model);
  const privacy = maskTextForOpenAI(text);

  const payload = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildPrompt() },
      { role: 'user', content: privacy.sanitizedText }
    ],
    max_completion_tokens: 300,
    ...(useTemp ? { temperature: temp.value } : {})
  };

  try {
    const response = await axios.post(
      OPENAI_CHAT_COMPLETIONS_URL,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 12000
      }
    );

    await logOpenAIUsage(resolvePrisma(context), {
      responseData: response.data,
      modelRequested: model,
      usageType: 'ai_parser_chat_completion',
      candidate: context.candidate || null,
      messageId: context.messageId || null,
      privacy: buildOpenAIPrivacyMetadata(privacy)
    });

    const modelFields = removeMaskedPlaceholdersFromFields(parseModelJson(extractTextFromChatCompletion(response.data)));
    const parsed = mergeLocalSensitiveFields(modelFields, privacy.localFields);

    return {
      used: true, status: 'ok',
      intent: parsed.intent || null,
      parsedFields: parsed,
      model,
      temperature_omitted: !useTemp,
      temperature_value: useTemp ? temp.value : null,
      privacy_redactions: privacy.redactionSummary
    };
  } catch (error) {
    const summarized = summarizeOpenAIError(error);
    const wrapped = new Error(summarized);
    wrapped.name = error?.name || 'OpenAIError';
    wrapped.code = error?.code;
    wrapped.response = error?.response ? { status: error.response.status } : undefined;
    return {
      used: true, status: 'error',
      intent: null, parsedFields: {}, model,
      temperature_omitted: !useTemp,
      temperature_value: useTemp ? temp.value : null,
      error: wrapped
    };
  }
}

export { extractTextFromChatCompletion, parseModelJson, summarizeOpenAIError, parseOptionalTemperature, modelSupportsTemperature };
