/**
 * naturalReply.js
 * ──────────────────────────────────────────────────────────────────────
 *
 * Genera respuestas de texto natural usando OpenAI, en vez de mensajes
 * estáticos.
 *
 * Ajuste privacidad:
 * - El inbound del candidato se enmascara antes de OpenAI.
 * - No se envía nombre completo; solo primer nombre cuando ya existe.
 * - Se registra consumo de tokens cuando se recibe prisma en los parámetros.
 */

import axios from 'axios';
import { buildOpenAIPrivacyMetadata, maskTextForOpenAI } from './openaiPrivacy.js';
import { logOpenAIUsage } from './openaiUsageLogger.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5-2026-04-23';

function firstName(fullName) {
  return typeof fullName === 'string' && fullName.trim()
    ? fullName.trim().split(/\s+/)[0]
    : null;
}

function maskTextList(list = []) {
  return list.map((item) => maskTextForOpenAI(String(item || '')).sanitizedText);
}

function resolvePrisma(options = {}) {
  return options.prisma || options.db || null;
}

async function postOpenAI({ payload, timeout, prisma, candidate, usageType, privacy }) {
  const response = await axios.post(
    OPENAI_URL,
    payload,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout
    }
  );

  await logOpenAIUsage(prisma, {
    responseData: response.data,
    modelRequested: payload.model,
    usageType,
    candidate,
    privacy
  });

  return response;
}

/**
 * Construye el system prompt del reclutador con el contexto de la vacante.
 */
