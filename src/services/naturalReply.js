/**
 * naturalReply.js
 * ──────────────────────────────────────────────────────────────────────
 *
 * Genera respuestas de texto natural usando OpenAI, en vez de mensajes
 * estáticos. El bot se comporta como un reclutador humano que:
 *
 *  • Responde preguntas sobre la vacante basándose en la info del DB.
 *  • Solicita datos que faltan de forma natural y contextual.
 *  • Ofrece horarios de entrevista de forma conversacional.
 *  • Nunca "quema" frases fijas; varía el lenguaje según el contexto.
 *  • Si el candidato se presenta o saluda, responde con amabilidad y
 *    LUEGO solicita datos — no interrumpe saludos con un formulario.
 *
 * Principios de diseño:
 *  - Conciso: máx 4 oraciones por respuesta (WhatsApp no es un email).
 *  - Humano: evita listas de viñetas y lenguaje corporativo frío.
 *  - Contextual: usa el nombre del candidato si ya lo tiene.
 *  - Sin mencionar nunca que es un bot, a menos que el candidato pregunte
 *    directamente.
 */

import axios from 'axios';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

/**
 * Construye el system prompt del reclutador con el contexto de la vacante.
 *
 * @param {object|null} vacancy — vacante de Prisma (puede ser null si aún no se identificó)
 * @param {object} candidate — candidato de Prisma
 * @param {string} conversationContext — descripción del estado actual del flujo
 * @returns {string}
 */
function buildSystemPrompt(vacancy, candidate, conversationContext) {
  const candidateName = candidate?.fullName ? candidate.fullName.split(' ')[0] : null;

  const vacancyBlock = vacancy ? [
    `Vacante: ${vacancy.title || vacancy.role}`,
    `Cargo: ${vacancy.role}`,
    `Ciudad: ${vacancy.city}`,
    vacancy.operationAddress ? `Dirección de operación: ${vacancy.operationAddress}` : null,
    `Requisitos: ${vacancy.requirements}`,
    `Condiciones: ${vacancy.conditions}`,
    vacancy.requiredDocuments ? `Documentación requerida para la entrevista: ${vacancy.requiredDocuments}` : null,
    vacancy.roleDescription ? `Descripción del cargo: ${vacancy.roleDescription}` : null
  ].filter(Boolean).join('\n') : 'La vacante aún no ha sido identificada.';

  return [
    'Eres un reclutador de LoginPro que atiende candidatos por WhatsApp.',
    'Tu tono es amable, directo y profesional, como lo haría un ser humano.',
    'NUNCA uses listas con viñetas ni numeración en tu respuesta.',
    'NUNCA uses formato Markdown (negritas, cursivas, etc.).',
    'NUNCA menciones que eres un bot o IA, a menos que el candidato lo pregunte directamente.',
    'NUNCA repitas frases que ya enviaste antes en la conversación.',
    'Responde SIEMPRE en menos de 4 oraciones, de forma conversacional.',
    'Si el candidato se presenta, responde al saludo con calidez ANTES de pedir datos.',
    'Si el candidato pregunta algo sobre la vacante, respóndelo con la info disponible.',
    'Si el candidato solicita algo que no está en la info de la vacante, sé honesto y di que no tienes esa información aún.',
    `\n--- INFORMACIÓN DE LA VACANTE ---\n${vacancyBlock}`,
    candidateName ? `\n--- CANDIDATO ---\nNombre: ${candidateName} (usa su nombre cuando sea natural)` : '',
    `\n--- CONTEXTO DEL FLUJO ---\n${conversationContext}`
  ].join(' ');
}

/**
 * Genera una respuesta natural para el candidato.
 *
 * @param {object} params
 * @param {object|null} params.vacancy — vacante activa (puede ser null)
 * @param {object} params.candidate — candidato actual
 * @param {string} params.inboundText — último mensaje del candidato
 * @param {string} params.conversationContext — descripción del momento del flujo
 * @param {string[]} [params.recentBotMessages] — últimos mensajes del bot (para evitar repeticin)
 * @param {string|null} [params.fallbackText] — texto fallback si OpenAI falla
 * @returns {Promise<string>}
 */
