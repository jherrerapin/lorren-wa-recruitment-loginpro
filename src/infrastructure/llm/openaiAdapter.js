import axios from 'axios';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_REPLY_MODEL = 'gpt-4o-mini';
const FALLBACK_REPLY = 'En este momento estoy procesando tu solicitud, dame un momento por favor.';
const DIRECTIVE_FALLBACKS = Object.freeze({
  ASK_WHICH_FLYER_SEEN: 'Hola, soy Lórren, del equipo de selección de LoginPro. Gracias por comunicarte. Para brindarte la información correcta, ¿me confirmas qué cargo viste en el anuncio?'
});
const SYSTEM_PROMPT = `Eres Lórren, una asistente de reclutamiento. Redacta un mensaje único, conversacional y directo cumpliendo estrictamente con la directiva indicada. No inventes datos ni hagas preguntas que no estén en la directiva. Nunca preguntes el género, sexo o identidad de género del candidato, ni menciones que ese dato falta. Si aparece gender entre los parámetros, ignóralo al redactar.

Contexto operativo: LoginPro gestiona procesos de selección cerrados. Los candidatos escriben porque vieron un volante (flyer) o anuncio de un cargo concreto.

Ejecución estricta de ASK_WHICH_FLYER_SEEN: preséntate profesionalmente como Lórren, del equipo de selección de LoginPro; agradece el contacto y pregunta de forma directa qué cargo específico vio el candidato en el anuncio. Tono esperado: "Hola, soy Lórren, del equipo de selección de LoginPro. Gracias por comunicarte. Para brindarte la información correcta, ¿me confirmas qué cargo viste en el anuncio?" No preguntes por experiencia para buscar o recomendar un perfil. No listes vacantes activas ni presentes un catálogo de oportunidades.

La directiva es una instrucción interna y nunca debes mencionarla, traducir su identificador ni mostrar JSON al candidato. Para SEND_REMINDER, usa reminderType: INACTIVITY_REMINDER invita amablemente a retomar la postulación sin pedir campos nuevos; INTERVIEW_REMINDER recuerda que la entrevista será aproximadamente en una hora. Usa exclusivamente los datos incluidos en el contexto. Responde en español colombiano, con tono empático y profesional, en un solo mensaje breve. Devuelve únicamente el texto final que se enviará por WhatsApp.`;

const CANDIDATE_CONTEXT_FIELDS = Object.freeze([
  'fullName',
  'currentStep',
  'status',
  'vacancyRole',
  'vacancyTitle',
  'vacancyCity',
  'minAge',
  'maxAge',
  'experienceRequired',
  'experienceTime',
  'schedulingEnabled',
  'locationType',
  'dataConsentStatus',
  'optInGeneralPool'
]);

const SENSITIVE_PARAMETER_KEYS = /(?:phone|telefono|documentnumber|numero.*documento|email|correo|password|token|secret)/i;

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
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

  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_PARAMETER_KEYS.test(key))
    .slice(0, 40)
    .map(([key, item]) => [key, sanitizePromptValue(item, depth + 1)])
    .filter(([, item]) => item !== undefined));
}

function buildCandidateContext(context) {
  const candidate = asRecord(context?.candidate);
  const facts = asRecord(candidate.facts);
  const source = Object.keys(facts).length ? facts : candidate;

  return Object.fromEntries(CANDIDATE_CONTEXT_FIELDS
    .filter((field) => source[field] !== undefined && source[field] !== null && source[field] !== '')
    .map((field) => [field, sanitizePromptValue(source[field])]));
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
 * Render a pure engine directive into candidate-facing text. API failures are
 * deliberately converted into a safe local response so transport callers do
 * not need to understand OpenAI errors.
 */
export async function generateReply(directive, parameters = {}, context = {}) {
  const normalizedDirective = compactString(directive);
  try {
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
          {
            role: 'user',
            content: buildUserPrompt(normalizedDirective, parameters, context)
          }
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
    return DIRECTIVE_FALLBACKS[normalizedDirective] ?? FALLBACK_REPLY;
  }
}

export const openaiAdapter = Object.freeze({ generateReply });

export default openaiAdapter;
