import axios from 'axios';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_REPLY_MODEL = 'gpt-4o-mini';
const FALLBACK_REPLY = 'En este momento estoy procesando tu solicitud, dame un momento por favor.';

const SYSTEM_PROMPT = `Eres Lórren, una asistente de reclutamiento. Redacta un mensaje único, conversacional y muy corto cumpliendo estrictamente con la directiva indicada.
REGLAS ESTRICTAS:
1. Nunca uses viñetas (- o *), ni listas numeradas, ni asteriscos de formato (Markdown).
2. Nunca envíes los requisitos, condiciones o descripciones largas de la vacante a menos que la directiva diga explícitamente "EXPLICAR_VACANTE".
3. Usa frases simples en español colombiano.
4. Devuelve únicamente el texto final que se enviará por WhatsApp.`;

const CANDIDATE_CONTEXT_FIELDS = Object.freeze([
  'fullName', 'currentStep', 'status', 'vacancyRole', 'vacancyTitle', 'vacancyCity', 'dataConsentStatus', 'optInGeneralPool'
]);

const SENSITIVE_PARAMETER_KEYS = /(?:phone|telefono|documentnumber|numero.*documento|email|correo|password|token|secret)/i;

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sanitizePromptValue(value, depth = 0) {
  if (depth > 4 || value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 500);
  if (Array.isArray(value)) {
    return value.slice(0, 25)
      .map((item) => sanitizePromptValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_PARAMETER_KEYS.test(key))
      .slice(0, 40)
      .map(([key, item]) => [key, sanitizePromptValue(item, depth + 1)])
      .filter(([, item]) => item !== undefined)
  );
}

function buildCandidateContext(context) {
  const candidate = asRecord(context?.candidate);
  const facts = asRecord(candidate.facts);
  const source = Object.keys(facts).length ? facts : candidate;

  return Object.fromEntries(
    CANDIDATE_CONTEXT_FIELDS
      .filter((field) => source[field] !== undefined && source[field] !== null && source[field] !== '')
      .map((field) => [field, sanitizePromptValue(source[field])])
  );
}

function buildUserPrompt(directive, parameters, context) {
  return JSON.stringify({
    directive,
    parameters: sanitizePromptValue(asRecord(parameters)),
    candidate: buildCandidateContext(context)
  });
}

function extractReply(response) {
  return compactString(response?.data?.choices?.[0]?.message?.content);
}

/**
 * Render a pure engine directive into candidate-facing text.
 */
export async function generateReply(directive, parameters = {}, context = {}) {
  try {
    const normalizedDirective = compactString(directive);
    if (!normalizedDirective) throw new TypeError('directive_required');

    const apiKey = compactString(process.env.OPENAI_API_KEY);
    if (!apiKey) throw new Error('openai_api_key_missing');

    const model = compactString(process.env.OPENAI_REPLY_MODEL) || DEFAULT_REPLY_MODEL;

    const response = await axios.post(
      OPENAI_CHAT_COMPLETIONS_URL,
      {
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(normalizedDirective, parameters, context) }
        ],
        temperature: 0.4,
        max_tokens: 220
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const reply = extractReply(response);
    if (!reply) throw new Error('openai_reply_empty');
    return reply;
  } catch {
    return FALLBACK_REPLY;
  }
}