export async function generateNaturalReply({
  vacancy,
  candidate,
  inboundText,
  conversationContext,
  recentBotMessages = [],
  fallbackText = null
}) {
  if (!process.env.OPENAI_API_KEY) {
    return fallbackText || '¡Hola! Con gusto te ayudo. ¿En qué puedo ayudarte?';
  }

  const systemPrompt = buildSystemPrompt(vacancy, candidate, conversationContext);

  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  if (recentBotMessages.length) {
    messages.push({
      role: 'assistant',
      content: `[Mensajes previos que ya envié, NO repetir]: ${recentBotMessages.slice(-3).join(' | ')}`
    });
  }

  messages.push({ role: 'user', content: String(inboundText || '') });

  try {
    const response = await axios.post(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        messages,
        max_completion_tokens: 220,
        temperature: 0.6
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 14000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    return fallbackText || 'Perdona, hubo un problema técnico. ¿Puedes repetirme eso?';
  } catch {
    return fallbackText || 'Perdona, hubo un problema técnico. ¿Puedes repetirme eso?';
  }
}

/**
 * Genera el mensaje de bienvenida inicial cuando el candidato escribe por
 * primera vez. El bot detecta la vacante o pregunta por ella de forma natural.
 *
 * @param {object[]} vacancies — vacantes activas
 * @param {string} inboundText — primer mensaje del candidato
 * @param {string|null} resolvedVacancyId — vacante ya resuelta (si aplica)
 * @returns {Promise<string>}
 */
export async function generateGreeting(vacancies, inboundText, resolvedVacancyId) {
  if (!process.env.OPENAI_API_KEY) {
    return '¡Hola! Gracias por comunicarte con LoginPro. ¿Para cuál vacante y ciudad te interesa aplicar?';
  }

  const resolved = vacancies.find((v) => v.id === resolvedVacancyId);

  let systemPrompt;
  if (resolved) {
    systemPrompt = [
      'Eres un reclutador humano de LoginPro en WhatsApp.',
      'Saluda de forma cálida y natural, y comenta brevemente sobre la vacante disponible.',
      'Luego indica que necesitas los datos del candidato para continuar.',
      'NO uses viñetas ni Markdown. Máx 3 oraciones.',
      `Vacante: ${resolved.role} en ${resolved.city}.`,
      `Condiciones principales: ${resolved.conditions?.split('\n').slice(0, 3).join(', ')}`
    ].join(' ');
  } else {
    const vacancyList = vacancies.map((v) => `${v.role} en ${v.city}`).join(', ');
    systemPrompt = [
      'Eres un reclutador humano de LoginPro en WhatsApp.',
      'El candidato te escribe. Saluda de forma cálida y pregunta de forma natural',
      'por cuál vacante y ciudad se comunica. NO los ofrezcas como catálogo.',
      'NO uses viñetas ni Markdown. Máx 2 oraciones.',
      `Vacantes activas disponibles: ${vacancyList || 'ninguna por el momento'}`
    ].join(' ');
  }

  try {
    const response = await axios.post(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: inboundText }
        ],
        max_completion_tokens: 160,
        temperature: 0.65
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 12000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
  } catch {
    // fallback
  }

  return resolved
    ? `¡Hola! Gracias por comunicarte con LoginPro. Tenemos disponible la vacante de ${resolved.role} en ${resolved.city}. Para continuar necesito pedirte unos datos, ¿te parece bien?`
    : '¡Hola! Gracias por comunicarte con LoginPro. ¿Para cuál vacante y ciudad te estás comunicando?';
}

/**
 * Genera el mensaje que ofrece un slot de entrevista al candidato.
 *
 * @param {object} params
 * @param {string} params.formattedDate — fecha formateada en español
 * @param {object|null} params.vacancy
 * @param {string|null} params.candidateName
 * @param {string|null} params.requiredDocuments — documentación que debe llevar
 * @param {boolean} params.isReschedule — true si ya rechazó uno antes
 * @returns {Promise<string>}
 */
