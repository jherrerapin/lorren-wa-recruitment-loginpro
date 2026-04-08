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
 *  - Conciso: máx 3 oraciones por respuesta (WhatsApp no es un email).
 *  - Humano: evita listas de viñetas y lenguaje corporativo frío.
 *  - Contextual: usa el nombre del candidato si ya lo tiene.
 *  - Sin mencionar nunca que es un bot, a menos que el candidato pregunte.
 */

import axios from 'axios';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

/**
 * Construye el system prompt del reclutador con el contexto de la vacante.
 */
function buildSystemPrompt(vacancy, candidate, conversationContext) {
  const candidateName = candidate?.fullName ? candidate.fullName.split(' ')[0] : null;

  const vacancyBlock = vacancy ? [
    `Vacante: ${vacancy.title || vacancy.role}`,
    `Cargo: ${vacancy.role}`,
    `Ciudad: ${vacancy.city}`,
    vacancy.operationAddress ? `Zona de operación: ${vacancy.operationAddress}` : null,
    vacancy.interviewAddress ? `Dirección de entrevista: ${vacancy.interviewAddress}` : null,
    `Requisitos: ${vacancy.requirements}`,
    `Condiciones: ${vacancy.conditions}`,
    vacancy.requiredDocuments ? `Documentación requerida para la entrevista: ${vacancy.requiredDocuments}` : null,
    vacancy.roleDescription ? `Descripción del cargo: ${vacancy.roleDescription}` : null
  ].filter(Boolean).join('\n') : 'La vacante aún no ha sido identificada.';

  return [
    'Sos un reclutador del equipo de selección de LoginPro atendiendo candidatos por WhatsApp.',
    'Tu forma de comunicarte es cercana, directa y sin formalismos innecesarios — como un colombiano de RRHH que trata bien a la gente.',
    'NUNCA usés listas con viñetas ni numeración en tu respuesta.',
    'NUNCA usés formato Markdown (negritas, cursivas, etc.).',
    'NUNCA menciones que sos un bot o IA, a menos que el candidato lo pregunte directamente.',
    'NUNCA repitas frases que ya aparecen en la conversación reciente.',
    'Respondé SIEMPRE en menos de 3 oraciones, de forma conversacional y variada.',
    'Si el candidato se presenta, respondé al saludo con calidez ANTES de pedir datos.',
    'Variá el lenguaje: no siempre el mismo saludo ni la misma forma de pedir un dato.',
    `\n--- INFORMACIÓN DE LA VACANTE ---\n${vacancyBlock}`,
    candidateName ? `\n--- CANDIDATO ---\nNombre: ${candidateName} (usá su nombre cuando sea natural, no en cada mensaje)` : '',
    `\n--- CONTEXTO DEL FLUJO ---\n${conversationContext}`
  ].join(' ');
}

/**
 * Genera una respuesta natural para el candidato.
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
    return fallbackText || 'Te lei, dame un momento y continuo contigo.';
  }

  const systemPrompt = buildSystemPrompt(vacancy, candidate, conversationContext);

  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  if (recentBotMessages.length) {
    messages.push({
      role: 'assistant',
      content: `[Mensajes previos que ya envié, NO repetir]: ${recentBotMessages.slice(-8).join(' | ')}`
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
        temperature: 0.78
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
    return fallbackText || 'Te lei, dame un momento y continuo contigo.';
  } catch {
    return fallbackText || 'Te lei, dame un momento y continuo contigo.';
  }
}

/**
 * Genera el mensaje de bienvenida inicial cuando el candidato escribe por
 * primera vez.
 */
export async function generateGreeting(vacancies, inboundText, resolvedVacancyId) {
  if (!process.env.OPENAI_API_KEY) {
    return '¡Hola! Gracias por comunicarte con LoginPro. ¿Para cuál vacante y ciudad te interesa aplicar?';
  }

  const resolved = vacancies.find((v) => v.id === resolvedVacancyId);

  let systemPrompt;
  if (resolved) {
    systemPrompt = [
      'Sos un reclutador humano de LoginPro en WhatsApp.',
      'Saludá de forma cálida y natural, mencioná brevemente la vacante disponible.',
      'Luego indicá que necesitás los datos del candidato para continuar.',
      'NO usés viñetas ni Markdown. Máx 2 oraciones. Soná como una persona real, no como un sistema.',
      `Vacante: ${resolved.role} en ${resolved.city}.`,
      `Condiciones principales: ${resolved.conditions?.split('\n').slice(0, 3).join(', ')}`
    ].join(' ');
  } else {
    const vacancyList = vacancies.map((v) => `${v.role} en ${v.city}`).join(', ');
    systemPrompt = [
      'Sos un reclutador humano de LoginPro en WhatsApp.',
      'El candidato te escribe. Saludá de forma cálida y preguntá de forma natural',
      'por cuál vacante y ciudad se comunica. NO los ofrezcas como catálogo.',
      'NO usés viñetas ni Markdown. Máx 2 oraciones. Soná como una persona real.',
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
        temperature: 0.78
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
    'Sos un reclutador humano de LoginPro en WhatsApp.',
    isReschedule
      ? 'El candidato rechazó el horario anterior. Ofrecé el nuevo de forma natural y empática.'
      : 'Ofrecé el horario de entrevista de forma amable y directa.',
    candidateName ? `Nombre del candidato: ${candidateName.split(' ')[0]}.` : '',
    docsLine ? `Indicá también: ${docsLine}` : '',
    'Preguntá si el horario le queda bien. Máx 2 oraciones. Sin viñetas ni Markdown. Soná humano.',
    `Horario a ofrecer: ${formattedDate}`
  ].filter(Boolean).join(' ');

  try {
    const response = await axios.post(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        messages: [{ role: 'system', content: systemPrompt }],
        max_completion_tokens: 120,
        temperature: 0.78
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
 */
export async function generateBookingConfirmation({ formattedDate, vacancy, candidateName }) {
  const address = vacancy?.interviewAddress || vacancy?.operationAddress || '';
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
    'Sos un reclutador humano de LoginPro en WhatsApp.',
    'Confirmá la entrevista agendada de forma cálida y clara.',
    candidateName ? `Nombre: ${candidateName.split(' ')[0]}.` : '',
    `Fecha/hora: ${formattedDate}.`,
    address ? `Dirección: ${address}.` : '',
    docs ? `Documentación a traer: ${docs}.` : '',
    'Avisá que le llegará un recordatorio una hora antes.',
    'Máx 3 oraciones. Sin viñetas ni Markdown. Soná genuino y cercano.'
  ].filter(Boolean).join(' ');

  try {
    const response = await axios.post(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        messages: [{ role: 'system', content: systemPrompt }],
        max_completion_tokens: 160,
        temperature: 0.78
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
