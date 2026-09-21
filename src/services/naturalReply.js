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

import { FlowDeciderAction } from './flowDecider.js';
import { modelSupportsTemperature } from './aiParser.js';
import { OPENAI_CONVERSATION_MODEL } from './openAiModelConfig.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = OPENAI_CONVERSATION_MODEL;
const NATURAL_REPLY_TEMPERATURE = Object.freeze(
  modelSupportsTemperature(DEFAULT_MODEL) ? { temperature: 0.78 } : {}
);

async function postOpenAi(url, payload, config) {
  const { default: axios } = await import('axios');
  return axios.post(url, payload, config);
}

export function sanitizeRequiredDocumentsForBot(requiredDocuments) {
  const raw = String(requiredDocuments || '').trim();
  if (!raw) return '';

  const documents = raw
    .split(/\n+|;+/)
    .map((segment) => segment
      .replace(/^\s*(?:debe(?:s)?\s+)?(?:traer|llevar)\s*:?\s*/i, '')
      .replace(/[.。]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim())
    .filter(Boolean);

  const normalizeDocumentLabel = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.。]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return documents
    .filter((document, index) => documents.findIndex((item) => normalizeDocumentLabel(item) === normalizeDocumentLabel(document)) === index)
    .join(' y ');
}


function polishReplyForTurn(reply = '') {
  return String(reply || '').replace(/\s+/g, ' ').trim();
}

export function preserveConfiguredInterviewDocuments(reply = '', configuredDocuments = '') {
  const text = String(reply || '').trim();
  const documents = String(configuredDocuments || '').trim();
  if (!text || !documents || /\b(?:PDF|DOCX)\b/i.test(documents)) return text;

  return text.replace(
    /hoja\s+de\s+vida\s+en\s+PDF\s+o\s+(?:Word\/)?DOCX(?:\s+y\s+c[eé]dula\s+original)?/gi,
    documents
  );
}

export function buildInterviewDocumentsSentence(documents = '') {
  const cleanDocuments = String(documents || '').trim();
  return cleanDocuments ? `Para la entrevista, lleva ${cleanDocuments}.` : '';
}

export function buildInterviewAttendanceConfirmedReply(formattedDate = null) {
  const schedule = String(formattedDate || '').trim() || 'en el horario acordado';
  return `Perfecto, gracias por confirmar asistencia. Te esperamos ${schedule}.`;
}

export function buildInterviewCancellationReply() {
  return 'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.';
}

function naturalizeConfiguredDocumentsWording(reply = '') {
  return String(reply || '')
    .replace(/Para la entrevista,?\s+los documentos\s+\w+\s+son:?\s*/gi, 'Para la entrevista, lleva ')
    .replace(/Para la entrevista\s+la documentaci[oó]n\s+\w+\s+es\s*/gi, 'Para la entrevista, lleva ')
    .replace(/La documentaci[oó]n\s+\w+\s+es\s*/gi, 'Para la entrevista, lleva ');
}

function polishInterviewReply(reply = '', configuredDocuments = '') {
  return preserveConfiguredInterviewDocuments(polishReplyForTurn(naturalizeConfiguredDocumentsWording(reply)), configuredDocuments);
}

function getCandidateFirstName(candidate = {}) {
  if (!candidate?.fullName) return null;
  if (candidate.fullNameStatus === 'rejected' || candidate.fullNameRejected === true) return null;
  if (Array.isArray(candidate.rejectedFields) && candidate.rejectedFields.includes('fullName')) return null;
  if (Array.isArray(candidate.pendingFields) && candidate.pendingFields.includes('fullName')) return null;
  if (Array.isArray(candidate.missingFields) && candidate.missingFields.includes('fullName')) return null;

  const [firstName] = String(candidate.fullName).trim().split(/\s+/);
  return firstName || null;
}