export async function generateInterviewOffer({
  formattedDate,
  vacancy,
  candidateName,
  requiredDocuments,
  isReschedule = false
}) {
  const docsLine = requiredDocuments || vacancy?.requiredDocuments
    ? `Debe traer: ${requiredDocuments || vacancy.requiredDocuments}.`
    : '';

  if (!process.env.OPENAI_API_KEY) {
    const name = candidateName ? ` ${candidateName.split(' ')[0]}` : '';
    return isReschedule
      ? `Entonces te ofrezco el ${formattedDate}. ¿Te queda bien ese horario? ${docsLine}`.trim()
      : `Perfecto${name}. Te puedo agendar para el ${formattedDate}. ¿Confirmas? ${docsLine}`.trim();
  }

  const systemPrompt = [
    'Eres un reclutador humano de LoginPro en WhatsApp.',
    isReschedule
      ? 'El candidato rechazó el horario anterior. Ofrece el nuevo de forma natural y empática.'
      : 'Ofrece el horario de entrevista de forma amable y directa.',
    candidateName ? `Nombre del candidato: ${candidateName.split(' ')[0]}.` : '',
    docsLine ? `Indica también: ${docsLine}` : '',
    'Pregunta si el horario le queda bien. Máx 2 oraciones. Sin viñetas ni Markdown.',
    `Horario a ofrecer: ${formattedDate}`
  ].filter(Boolean).join(' ');

  try {
    const response = await axios.post(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        messages: [{ role: 'system', content: systemPrompt }],
        max_completion_tokens: 120,
        temperature: 0.6
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
  } catch {
    // fallback
  }

  const name = candidateName ? ` ${candidateName.split(' ')[0]}` : '';
  return isReschedule
    ? `Entonces te ofrezco el ${formattedDate}. ¿Te queda bien? ${docsLine}`.trim()
    : `Listo${name}, te puedo agendar para el ${formattedDate}. ¿Confirmas? ${docsLine}`.trim();
}

/**
 * Genera el mensaje de confirmación final de entrevista agendada.
 *
 * @param {object} params
 * @param {string} params.formattedDate
 * @param {object|null} params.vacancy
 * @param {string|null} params.candidateName
 * @returns {Promise<string>}
 */
export async function generateBookingConfirmation({ formattedDate, vacancy, candidateName }) {
  const address = vacancy?.operationAddress || '';
  const docs = vacancy?.requiredDocuments || '';
  const name = candidateName ? ` ${candidateName.split(' ')[0]}` : '';

  if (!process.env.OPENAI_API_KEY) {
    return [
      `Listo${name}, quedaste agendado para el ${formattedDate}.`,
      address ? `La dirección es ${address}.` : '',
      docs ? `Recuerda traer: ${docs}.` : '',
      'Te enviaré un recordatorio una hora antes. ¡Mucha suerte!'
    ].filter(Boolean).join(' ');
  }

  const systemPrompt = [
    'Eres un reclutador humano de LoginPro en WhatsApp.',
    'Confirma la entrevista agendada de forma cálida y clara.',
    candidateName ? `Nombre: ${candidateName.split(' ')[0]}.` : '',
    `Fecha/hora: ${formattedDate}.`,
    address ? `Dirección: ${address}.` : '',
    docs ? `Documentación a traer: ${docs}.` : '',
    'Avisa que le llegará un recordatorio una hora antes.',
    'Máx 3 oraciones. Sin viñetas ni Markdown.'
  ].filter(Boolean).join(' ');

  try {
    const response = await axios.post(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        messages: [{ role: 'system', content: systemPrompt }],
        max_completion_tokens: 160,
        temperature: 0.55
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 12000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
  } catch {
    // fallback
  }

  return [
    `Perfecto${name}, quedaste agendado para el ${formattedDate}.`,
    address ? `Nos vemos en ${address}.` : '',
    docs ? `Recuerda llevar: ${docs}.` : '',
    'Te envío un recordatorio una hora antes. ¡Éxitos!'
  ].filter(Boolean).join(' ');
}
