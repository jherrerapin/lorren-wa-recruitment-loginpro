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

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

async function postOpenAi(url, payload, config) {
  const { default: axios } = await import('axios');
  return axios.post(url, payload, config);
}

export function sanitizeRequiredDocumentsForBot(requiredDocuments) {
  const raw = String(requiredDocuments || '').trim();
  if (!raw) return '';

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const documents = [];
  const add = (value) => {
    if (value && !documents.some((item) => item.toLowerCase() === value.toLowerCase())) documents.push(value);
  };

  if (/\b(hoja\s+de\s+vida|hv|curriculum|curriculo|minerva\s*1003)\b/.test(normalized)) {
    add('hoja de vida en PDF o Word/DOCX');
  }

  if (/\b(cedula|c[eé]dula)\s+original\b/.test(raw.toLowerCase()) || /\bcedula\s+original\b/.test(normalized)) {
    add('cédula original');
  }

  const forbiddenTerms = /\b(impresa|foto|imagen|captura|como\s+la\s+tenga|como\s+la\s+tengas|minerva\s*1003(?:\s+fisica)?|f[ií]sica)\b/gi;
  const cleanedSegments = raw
    .split(/[,;\n]+|\s+y\s+/i)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !/hoja\s+de\s+vida|\bhv\b|curriculum|curr[ií]culo|minerva\s*1003/i.test(segment))
    .map((segment) => segment.replace(forbiddenTerms, '').replace(/\s{2,}/g, ' ').replace(/\s+(?:o|y)\s*$/i, '').trim())
    .filter(Boolean)
    .filter((segment) => !/^(traer|llevar|documentos?|requeridos?)$/i.test(segment));

  for (const segment of cleanedSegments) add(segment);

  return documents.join(' y ');
}


function stripRepeatedOpeningGreeting(reply = '') {
  const text = String(reply || '').trim();
  if (!text) return text;

  const withoutGreeting = text.replace(
    /^(?:[¡!\s]*)(?:hola|buen(?:os|as)\s+(?:d[ií]as|tardes|noches)|cordial\s+saludo)(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ'.-]{2,})?\s*[,.:;-]+\s*/i,
    ''
  ).trim();

  if (!withoutGreeting) return text;
  return withoutGreeting.replace(/^([a-záéíóúñ])/, (match) => match.toUpperCase());
}

function polishReplyForTurn(reply = '', { allowOpeningGreeting = false } = {}) {
  const text = String(reply || '').replace(/\s+/g, ' ').trim();
  if (!text) return text;
  return allowOpeningGreeting ? text : stripRepeatedOpeningGreeting(text);
}

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
    sanitizeRequiredDocumentsForBot(vacancy.requiredDocuments) ? `Documentación requerida para la entrevista: ${sanitizeRequiredDocumentsForBot(vacancy.requiredDocuments)}` : null,
    vacancy.roleDescription ? `Descripción del cargo: ${vacancy.roleDescription}` : null
  ].filter(Boolean).join('\n') : 'La vacante aún no ha sido identificada.';

  return [
    'Sos un reclutador del equipo de selección de LoginPro atendiendo candidatos por WhatsApp.',
    'Tu forma de comunicarte es cercana, directa y sin formalismos innecesarios — como un colombiano de RRHH que trata bien a la gente.',
    'NUNCA usés listas con viñetas ni numeración en tu respuesta.',
    'NUNCA usés formato Markdown (negritas, cursivas, etc.).',
    'NUNCA menciones que sos un bot o IA, a menos que el candidato lo pregunte directamente.',
    'NUNCA repitas frases que ya aparecen en la conversación reciente.',
    'NUNCA inventés cargos, sectores, beneficios, requisitos ni categorías de vacantes: usá solo la información registrada en el contexto.',
    'Saludá solo cuando sea primer contacto o cuando el candidato acaba de saludar; en confirmaciones, agendamientos, correcciones y seguimiento continuá directo sin abrir con Hola.',
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
    const response = await postOpenAi(
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
    if (typeof content === 'string' && content.trim()) {
      return polishReplyForTurn(content, { allowOpeningGreeting: !recentBotMessages.length });
    }
    return polishReplyForTurn(fallbackText || 'Te lei, dame un momento y continuo contigo.', { allowOpeningGreeting: !recentBotMessages.length });
  } catch {
    return polishReplyForTurn(fallbackText || 'Te lei, dame un momento y continuo contigo.', { allowOpeningGreeting: !recentBotMessages.length });
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
      'No inventés otras vacantes, cargos, sectores ni requisitos: menciona solo esta vacante registrada.',
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
      'No inventés cargos ni sectores; si no hay ciudad o cargo claro, pedilo antes de afirmar opciones.',
      `Vacantes activas disponibles: ${vacancyList || 'ninguna por el momento'}`
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
  const safeRequiredDocuments = sanitizeRequiredDocumentsForBot(requiredDocuments || vacancy?.requiredDocuments);
  const docsLine = safeRequiredDocuments
    ? `Debe traer: ${safeRequiredDocuments}.`
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
    if (typeof content === 'string' && content.trim()) return polishReplyForTurn(content);
  } catch {
    // fallback
  }

  const name = candidateName ? ` ${candidateName.split(' ')[0]}` : '';
  return polishReplyForTurn(isReschedule
    ? `Entonces te ofrezco el ${formattedDate}. ¿Te queda bien? ${docsLine}`.trim()
    : `Listo${name}, te puedo agendar para el ${formattedDate}. ¿Confirmas? ${docsLine}`.trim());
}

