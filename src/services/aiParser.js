import axios from 'axios';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const MODELS_WITH_CUSTOM_TEMPERATURE_SUPPORT = [
  'gpt-3.5-turbo',
  'gpt-4',
  'gpt-4-turbo',
  'gpt-4o',
  'gpt-4o-mini'
];

function buildPrompt() {
  return [
    'Extrae datos de candidato desde texto libre y responde solo JSON válido.',
    'Claves permitidas: intent, fullName, documentType, documentNumber, age, neighborhood, experienceInfo, experienceTime, medicalRestrictions, transportMode.',
    'Diferencia edad de experiencia laboral: "22 años" sin contexto laboral es edad, NO experienceTime.',
    'Solo usa experienceTime cuando exista contexto explícito de experiencia laboral (ej. "5 meses de experiencia").',
    'Si detectas "sin experiencia", "no tengo experiencia", "poca experiencia", marca experienceInfo="No" y NO inventes experiencia positiva.',
    'Transporte: detecta afirmativo (Moto/Bicicleta) y negativo ("Sin medio de transporte"). Nunca conviertas negaciones en Moto o Bicicleta.',
    'Si hay restricciones médicas negativas, usa "Sin restricciones médicas".',
    'intent debe ser una de: greeting, apply_intent, confirmation_yes, confirmation_no_or_correction, thanks, farewell, cv_intent, faq, provide_data, provide_correction, post_completion_ack, unsupported_file_or_message.'
  ].join(' ');
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
    const fencedMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      try {
        return JSON.parse(fencedMatch[1].trim());
      } catch {
        return {};
      }
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
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: null, reason: 'missing' };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return { value: null, reason: 'invalid' };
  }

  if (parsed < 0 || parsed > 2) {
    return { value: null, reason: 'out_of_range' };
  }

  if (parsed === 1) {
    return { value: null, reason: 'default_value' };
  }

  return { value: parsed, reason: null };
}

function modelSupportsCustomTemperature(model = '') {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) return false;
  return MODELS_WITH_CUSTOM_TEMPERATURE_SUPPORT.some((allowedModel) => normalized.startsWith(allowedModel));
}

export async function tryOpenAIParse(text) {
  if (!process.env.OPENAI_API_KEY) {
    return { used: false, status: 'disabled', intent: null, parsedFields: {} };
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const requestedTemperature = parseOptionalTemperature();
  const shouldIncludeTemperature = requestedTemperature.value !== null && modelSupportsCustomTemperature(model);
  const payload = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildPrompt() },
      { role: 'user', content: String(text || '') }
    ],
    max_completion_tokens: 300
  };

  if (shouldIncludeTemperature) {
    payload.temperature = requestedTemperature.value;
  }

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
      temperature_omitted: !shouldIncludeTemperature,
      temperature_value: shouldIncludeTemperature ? requestedTemperature.value : null
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
      temperature_omitted: !shouldIncludeTemperature,
      temperature_value: shouldIncludeTemperature ? requestedTemperature.value : null,
      error: wrappedError
    };
  }
}

export { extractTextFromChatCompletion, parseModelJson, summarizeOpenAIError, parseOptionalTemperature, modelSupportsCustomTemperature };
