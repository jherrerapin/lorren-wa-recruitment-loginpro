/**
 * aiParser.js
 * ──────────────────────────────────────────────────────────────────────
 *
 * OpenAI como reclutador humano: lee el mensaje completo, entiende el
 * contexto, extrae lo que puede con confianza, omite lo que no está claro.
 * Sin reglas rígidas. Sin patrones de texto. Inteligencia pura.
 */

import axios from 'axios';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const REASONING_MODELS = ['o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini'];

function buildPrompt() {
  return `Eres un reclutador humano experto leyendo mensajes de WhatsApp de candidatos a empleo en Colombia.

Tu trabajo es entender lo que el candidato quiso decir, no lo que escribió literalmente.
Los candidatos escriben rápido, con errores, abreviaciones, sin tildes, con jerga colombiana.
Tú los entiendes como los entendería cualquier colombiano que trabaje en recursos humanos.

De cada mensaje extrae los datos del candidato que puedas identificar con confianza.
Devuelve SOLO un objeto JSON válido, sin explicaciones, sin texto adicional.

Campos que puedes extraer (omite los que no estén presentes o no sean claros):

{
  "intent": string,           // Intención principal del mensaje
  "city": string,             // Ciudad desde donde escribe o donde quiere aplicar
  "roleHint": string,         // Cargo o vacante de interés, expresado de forma breve
  "fullName": string,         // Nombre completo — capitalizado correctamente
  "documentType": string,     // CC | TI | CE | PPT | Pasaporte
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

Cómo pensar sobre los datos (no son reglas, son criterios de sentido común):

• Los humanos escriben la edad de mil formas. "Tengo 28", "28 años", "veintiocho",
  "28 añitos", "28 años de edad", "tengo 28 añitos", "soy de 28", incluso solo "28"
  si el contexto del mensaje sugiere que está hablando de sí mismo.
  Un número de cédula tiene muchos más dígitos que una edad — un humano jamás los confunde.

• El nombre puede aparecer al inicio del mensaje, después de "soy", "me llamo",
  o simplemente escrito. Capitaliza bien: "MARIA PEREZ" → "Maria Perez".

• El barrio puede mencionarse con o sin la palabra "barrio": "vivo en el Salado",
  "del Jordan", "zona norte", "ciudadela Simón Bolívar".

• El transporte puede ser implícito: "tengo moto", "me muevo en bici",
  "no tengo cómo llegar", "sin vehículo". Tú entiendes si tiene o no tiene.

• Si el candidato menciona una ciudad o un cargo de interés, extráelos en "city"
  y "roleHint" solo cuando estén razonablemente claros.

• Si algo no está claro en el mensaje, simplemente no lo incluyas en el JSON.
  Prefiere omitir a inventar.`;
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

export async function tryOpenAIParse(text) {
  if (!process.env.OPENAI_API_KEY) {
    return { used: false, status: 'disabled', intent: null, parsedFields: {} };
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const temp = parseOptionalTemperature();
  const useTemp = temp.value !== null && modelSupportsTemperature(model);

  const payload = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildPrompt() },
      { role: 'user', content: String(text || '') }
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

    const parsed = parseModelJson(extractTextFromChatCompletion(response.data));
    return {
      used: true, status: 'ok',
      intent: parsed.intent || null,
      parsedFields: parsed,
      model,
      temperature_omitted: !useTemp,
      temperature_value: useTemp ? temp.value : null
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