function humanizeFieldName(field = '') {
  return String(field || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

function getFlowAction(flowDecision = {}) {
  return flowDecision?.action || flowDecision?.nextAction || null;
}

function buildContextualFallbackReply({
  vacancy = null,
  candidate = null,
  flowDecision = null,
  fallbackText = null,
  defaultAction = null,
  formattedDate = null,
  address = null,
  documents = null,
  isReschedule = false
} = {}) {
  if (fallbackText) return polishReplyForTurn(fallbackText);

  const action = getFlowAction(flowDecision) || defaultAction;
  const payload = flowDecision?.payload;
  const name = getCandidateFirstName(candidate);
  const vacancyName = vacancy?.title || vacancy?.role || null;
  const missingFields = Array.isArray(payload) ? payload : (Array.isArray(candidate?.missingFields) ? candidate.missingFields : []);
  const nextField = humanizeFieldName(missingFields[0]);
  const parts = [];

  if (action === FlowDeciderAction.IDENTIFY_VACANCY) {
    parts.push('Para ubicar tu proceso necesito confirmar la ciudad y la vacante o cargo por el que nos escribes.');
  } else if (action === FlowDeciderAction.PRESENT_VACANCY) {
    parts.push(vacancyName
      ? `Tengo ubicada la vacante de ${vacancyName}${vacancyCity(vacancy) ? ` en ${vacancyCity(vacancy)}` : ''}.`
      : 'Necesito confirmar la vacante registrada antes de avanzar.');
    parts.push('Si te interesa, seguimos con los datos necesarios para el proceso.');
  } else if (action === FlowDeciderAction.COLLECT_DATA) {
    parts.push(`${name ? `${name}, ` : ''}para continuar con tu postulación${vacancyName ? ` a ${vacancyName}` : ''}, necesito confirmar ${nextField || 'el dato pendiente'}.`);
  } else if (action === FlowDeciderAction.REQUEST_CV) {
    parts.push(`${name ? `${name}, ` : ''}ya tengo los datos principales; ahora necesito que compartas tu hoja de vida en un archivo válido para revisarla.`);
  } else if (action === FlowDeciderAction.SCHEDULE_INTERVIEW) {
    if (formattedDate) {
      parts.push(isReschedule
        ? `Te puedo ofrecer el ${formattedDate} como alternativa para entrevista.`
        : `Te puedo agendar entrevista para el ${formattedDate}.`);
      parts.push('Confírmame si ese horario te queda bien.');
    } else {
      parts.push('El siguiente paso es coordinar entrevista con la información registrada de tu proceso.');
    }
  } else if (action === FlowDeciderAction.CONFIRM_RECEIPT) {
    parts.push('Tu información quedó recibida y seguimos con la revisión del proceso.');
  } else if (action === FlowDeciderAction.SAVE_PROFILE) {
    parts.push('Con la información registrada puedo dejar tu perfil guardado para futuras aperturas compatibles.');
  } else if (action === FlowDeciderAction.ANSWER_FROM_VACANCY) {
    parts.push(vacancyName
      ? `Te comparto solo la información registrada de ${vacancyName}.`
      : 'Te comparto solo la información que está registrada de la vacante.');
  } else {
    parts.push('Necesito validar este punto con el equipo para no darte información incorrecta.');
  }

  if (address) parts.push(`La dirección registrada es ${address}.`);
  if (documents) parts.push(buildInterviewDocumentsSentence(documents));

  return polishReplyForTurn(parts.filter(Boolean).join(' '));
}

/**
 * Construye el system prompt del reclutador con el contexto de la vacante.
 */
function buildSystemPrompt(vacancy, candidate, conversationContext) {
  const candidateName = getCandidateFirstName(candidate);

  const vacancyBlock = vacancy ? [
    vacancy.title || vacancy.role ? `Vacante: ${vacancy.title || vacancy.role}` : null,
    vacancy.role ? `Cargo: ${vacancy.role}` : null,
    vacancy.city || vacancy.operation?.city?.name ? `Ciudad: ${vacancy.city || vacancy.operation?.city?.name}` : null,
    vacancy.operationAddress ? `Zona de operación: ${vacancy.operationAddress}` : null,
    vacancy.interviewAddress ? `Dirección de entrevista: ${vacancy.interviewAddress}` : null,
    vacancy.requirements ? `Requisitos: ${vacancy.requirements}` : null,
    vacancy.conditions ? `Condiciones: ${vacancy.conditions}` : null,
    sanitizeRequiredDocumentsForBot(vacancy.requiredDocuments) ? `Documentación requerida para la entrevista: ${sanitizeRequiredDocumentsForBot(vacancy.requiredDocuments)}` : null,
    vacancy.roleDescription ? `Descripción del cargo: ${vacancy.roleDescription}` : null
  ].filter(Boolean).join('\n') : 'La vacante aún no ha sido identificada.';

  return [
    'Eres un reclutador del equipo de selección de LoginPro atendiendo candidatos por WhatsApp.',
    'Usa tuteo colombiano natural y evita el voseo.',
    'Tu forma de comunicarte es cercana, directa y sin formalismos innecesarios — como un colombiano de RRHH que trata bien a la gente.',
    'NUNCA uses listas con viñetas ni numeración en tu respuesta.',
    'NUNCA uses formato Markdown (negritas, cursivas, etc.).',
    'NUNCA menciones que eres un bot o IA, salvo si el candidato pregunta directamente quién eres, cómo te llamas o si eres bot; en ese caso responde que eres Lórren, asistente de selección de LoginPro, y no lo repitas en otros turnos.',
    'NUNCA repitas frases que ya aparecen en la conversación reciente ni uses muletillas como "Ya tengo la información principal; voy a revisar el siguiente paso del proceso".',
    'NUNCA inventes cargos, sectores, salarios, horarios, beneficios, requisitos, documentos ni categorías de vacantes: usa solo la información registrada en la vacante asignada dentro del contexto.',
    'La documentación para entrevista solo puede salir del campo Documentación requerida para la entrevista de la vacante asignada; si no aparece allí, di que no la tienes registrada.',
    'Si el candidato pregunta por un dato que no aparece en la información de la vacante asignada, di de forma natural que no lo tienes registrado; no lo completes por intuición ni por historial.',
    'Saluda solo cuando sea primer contacto o cuando el candidato acaba de saludar; en confirmaciones, agendamientos, correcciones y seguimiento continúa directo sin abrir con Hola.',
    'Responde SIEMPRE en menos de 3 oraciones, de forma conversacional y variada.',
    'Si el candidato se presenta, responde al saludo con calidez ANTES de pedir datos.',
    'No respondas a cada mensaje por reflejo: si no hay nada útil que aportar, sé breve o deja que el flujo determinístico avance.',
    'Varía el lenguaje: no siempre el mismo saludo ni la misma forma de pedir un dato.',
    `\n--- INFORMACIÓN DE LA VACANTE ---\n${vacancyBlock}`,
    candidateName ? `\n--- CANDIDATO ---\nNombre: ${candidateName} (usa su nombre cuando sea natural, no en cada mensaje)` : '',
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
  flowDecision = null
}) {
  if (!process.env.OPENAI_API_KEY) {
    return buildContextualFallbackReply({ vacancy, candidate, flowDecision, fallbackText });
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
    const response = await postOpenAi(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        messages,
        max_completion_tokens: 220,
        ...NATURAL_REPLY_TEMPERATURE
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
    if (typeof content === 'string' && content.trim()) {
      return polishReplyForTurn(content);
    }
    return buildContextualFallbackReply({ vacancy, candidate, flowDecision, fallbackText });
  } catch {
    return buildContextualFallbackReply({ vacancy, candidate, flowDecision, fallbackText });
  }
}

/**
 * Genera el mensaje de bienvenida inicial cuando el candidato escribe por
 * primera vez.
 */
export async function generateGreeting(vacancies, inboundText, resolvedVacancyId) {
  if (!process.env.OPENAI_API_KEY) {
    return buildContextualFallbackReply({ defaultAction: FlowDeciderAction.IDENTIFY_VACANCY });
  }

  const resolved = vacancies.find((v) => v.id === resolvedVacancyId);

  let systemPrompt;
  if (resolved) {
    systemPrompt = [
      'Eres un reclutador humano de LoginPro en WhatsApp.',
      'Usa tuteo colombiano natural y evita el voseo.',
      'Saluda de forma cálida y natural, menciona brevemente la vacante disponible.',
      'Luego indica que necesitas los datos del candidato para continuar.',
      'NO uses viñetas ni Markdown. Máx 2 oraciones. Suena como una persona real, no como un sistema.',
      'No inventes otras vacantes, cargos, sectores, requisitos ni documentación: menciona solo esta vacante registrada.',
      `Vacante: ${resolved.role || resolved.title} en ${resolved.city || resolved.operation?.city?.name}.`,
      resolved.conditions ? `Condiciones principales: ${resolved.conditions.split('\n').slice(0, 3).join(', ')}` : 'No menciones condiciones si no están registradas.'
    ].join(' ');
  } else {
    systemPrompt = [
      'Eres un reclutador humano de LoginPro en WhatsApp.',
      'Usa tuteo colombiano natural y evita el voseo.',
      'El candidato te escribe. Saluda de forma cálida y pregunta de forma natural',
      'desde qué ciudad escribe y por cuál vacante, cargo o referencia verbal se comunica, si la tiene.',
      'NO ofrezcas vacantes como catálogo ni menciones una lista de cargos activos.',
      'NO uses viñetas ni Markdown. Máx 2 oraciones. Suena como una persona real.',
      'No inventes cargos, sectores ni documentación; si no hay ciudad o cargo claro, pídelo antes de afirmar opciones.'
    ].join(' ');
  }

  try {
    const response = await postOpenAi(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: inboundText }
        ],
        max_completion_tokens: 160,
        ...NATURAL_REPLY_TEMPERATURE
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

  return buildContextualFallbackReply({
    vacancy: resolved,
    defaultAction: resolved ? FlowDeciderAction.PRESENT_VACANCY : FlowDeciderAction.IDENTIFY_VACANCY
  });
}

/**
 * Genera el mensaje que ofrece un slot de entrevista al candidato.
 */
export async function generateInterviewOffer({
  formattedDate,
  vacancy,
  candidateName,
  candidate = null,
  requiredDocuments,
  isReschedule = false
}) {
  const safeRequiredDocuments = sanitizeRequiredDocumentsForBot(requiredDocuments || vacancy?.requiredDocuments);
  const docsLine = safeRequiredDocuments
    ? `Debe traer: ${safeRequiredDocuments}.`
    : '';
  const fallbackCandidate = candidate || { fullName: candidateName };
  const candidateFirstName = getCandidateFirstName(fallbackCandidate);
  const scheduleFallback = () => buildContextualFallbackReply({
    vacancy,
    candidate: fallbackCandidate,
    defaultAction: FlowDeciderAction.SCHEDULE_INTERVIEW,
    formattedDate,
    documents: safeRequiredDocuments,
    isReschedule
  });

  if (!process.env.OPENAI_API_KEY) {
    return scheduleFallback();
  }

  const systemPrompt = [
    'Eres un reclutador humano de LoginPro en WhatsApp.',
    'Usa tuteo colombiano natural y evita el voseo.',
    isReschedule
      ? 'El candidato rechazó el horario anterior. Ofrece el nuevo de forma natural y empática.'
      : 'Ofrece el horario de entrevista de forma amable y directa.',
    candidateFirstName ? `Nombre del candidato: ${candidateFirstName}.` : '',
    docsLine ? `Indica también esta documentación de la vacante para entrevista, usando exactamente esta información y sin agregar documentos no registrados: ${docsLine}` : 'No menciones documentación para entrevista porque la vacante no trae ese dato.',
    docsLine ? 'No conviertas la hoja de vida a PDF/DOCX ni cambies el formato: la documentación de entrevista debe salir tal cual de la vacante.' : '',
    'Pregunta si el horario le queda bien. Máx 2 oraciones. Sin viñetas ni Markdown. Suena humano.',
    'No abras con saludo ni con "Hola": es una continuación del hilo, no un primer contacto.',
    `Horario a ofrecer: ${formattedDate}`
  ].filter(Boolean).join(' ');

  try {
    const response = await postOpenAi(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        messages: [{ role: 'system', content: systemPrompt }],
        max_completion_tokens: 120,
        ...NATURAL_REPLY_TEMPERATURE
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
    if (typeof content === 'string' && content.trim()) return polishInterviewReply(content, safeRequiredDocuments);
  } catch {
    // fallback
  }

  return polishInterviewReply(scheduleFallback(), safeRequiredDocuments);
}

/**
 * Genera el mensaje de confirmación final de entrevista agendada.
 */
export async function generateBookingConfirmation({ formattedDate, vacancy, candidateName, candidate = null }) {
  const address = vacancy?.interviewAddress || vacancy?.operationAddress || '';
  const docs = sanitizeRequiredDocumentsForBot(vacancy?.requiredDocuments) || '';
  const fallbackCandidate = candidate || { fullName: candidateName };
  const candidateFirstName = getCandidateFirstName(fallbackCandidate);
  const confirmationFallback = () => polishInterviewReply([
    buildContextualFallbackReply({
      vacancy,
      candidate: fallbackCandidate,
      defaultAction: FlowDeciderAction.CONFIRM_RECEIPT,
      formattedDate,
      address,
      documents: docs
    }),
    `La entrevista quedó agendada para el ${formattedDate}.`,
    'Te llegará un recordatorio una hora antes.'
  ].filter(Boolean).join(' '), docs);

  if (!process.env.OPENAI_API_KEY) {
    return confirmationFallback();
  }

  const systemPrompt = [
    'Eres un reclutador humano de LoginPro en WhatsApp.',
    'Usa tuteo colombiano natural y evita el voseo.',
    'Confirma la entrevista agendada de forma cálida y clara.',
    candidateFirstName ? `Nombre: ${candidateFirstName}.` : '',
    `Fecha/hora: ${formattedDate}.`,
    address ? `Dirección: ${address}.` : '',
    docs ? `Documentación de la vacante para entrevista: ${docs}.` : 'No menciones documentación para entrevista porque la vacante no trae ese dato.',
    docs ? 'No conviertas la hoja de vida a PDF/DOCX ni cambies el formato: la documentación de entrevista debe salir tal cual de la vacante.' : '',
    'Avisa que le llegará un recordatorio una hora antes.',
    'No abras con saludo ni con "Hola": el candidato acaba de confirmar el horario y esta respuesta debe continuar el hilo.',
    'Máx 3 oraciones. Sin viñetas ni Markdown. Suena genuino y cercano.'
  ].filter(Boolean).join(' ');

  try {
    const response = await postOpenAi(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        messages: [{ role: 'system', content: systemPrompt }],
        max_completion_tokens: 160,
        ...NATURAL_REPLY_TEMPERATURE
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
    if (typeof content === 'string' && content.trim()) return polishInterviewReply(content, docs);
  } catch {
    // fallback
  }

  return confirmationFallback();
}

function normalizeCity(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function vacancyCity(vacancy = {}) {
  return vacancy?.operation?.city?.name || vacancy?.city || null;
}

function vacancyMatchesCity(vacancy = {}, city = null) {
  if (!city) return true;
  const requested = normalizeCity(city);
  const actual = normalizeCity(vacancyCity(vacancy));
  return Boolean(requested && actual && requested === actual);
}

export function buildVacancyOptionsReply({ city = null, vacancyOptions = [] } = {}) {
  const activeOptions = (vacancyOptions || [])
    .filter((vacancy) => vacancy?.isActive === true && vacancy?.acceptingApplications === true)
    .filter((vacancy) => vacancyMatchesCity(vacancy, city));

  if (!city) {
    return 'Claro, ¿desde qué ciudad nos escribes y para qué vacante o cargo estás interesado?';
  }

  if (!activeOptions.length) {
    return `En este momento no tengo vacantes activas registradas para ${city}. Si quieres, puedo dejar tu perfil registrado para futuras aperturas compatibles; solo avanzo si me confirmas que deseas ese registro.`;
  }

  return `Gracias. Para orientarte bien en ${city}, dime qué cargo o vacante buscas y, si aplica, una referencia verbal de la convocatoria.`;
}

export function buildUnavailableVacancyInfoReply(vacancy = {}) {
  const known = [
    vacancy.title || vacancy.role ? `la vacante ${vacancy.title || vacancy.role}` : null,
    vacancy.conditions ? `condiciones registradas: ${vacancy.conditions}` : null,
    vacancy.requirements ? `requisitos registrados: ${vacancy.requirements}` : null,
    vacancy.roleDescription ? `descripción registrada: ${vacancy.roleDescription}` : null
  ].filter(Boolean).join('; ');
  return `Ese dato no lo tengo registrado para confirmarlo por este medio.${known ? ` Te puedo compartir lo que sí tengo: ${known}.` : ' Te puedo compartir la información que sí tengo de la vacante y continuar con tu proceso.'}`;
}
