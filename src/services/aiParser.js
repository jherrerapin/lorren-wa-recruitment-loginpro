/**
 * aiParser.js
 * ──────────────────────────────────────────────────────────────────────
 *
 * Fuente de verdad para extracción de campos ambiguos:
 *   - edad (en números, palabras, con errores de tipeo, "veintiocho", etc.)
 *   - nombre completo (cuando no hay prefijo explícito)
 *   - experiencia ("sí tengo", "no tengo", "poca", "bastante")
 *   - tiempo de experiencia ("dos años", "6 mesecitos", "un añito")
 *   - intent conversacional
 *
 * Principio:
 *   OpenAI recibe el texto completo, con todo el contexto, y decide.
 *   No se le imponen restricciones de patrón. Se le dan instrucciones
 *   de semántica (qué es una edad vs. qué es un número de documento)
 *   para que razone como un humano que lee el mensaje.
 */

import axios from 'axios';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Modelos de razonamiento de OpenAI que no soportan el parámetro temperature.
 */
const REASONING_MODELS = ['o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini'];

function buildPrompt() {
  return [
    'Eres un extractor de datos de candidatos para empleo. Recibes texto libre en español y devuelves SOLO JSON válido.',
    '',
    'CAMPOS PERMITIDOS EN EL JSON:',
    'intent, fullName, documentType, documentNumber, age, neighborhood, experienceInfo, experienceTime, medicalRestrictions, transportMode',
    '',
    'INSTRUCCIONES POR CAMPO:',
    '',
    'EDAD (age):',
    '- Extrae la edad como número entero.',
    '- El candidato puede escribirla de cualquier forma: "28", "tengo 28", "28 años", "veintiocho años", "veintiocho", "28 añitos", "28 años de edad", con tilde o sin tilde, con errores de tipeo ("annos", "añoz", "tengo 28 añitos").',
    '- Un número de cédula tiene 6 a 12 dígitos. Un número como "14396104" o "1.073.432.987" es un documento, NO una edad.',
    '- Si en el texto aparece tanto un número de documento como un número de edad, distingue por contexto semántico.',
    '- Rango válido de edad: 15 a 70 años. Si calculas algo fuera de ese rango con poca certeza, omite el campo.',
    '',
    'EXPERIENCIA (experienceInfo + experienceTime):',
    '- experienceInfo: "Sí" o "No".',
    '- experienceTime: normaliza a formato "N años" o "N meses" o "N semanas".',
    '- El candidato puede decir: "dos años", "tres meses", "6 mesecitos", "un añito", "poca experiencia", "bastante experiencia".',
    '- "poca experiencia" o "sin experiencia" = experienceInfo="No".',
    '- Nunca inventes tiempo de experiencia si el candidato no lo mencionó.',
    '',
    'NOMBRE (fullName):',
    '- El candidato puede presentarse como: "soy Juan Pérez", "mi nombre es", o simplemente escribir su nombre al inicio.',
    '- Capitaliza correctamente.',
    '',
    'TRANSPORTE (transportMode):',
    '- Detecta afirmativo (Moto, Bicicleta) y negativo ("Sin medio de transporte").',
    '- Nunca conviertas una negación en Moto o Bicicleta.',
    '',
    'INTENT:',
    'Uno de: greeting, apply_intent, confirmation_yes, confirmation_no_or_correction, thanks, farewell, cv_intent, faq, provide_data, provide_correction, post_completion_ack, unsupported_file_or_message.',
    '',
    'Omite los campos que no aparezcan en el texto. Devuelve SOLO JSON, sin explicaciones.'
  ].join('\n');
}

function extractTextFromChatCompletion(data = {}) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
    if (joined) return joined;
  }
  return '{}';
}

function parseModelJson(rawText = '{}') {
  const normalized = String(rawText || '').trim();
  if (!normalized) return {};
  try {
    return JSON.parse(normalized);
  } catch {
    const fenced = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try { return JSON.parse(fenced[1].trim()); } catch { return {}; }
    }
    return {};
  }
}

function summarizeOpenAIError(error) {
  const status = error?.response?.status ? `HTTP ${error.response.status}` : null;
  const code = error?.code || null;
  const name = error?.name || 'Error';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 180) : null;
  const apiMessage = typeof error?.response?.data?.error?.message === 'string'
    ? error.response.data.error.message.slice(0, 220)
    : null;
  return [name, status, code, apiMessage || message || 'Unexpected error'].filter(Boolean).join(' | ');
}

function parseOptionalTemperature() {
  const raw = process.env.OPENAI_TEMPERATURE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null, reason: 'missing' };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { value: null, reason: 'invalid' };
  if (parsed < 0 || parsed > 2) return { value: null, reason: 'out_of_range' };
  if (parsed === 1) return { value: null, reason: 'default_value' };
  return { value: parsed, reason: null };
}

/**
 * Temperature se aplica a todos los modelos EXCEPTO los de razonamiento
 * (o1, o3 y variantes), que no lo soportan.
 */
function modelSupportsTemperature(model = '') {
  const n = String(model || '').trim().toLowerCase();
  if (!n) return false;
  return !REASONING_MODELS.some((blocked) => n.startsWith(blocked));
}

export async function tryOpenAIParse(text) {
  if (!process.env.OPENAI_API_KEY) {
    return { used: false, status: 'disabled', intent: null, parsedFields: {} };
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const requestedTemp = parseOptionalTemperature();
  const shouldIncludeTemp = requestedTemp.value !== null && modelSupportsTemperature(model);

  const payload = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildPrompt() },
      { role: 'user', content: String(text || '') }
    ],
    max_completion_tokens: 300
  };
  if (shouldIncludeTemp) payload.temperature = requestedTemp.value;

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

    const parsed = parseModelJson(extractTextFromChatCompletion(response.data));
    return {
      used: true,
      status: 'ok',
      intent: parsed.intent || null,
      parsedFields: parsed,
      model,
      temperature_omitted: !shouldIncludeTemp,
      temperature_value: shouldIncludeTemp ? requestedTemp.value : null
    };
  } catch (error) {
    const summarized = summarizeOpenAIError(error);
    const wrappedError = new Error(summarized);
    wrappedError.name = error?.name || 'OpenAIError';
    wrappedError.code = error?.code;
    wrappedError.response = error?.response ? { status: error.response.status } : undefined;

    return {
      used: true,
      status: 'error',
      intent: null,
      parsedFields: {},
      model,
      temperature_omitted: !shouldIncludeTemp,
      temperature_value: shouldIncludeTemp ? requestedTemp.value : null,
      error: wrappedError
    };
  }
}

export {
  extractTextFromChatCompletion,
  parseModelJson,
  summarizeOpenAIError,
  parseOptionalTemperature,
  modelSupportsTemperature
};