function buildSystemPrompt(vacancy, candidate, conversationContext) {
  const candidateName = firstName(candidate?.fullName);

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
    'Privacidad: si ves etiquetas como [DOCUMENTO], [TELEFONO], [EMAIL] o [NOMBRE_CANDIDATO], no intentes reconstruir esos datos.',
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
  fallbackText = null,
  prisma = null
}) {
  if (!process.env.OPENAI_API_KEY) {
    return fallbackText || 'Te lei, dame un momento y continuo contigo.';
  }

  const privacy = maskTextForOpenAI(inboundText);
  const systemPrompt = buildSystemPrompt(vacancy, candidate, conversationContext);

  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  if (recentBotMessages.length) {
    messages.push({
      role: 'assistant',
      content: `[Mensajes previos que ya envié, NO repetir]: ${maskTextList(recentBotMessages).slice(-8).join(' | ')}`
    });
  }

  messages.push({ role: 'user', content: privacy.sanitizedText });

  try {
    const response = await postOpenAI({
      payload: {
        model: DEFAULT_MODEL,
        messages,
        max_completion_tokens: 220,
        temperature: 0.78
      },
      timeout: 14000,
      prisma: resolvePrisma({ prisma }),
      candidate,
      usageType: 'natural_reply',
      privacy: buildOpenAIPrivacyMetadata(privacy)
    });

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
export async function generateGreeting(vacancies, inboundText, resolvedVacancyId, options = {}) {
  if (!process.env.OPENAI_API_KEY) {
    return '¡Hola! Gracias por comunicarte con LoginPro. ¿Para cuál vacante y ciudad te interesa aplicar?';
  }

  const privacy = maskTextForOpenAI(inboundText);
  const resolved = vacancies.find((v) => v.id === resolvedVacancyId);

  let systemPrompt;
  if (resolved) {
    systemPrompt = [
      'Sos un reclutador humano de LoginPro en WhatsApp.',
      'Saludá de forma cálida y natural, mencioná brevemente la vacante disponible.',
      'Luego indicá que necesitás los datos del candidato para continuar.',
      'NO usés viñetas ni Markdown. Máx 2 oraciones. Soná como una persona real, no como un sistema.',
      'No reconstruyas datos personales si el texto contiene etiquetas de privacidad.',
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
      'No reconstruyas datos personales si el texto contiene etiquetas de privacidad.',
      `Vacantes activas disponibles: ${vacancyList || 'ninguna por el momento'}`
    ].join(' ');
  }

  try {
    const response = await postOpenAI({
      payload: {
        model: DEFAULT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: privacy.sanitizedText }
        ],
        max_completion_tokens: 160,
        temperature: 0.78
      },
      timeout: 12000,
      prisma: resolvePrisma(options),
      candidate: options.candidate || null,
      usageType: 'natural_greeting',
      privacy: buildOpenAIPrivacyMetadata(privacy)
    });

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
  isReschedule = false,
  prisma = null,
  candidate = null
}) {
  const docsLine = requiredDocuments || vacancy?.requiredDocuments
    ? `Debe traer: ${requiredDocuments || vacancy.requiredDocuments}.`
    : '';

  if (!process.env.OPENAI_API_KEY) {
    const name = firstName(candidateName) ? ` ${firstName(candidateName)}` : '';
    return isReschedule
      ? `Entonces te ofrezco el ${formattedDate}. ¿Te queda bien ese horario? ${docsLine}`.trim()
      : `Perfecto${name}. Te puedo agendar para el ${formattedDate}. ¿Confirmas? ${docsLine}`.trim();
  }

  const candidateFirstName = firstName(candidateName);
  const systemPrompt = [
    'Sos un reclutador humano de LoginPro en WhatsApp.',
    isReschedule
      ? 'El candidato rechazó el horario anterior. Ofrecé el nuevo de forma natural y empática.'
      : 'Ofrecé el horario de entrevista de forma amable y directa.',
    candidateFirstName ? `Nombre del candidato: ${candidateFirstName}.` : '',
    docsLine ? `Indicá también: ${docsLine}` : '',
    'Preguntá si el horario le queda bien. Máx 2 oraciones. Sin viñetas ni Markdown. Soná humano.',
    `Horario a ofrecer: ${formattedDate}`
  ].filter(Boolean).join(' ');

  try {
    const response = await postOpenAI({
      payload: {
        model: DEFAULT_MODEL,
        messages: [{ role: 'system', content: systemPrompt }],
        max_completion_tokens: 120,
        temperature: 0.78
      },
      timeout: 10000,
      prisma: resolvePrisma({ prisma }),
      candidate,
      usageType: 'interview_offer',
      privacy: { privacyMaskingEnabled: true, sensitiveDataDetected: Boolean(candidateName), redactionSummary: candidateName ? ['nombre'] : [] }
    });

    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
  } catch {
    // fallback
  }

  const name = firstName(candidateName) ? ` ${firstName(candidateName)}` : '';
  return isReschedule
    ? `Entonces te ofrezco el ${formattedDate}. ¿Te queda bien? ${docsLine}`.trim()
    : `Listo${name}, te puedo agendar para el ${formattedDate}. ¿Confirmas? ${docsLine}`.trim();
}

/**
 * Genera el mensaje de confirmación final de entrevista agendada.
 */
export async function generateBookingConfirmation({ formattedDate, vacancy, candidateName, prisma = null, candidate = null }) {
  const address = vacancy?.interviewAddress || vacancy?.operationAddress || '';
  const docs = vacancy?.requiredDocuments || '';
  const candidateFirstName = firstName(candidateName);
  const name = candidateFirstName ? ` ${candidateFirstName}` : '';

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
    candidateFirstName ? `Nombre: ${candidateFirstName}.` : '',
    `Fecha/hora: ${formattedDate}.`,
    address ? `Dirección: ${address}.` : '',
    docs ? `Documentación a traer: ${docs}.` : '',
    'Avisá que le llegará un recordatorio una hora antes.',
    'Máx 3 oraciones. Sin viñetas ni Markdown. Soná genuino y cercano.'
  ].filter(Boolean).join(' ');

  try {
    const response = await postOpenAI({
      payload: {
        model: DEFAULT_MODEL,
        messages: [{ role: 'system', content: systemPrompt }],
        max_completion_tokens: 160,
        temperature: 0.78
      },
      timeout: 12000,
      prisma: resolvePrisma({ prisma }),
      candidate,
      usageType: 'booking_confirmation',
      privacy: { privacyMaskingEnabled: true, sensitiveDataDetected: Boolean(candidateName), redactionSummary: candidateName ? ['nombre'] : [] }
    });

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
