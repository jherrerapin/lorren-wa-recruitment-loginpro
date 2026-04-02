import axios from 'axios';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

function buildPrompt() {
  return 'Extrae datos de candidato desde texto libre y responde solo JSON válido con claves: intent, fullName, documentType, documentNumber, age, neighborhood, experienceInfo, experienceTime, medicalRestrictions, transportMode.';
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

export async function tryOpenAIParse(text) {
  if (!process.env.OPENAI_API_KEY) {
    return { used: false, status: 'disabled', intent: null, parsedFields: {} };
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

  try {
    const response = await axios.post(
      OPENAI_CHAT_COMPLETIONS_URL,
      {
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildPrompt() },
          { role: 'user', content: String(text || '') }
        ],
        max_completion_tokens: 300
      },
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
      parsedFields: parsed
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
      error: wrappedError
    };
  }
}

export { extractTextFromChatCompletion, parseModelJson, summarizeOpenAIError };