/**
 * Genera el mensaje de confirmación final de entrevista agendada.
 */
export async function generateBookingConfirmation({ formattedDate, vacancy, candidateName }) {
  const address = vacancy?.interviewAddress || vacancy?.operationAddress || '';
  const docs = sanitizeRequiredDocumentsForBot(vacancy?.requiredDocuments) || '';
  const name = candidateName ? ` ${candidateName.split(' ')[0]}` : '';

  if (!process.env.OPENAI_API_KEY) {
    return polishReplyForTurn([
      `Listo${name}, quedaste agendado para el ${formattedDate}.`,
      address ? `La dirección es ${address}.` : '',
      docs ? `Recuerda traer: ${docs}.` : '',
      'Te enviaré un recordatorio una hora antes. ¡Mucha suerte!'
    ].filter(Boolean).join(' '));
  }

  const systemPrompt = [
    'Sos un reclutador humano de LoginPro en WhatsApp.',
    'Confirmá la entrevista agendada de forma cálida y clara.',
    candidateName ? `Nombre: ${candidateName.split(' ')[0]}.` : '',
    `Fecha/hora: ${formattedDate}.`,
    address ? `Dirección: ${address}.` : '',
    docs ? `Documentación a traer: ${docs}.` : '',
    'Avisá que le llegará un recordatorio una hora antes.',
    'No abras con saludo ni con "Hola": el candidato acaba de confirmar el horario y esta respuesta debe continuar el hilo.',
    'Máx 3 oraciones. Sin viñetas ni Markdown. Soná genuino y cercano.'
  ].filter(Boolean).join(' ');

  try {
    const response = await postOpenAi(
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
    if (typeof content === 'string' && content.trim()) return polishReplyForTurn(content);
  } catch {
    // fallback
  }

  return polishReplyForTurn([
    `Perfecto${name}, quedaste agendado para el ${formattedDate}.`,
    address ? `Nos vemos en ${address}.` : '',
    docs ? `Recuerda llevar: ${docs}.` : '',
    'Te envío un recordatorio una hora antes. ¡Éxitos!'
  ].filter(Boolean).join(' '));
}

function vacancyLabel(vacancy = {}) {
  return vacancy.title || vacancy.role || null;
}

function joinNatural(items = []) {
  const clean = items.filter(Boolean);
  if (clean.length <= 1) return clean[0] || '';
  if (clean.length === 2) return `${clean[0]} y ${clean[1]}`;
  return `${clean.slice(0, -1).join(', ')} y ${clean[clean.length - 1]}`;
}

export function buildVacancyOptionsReply({ city = null, vacancyOptions = [], hasAskedAvailableVacancies = true } = {}) {
  const activeOptions = (vacancyOptions || [])
    .filter((vacancy) => vacancy?.isActive === true && vacancy?.acceptingApplications === true)
    .map(vacancyLabel)
    .filter(Boolean);

  if (!city) {
    return 'Claro, para revisar opciones reales primero cuéntame desde qué ciudad nos escribes y qué cargo tienes en mente.';
  }

  if (!activeOptions.length) {
    return `En este momento no tengo vacantes activas registradas para ${city}. Si quieres, puedo dejar tus datos y tu hoja de vida en PDF o Word/DOCX para tenerte en cuenta cuando se abra una opción.`;
  }

  if (activeOptions.length === 1) {
    return `Claro, para ${city} tengo disponible ${activeOptions[0]}. ¿Quieres que te comparta la información de esa vacante?`;
  }

  const lead = hasAskedAvailableVacancies ? 'Claro' : 'Te cuento';
  return `${lead}, en ${city} tengo disponibles estas opciones: ${joinNatural(activeOptions)}. ¿Cuál te interesa para compartirte la información completa?`;
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
