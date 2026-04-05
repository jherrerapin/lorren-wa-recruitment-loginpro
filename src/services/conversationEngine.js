/**
 * conversationEngine.js
 * ──────────────────────────────────────────────────────────────────────
 *
 * El cerebro del bot. OpenAI lee la conversación completa, entiende
 * el contexto, decide qué hacer y qué responder — todo de una sola vez.
 *
 * Arquitectura:
 *   1. think()  — OpenAI razona y devuelve: reply, nextStep, actions, extractedFields
 *   2. act()    — El sistema ejecuta las acciones (Prisma, scheduler). Sin lógica de negocio.
 *
 * Flujo por género:
 *   MALE    → flujo completo: datos → CV → agendamiento de entrevista (si schedulingEnabled)
 *   FEMALE  → flujo alternativo: datos → CV → cierre formal → cola revisión humana
 *   UNKNOWN → OpenAI pregunta el género de forma natural durante la recolección de datos
 *
 * Modos de operación según configuración de la vacante:
 *   acceptingApplications=true  + schedulingEnabled=false → Solo postulación:
 *     recolecta datos + CV, cierra con mensaje formal de "quedaste en proceso".
 *   acceptingApplications=true  + schedulingEnabled=true  → Postulación + entrevista:
 *     recolecta datos + CV y luego agenda entrevista (excepto FEMALE).
 */

import axios from 'axios';
import { modelSupportsTemperature, parseOptionalTemperature } from './aiParser.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// ─────────────────────────────────────────────
// Helpers de contexto
// ─────────────────────────────────────────────

function normalizeMedicalRestrictionsLabel(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/sin restricciones?|no tengo restricciones?|ninguna restriccion/.test(v)) {
    return 'Sin restricciones médicas';
  }
  return value;
}

function buildCandidateContext(candidate) {
  const genderLabel = {
    MALE: 'Masculino',
    FEMALE: 'Femenino',
    OTHER: 'Otro',
    UNKNOWN: 'No determinado aún'
  }[candidate.gender] ?? 'No determinado aún';

  const medLabel = normalizeMedicalRestrictionsLabel(candidate.medicalRestrictions);

  const fields = [
    candidate.fullName        && `Nombre: ${candidate.fullName}`,
    candidate.documentType && candidate.documentNumber
                              && `Documento: ${candidate.documentType} ${candidate.documentNumber}`,
    candidate.age             && `Edad: ${candidate.age}`,
    candidate.gender          && `Género: ${genderLabel}`,
    candidate.neighborhood    && `Barrio: ${candidate.neighborhood}`,
    candidate.experienceInfo  && `Experiencia: ${candidate.experienceInfo}`,
    candidate.experienceTime  && `Tiempo de experiencia: ${candidate.experienceTime}`,
    medLabel                  && `Restricciones médicas: ${medLabel}`,
    candidate.transportMode   && `Transporte: ${candidate.transportMode}`
  ].filter(Boolean);

  return fields.length
    ? `Datos capturados hasta ahora:\n${fields.join('\n')}`
    : 'No se han capturado datos aún.';
}

function buildVacancyContext(vacancy) {
  if (!vacancy) return 'Vacante: no identificada aún.';

  const schedulingLine = vacancy.schedulingEnabled
    ? 'Agendamiento de entrevistas: habilitado'
    : 'Agendamiento de entrevistas: NO habilitado. Esta vacante es de solo postulación — NO se agenda entrevista.';
  const addressLabel = vacancy.schedulingEnabled ? 'Dirección de entrevista' : 'Dirección de operación';

  return [
    `Vacante: ${vacancy.title || vacancy.role}`,
    `Cargo: ${vacancy.role}`,
    `Ciudad: ${vacancy.city}`,
    vacancy.operationAddress  && `${addressLabel}: ${vacancy.operationAddress}`,
    `Requisitos: ${vacancy.requirements}`,
    `Condiciones: ${vacancy.conditions}`,
    vacancy.requiredDocuments && `Documentación para entrevista: ${vacancy.requiredDocuments}`,
    vacancy.roleDescription   && `Descripción del cargo: ${vacancy.roleDescription}`,
    schedulingLine
  ].filter(Boolean).join('\n');
}

function buildConversationHistory(recentMessages) {
  if (!recentMessages?.length) return 'Sin historial previo.';
  return recentMessages
    .map((m) => `${m.direction === 'INBOUND' ? 'Candidato' : 'Bot'}: ${m.body || ''}`)
    .join('\n');
}

function buildNextSlotContext(nextSlot) {
  if (!nextSlot?.slot) return '';
  const label = nextSlot.isConfirmedBooking
    ? 'Entrevista ya agendada'
    : (nextSlot.isAlternative ? 'Siguiente slot de entrevista disponible' : 'Slot de entrevista disponible');
  const warning = !nextSlot.windowOk && nextSlot.windowExtension?.needsWindowExtension
    ? ' (fuera de ventana 24h de WhatsApp — se programará re-enganche automático)'
    : '';
  const previousOfferLine = nextSlot.previousFormattedDate
    ? `\nHorario anterior rechazado: ${nextSlot.previousFormattedDate}`
    : '';
  return `${previousOfferLine}\n${label}: ${nextSlot.formattedDate}${warning}`;
}

// ─────────────────────────────────────────────
// Lógica de género — decide el flujo
// ─────────────────────────────────────────────

/**
 * Retorna la instrucción de flujo según el género detectado y la configuración de la vacante.
 *
 * UNKNOWN → OpenAI pregunta de forma natural.
 * FEMALE  → recolectar todo + CV, pero NO agendar, cerrar con mensaje formal.
 * MALE/OTHER + schedulingEnabled=true  → flujo completo con agendamiento.
 * MALE/OTHER + schedulingEnabled=false → solo postulación, cierre formal.
 */
function buildGenderFlowInstruction(candidate, vacancy) {
  const gender = candidate.gender ?? 'UNKNOWN';
  const schedulingEnabled = vacancy?.schedulingEnabled ?? false;

  if (gender === 'UNKNOWN') {
    return `GÉNERO: No determinado aún.
Durante la recolección de datos, determina el género del candidato de forma natural.
Podés inferirlo del nombre si es inequívoco (María → FEMALE, Carlos → MALE).
Si el nombre no lo aclara, preguntálo de forma amable y directa en algún momento
durante la conversación (no como primer dato, sino cuando sea natural).
Extraélo en extractedFields como "gender": "MALE" | "FEMALE" | "OTHER".`;
  }

  if (gender === 'FEMALE') {
    return `GÉNERO: Femenino (detectado).
FLUJO ESPECIAL — CANDIDATA FEMENINA:
- Continúa recolectando todos los datos normalmente.
- Solicitá la hoja de vida igual que con cualquier candidato.
- NO ofrezcas ni menciones agendamiento de entrevista bajo ninguna circunstancia.
- Cuando ya tengás todos los datos y la hoja de vida, usá la acción "mark_female_pipeline"
  y cerrá con un mensaje formal y cálido, por ejemplo:
  "Listo [nombre], tus datos y hoja de vida quedaron registrados. Un integrante del equipo
  de selección revisará tu perfil y se comunicará contigo próximamente. ¡Muchas gracias
  por tu interés en LoginPro!"
- El mensaje debe sonar genuino, no como un rechazo.`;
  }

  // MALE u OTHER
  if (!schedulingEnabled) {
    return `GÉNERO: ${gender === 'MALE' ? 'Masculino' : 'Otro'} (detectado).
FLUJO SOLO POSTULACIÓN (acceptingApplications=true, schedulingEnabled=false):
- Recolección de datos: reúnica todos los campos requeridos de forma natural.
- Solicitud de hoja de vida: cuando los datos estén completos, pedí el CV.
- Cierre obligatorio: una vez tengás datos + HV, DEBÉS cerrar activamente con un mensaje
  formal y cálido. Ejemplo:
  "Listo [nombre], tu hoja de vida y datos quedaron registrados. El equipo de selección
  va a revisar tu perfil y si hay una coincidencia, te contactarán directamente.
  ¡Muchas gracias por postularte!"
- El cierre es ACTIVO: no esperes a que el candidato pregunte algo. Cuando estén
  completos datos + HV, enviá el mensaje de cierre y cerraba la conversación.
- NO ofrezcas ni menciones agendamiento de entrevista en ningún mensaje.
- NO usés las acciones offer_interview ni confirm_booking.
- Al cerrar: usá la acción "nothing" y nextStep debe ser "DONE".`;
  }

  return `GÉNERO: ${gender === 'MALE' ? 'Masculino' : 'Otro'} (detectado).
FLUJO COMPLETO (postulación + entrevista, schedulingEnabled=true):
- Recolección de datos, solicitud de CV.
- Una vez datos + CV completos, ofrecé el horario de entrevista disponible usando offer_interview.
- NO cerrés la conversación sin ofrecer la entrevista.`;
}

// ─────────────────────────────────────────────
// Instrucciones de manejo del paso CONFIRMING_DATA
// ─────────────────────────────────────────────

function buildConfirmationStepInstructions(currentStep) {
  if (currentStep !== 'CONFIRMING_DATA') return '';

  return `
INSTRUCCIONES CRÍTICAS PARA EL PASO ACTUAL (CONFIRMING_DATA):
Estás esperando que el candidato confirme o corrija sus datos.

CASO A — El candidato confirma (dice "sí", "si", "correcto", "está bien", "si está bien", "todo bien", "listo", etc.):
  → Interpretá CUALQUIER respuesta afirmativa como confirmación definitiva.
  → nextStep: "ASK_CV"
  → actions: [{ "type": "request_cv" }]
  → reply: pedí la hoja de vida de forma natural.
  → NO vuelvas a mostrar el resumen de datos. Ya están confirmados.

CASO B — El candidato corrige un dato (dice "no tengo restricción", "mi edad es 28", "me llamo...", etc.):
  → Extraé el dato corregido en extractedFields.
  → actions: [{ "type": "save_fields", "data": { ...campo_corregido } }, { "type": "request_confirmation" }]
  → nextStep: "CONFIRMING_DATA"
  → reply: mostrá el resumen COMPLETO actualizado con el dato ya corregido y preguntá de nuevo si todo está correcto.
  → IMPORTANTE: en el resumen usá el valor CORREGIDO que el candidato acaba de dar, NO el valor anterior.
  → El campo "restricciones médicas" debe mostrar exactamente lo que el candidato dijo.`;
}

function buildSchedulingStepInstructions(currentStep, candidate, vacancy, nextSlot) {
  if (!vacancy?.schedulingEnabled) return '';
  if (candidate.gender === 'FEMALE') {
    return `
INSTRUCCIÓN CRÍTICA DE AGENDA:
Aunque la vacante tenga agenda habilitada, una candidata femenina NO debe pasar por agendamiento automático.
Si ya tiene datos + hoja de vida, cerrá con "mark_female_pipeline".`;
  }

  if (!['ASK_CV', 'SCHEDULING', 'SCHEDULED', 'CONFIRMING_DATA', 'COLLECTING_DATA'].includes(currentStep)) {
    return '';
  }

  const slotInstruction = nextSlot?.isConfirmedBooking
    ? `La entrevista ya está agendada para ${nextSlot.formattedDate}.`
    : (nextSlot?.slot
      ? `Tienes disponible este horario para usar en la conversación: ${nextSlot.formattedDate}.`
      : 'En este momento NO hay un horario válido disponible.');

  const actionInstruction = nextSlot?.isConfirmedBooking
    ? '- Si el candidato pide cambiar la entrevista o dice que no puede asistir, usa "reschedule" solo si existe un siguiente slot válido.'
    : '- Si ya están completos los datos y la hoja de vida, y existe un horario válido, usa la acción "offer_interview" y continúa en SCHEDULING.';

  return `
INSTRUCCIONES CRÍTICAS DE AGENDA:
${slotInstruction}
${actionInstruction}
- Si el candidato confirma el horario ofrecido, usa "confirm_booking".
- Si el candidato indica que no puede asistir o pide otro horario, usa "reschedule" SOLO si existe un siguiente slot válido.
- Si no hay slot válido para ofrecer o reagendar, usa "pause_bot" con una razón clara.
- Si la vacante es solo postulación, nunca menciones entrevistas.`;
}

// ─────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────

function buildSystemPrompt({ vacancy, candidate, recentMessages, nextSlot, currentStep }) {
  const missingFields = getMissingFields(candidate);
  const hasMissing = missingFields.length > 0;
  const cvPending = !candidate.cvData && currentStep === 'ASK_CV';

  return `Sos un reclutador del equipo de selección de LoginPro, atendiendo candidatos por WhatsApp.
Sonás como una persona real — alguien del área de recursos humanos que conoce bien su trabajo
y trata bien a la gente. Tu forma de comunicarte es cercana, directa y sin formalismos innecesarios.

CÓMO SONÁS:
- Usás un tono colombiano natural. Podés decir "listo", "claro", "con gusto", "perfecto".
- Nunca usás listas con viñetas, numeración ni formato Markdown.
- Nunca usás negritas ni cursivas. Solo texto plano.
- Máximo 3 oraciones por respuesta. Menos es más en WhatsApp.
- Si el candidato saluda o se presenta, respondé el saludo con calidez antes de pedir cualquier dato.
- Usá el nombre del candidato de vez en cuando, no en cada mensaje.
- Si pregunta algo sobre el trabajo, respondé con lo que sabés. Si no sabés algo concreto, decí "eso te lo confirma el equipo directamente".
- Nunca digas que sos un bot o una IA. Si el candidato lo pregunta directamente, podés decir que sos del equipo de selección.
- No repitas frases que ya aparecen en el historial de esta conversación.
- Variá el lenguaje: no uses siempre el mismo saludo ni la misma forma de pedir un dato.

${buildVacancyContext(vacancy)}

${buildCandidateContext(candidate)}
${hasMissing ? `\nDatos que aún faltan: ${missingFields.join(', ')}` : '\nTodos los datos del candidato están completos.'}
${cvPending ? '\nEstá pendiente que el candidato envíe su hoja de vida.' : ''}
${buildNextSlotContext(nextSlot)}

${buildGenderFlowInstruction(candidate, vacancy)}
${buildSchedulingStepInstructions(currentStep, candidate, vacancy, nextSlot)}

PASO ACTUAL DEL FLUJO: ${currentStep}
${buildConfirmationStepInstructions(currentStep)}

HISTORIAL RECIENTE (últimos 8 mensajes):
${buildConversationHistory(recentMessages)}

TU TAREA:
Leé el último mensaje del candidato, entendé qué quiso decir, y devolvé SOLO un objeto JSON:

{
  "reply": string,
  "nextStep": string,
  "actions": [ { "type": string, "data": object } ],
  "extractedFields": object
}

nextStep válidos: MENU | GREETING_SENT | COLLECTING_DATA | CONFIRMING_DATA | ASK_CV | DONE | SCHEDULING | SCHEDULED

ACCIONES DISPONIBLES:
- "save_fields"           — guardar campos del candidato. data: { ...campos }
- "request_confirmation"  — pedir confirmación de datos
- "mark_rejected"         — no cumple requisitos. data: { reason, details }
- "offer_interview"       — ofrecer horario (SOLO MALE u OTHER con schedulingEnabled=true)
- "confirm_booking"       — candidato aceptó el horario
- "reschedule"            — candidato rechazó el horario, ofrecer el siguiente; si no hay siguiente slot, usa pause_bot
- "request_cv"            — pedir hoja de vida
- "mark_female_pipeline"  — candidata femenina completa: datos + CV listos, pasa a cola humana
- "mark_no_interest"      — candidato expresó que no quiere continuar
- "pause_bot"             — necesita atención humana. data: { reason }
- "nothing"               — no se requiere acción del sistema

CRITERIOS DE RECHAZO:
- Edad claramente fuera del rango de la vacante
- Documento vencido o inexistente (candidato lo menciona explícitamente)
- Extranjero sin CE, PPT o Pasaporte

Si el candidato da datos, extraélos en extractedFields aunque no todos vayan dentro de save_fields; el sistema también persistirá extractedFields.
Si el candidato hace una pregunta sobre la vacante, respóndela primero usando el contexto real y luego continúa el flujo sin repetir frases quemadas.
Si ya hay datos capturados en el historial, consolídalos con lo nuevo y pide solo lo realmente faltante.
Decidí si hay suficientes datos para pedir confirmación, o si aún faltan campos importantes.
En ese caso, pedílos de forma natural — nunca como un formulario.

Devolvé SOLO el JSON. Sin texto antes ni después.`;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const REQUIRED_FIELDS = [
  'fullName', 'documentType', 'documentNumber', 'age',
  'neighborhood', 'experienceInfo', 'experienceTime',
  'medicalRestrictions', 'transportMode'
];

const FIELD_LABELS = {
  fullName:             'nombre completo',
  documentType:         'tipo de documento',
  documentNumber:       'número de documento',
  age:                  'edad',
  neighborhood:         'barrio',
  experienceInfo:       'experiencia en el cargo',
  experienceTime:       'tiempo de experiencia',
  medicalRestrictions:  'restricciones médicas',
  transportMode:        'medio de transporte'
};

function getMissingFields(candidate) {
  return REQUIRED_FIELDS
    .filter((f) => !candidate[f] && candidate[f] !== 0)
    .map((f) => FIELD_LABELS[f]);
}

function parseEngineJson(rawText = '{}') {
  const t = String(rawText || '').trim();
  try { return JSON.parse(t); } catch { /* fall */ }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) { try { return JSON.parse(fenced[1].trim()); } catch { /* fall */ } }
  const objMatch = t.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch { /* fall */ } }
  return null;
}

function mergeEngineFields(actions = [], extractedFields = {}) {
  const merged = { ...(extractedFields || {}) };
  for (const action of actions || []) {
    if (action?.type !== 'save_fields' || typeof action?.data !== 'object' || !action.data) continue;
    Object.assign(merged, action.data);
  }
  return merged;
}

function mapEngineGender(rawGender, Gender) {
  if (!rawGender) return null;
  const gMap = { MALE: Gender.MALE, FEMALE: Gender.FEMALE, OTHER: Gender.OTHER };
  return gMap[String(rawGender).toUpperCase()] || null;
}

// ─────────────────────────────────────────────
// think() — el razonamiento central
// ─────────────────────────────────────────────

/**
 * Llama a OpenAI con el contexto completo y obtiene reply, nextStep, actions, extractedFields.
 *
 * @param {object} p
 * @param {string}       p.inboundText
 * @param {object}       p.candidate
 * @param {object|null}  p.vacancy
 * @param {Array}        p.recentMessages  — se pasan los últimos 8 mensajes para mejor contexto
 * @param {object|null}  p.nextSlot
 * @param {string}       p.currentStep
 */
export async function think({ inboundText, candidate, vacancy, recentMessages = [], nextSlot = null, currentStep }) {
  const fallbackReply = '¡Hola! Gracias por escribir. ¿En qué puedo ayudarte?';

  if (!process.env.OPENAI_API_KEY) {
    return { reply: fallbackReply, nextStep: currentStep, actions: [], extractedFields: {}, raw: null, fallback: true };
  }

  try {
    const model = DEFAULT_MODEL;
    const temp = parseOptionalTemperature();
    const useTemp = temp.value !== null && modelSupportsTemperature(model);

    const response = await axios.post(
      OPENAI_URL,
      {
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt({ vacancy, candidate, recentMessages, nextSlot, currentStep }) },
          { role: 'user', content: String(inboundText || '') }
        ],
        max_completion_tokens: 600,
        ...(useTemp ? { temperature: temp.value } : {})
      },
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 18000
      }
    );

    const raw = parseEngineJson(response.data?.choices?.[0]?.message?.content || '{}');

    if (!raw || typeof raw.reply !== 'string') {
      console.warn('[ENGINE_PARSE_FAIL]', { phone: candidate?.phone });
      return { reply: fallbackReply, nextStep: currentStep, actions: [], extractedFields: {}, raw, fallback: true };
    }

    return {
      reply:           raw.reply.trim(),
      nextStep:        raw.nextStep || currentStep,
      actions:         Array.isArray(raw.actions) ? raw.actions : [],
      extractedFields: raw.extractedFields || {},
      raw,
      fallback:        false
    };
  } catch (error) {
    console.error('[ENGINE_ERROR]', { phone: candidate?.phone, error: error?.message?.slice(0, 200) });
    return { reply: fallbackReply, nextStep: currentStep, actions: [], extractedFields: {}, raw: null, fallback: true };
  }
}

// ─────────────────────────────────────────────
// act() — ejecuta las acciones indicadas por think()
// ─────────────────────────────────────────────

/**
 * Ejecuta las acciones que OpenAI ordenó.
 * Solo efectos secundarios — sin lógica de negocio.
 *
 * @param {object} p
 * @param {Array}            p.actions
 * @param {object}           p.candidate
 * @param {string}           p.nextStep
 * @param {object|null}      p.nextSlot
 * @param {PrismaClient}     p.prisma
 */
export async function act({ actions, candidate, extractedFields = {}, nextStep, nextSlot, prisma }) {
  const { normalizeCandidateFields }  = await import('./candidateData.js');
  const { cancelCandidateBookings, createBooking } = await import('./interviewScheduler.js');
  const { CandidateStatus, ConversationStep, Gender } = await import('@prisma/client');
  const normalizedActions = Array.isArray(actions) ? actions : [];
  const mergedRawFields = mergeEngineFields(normalizedActions, extractedFields);
  const mergedFields = normalizeCandidateFields(mergedRawFields);
  const mappedGender = mapEngineGender(mergedRawFields.gender, Gender);
  if (mappedGender) mergedFields.gender = mappedGender;

  if (Object.keys(mergedFields).length) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: mergedFields })
      .catch((err) => console.error('[ACT_FIELDS_ERROR]', { error: err?.message?.slice(0, 200) }));
  }

  const pendingUpdate = {};
  let terminalStep = null;
  let requestedStep = null;
  const setStep = (step, options = {}) => {
    if (!step) return;
    if (options.terminal) {
      terminalStep = step;
      return;
    }
    if (!terminalStep) requestedStep = step;
  };

  for (const action of normalizedActions) {
    try {
      switch (action.type) {

        case 'save_fields':
          break;

        case 'request_cv':
          setStep(ConversationStep.ASK_CV);
          break;

        case 'request_confirmation':
          setStep(ConversationStep.CONFIRMING_DATA);
          break;

        case 'mark_female_pipeline': {
          pendingUpdate.gender = Gender.FEMALE;
          pendingUpdate.status = CandidateStatus.REGISTRADO;
          pendingUpdate.botPaused = true;
          pendingUpdate.botPausedAt = new Date();
          pendingUpdate.botPauseReason = 'Candidata femenina — pendiente revisión humana de hoja de vida';
          pendingUpdate.reminderScheduledFor = null;
          pendingUpdate.reminderState = 'SKIPPED';
          setStep(ConversationStep.DONE, { terminal: true });
          console.info('[FEMALE_PIPELINE]', { phone: candidate.phone, candidateId: candidate.id });
          break;
        }

        case 'mark_rejected': {
          pendingUpdate.status = CandidateStatus.RECHAZADO;
          pendingUpdate.rejectionReason = action.data?.reason || 'No cumple requisitos';
          pendingUpdate.rejectionDetails = action.data?.details || null;
          pendingUpdate.reminderScheduledFor = null;
          pendingUpdate.reminderState = 'SKIPPED';
          setStep(ConversationStep.DONE, { terminal: true });
          break;
        }

        case 'confirm_booking': {
          if (!nextSlot?.slot || !candidate.vacancyId) {
            console.warn('[ACT_SKIPPED]', { action: action.type, reason: 'missing_slot_or_vacancy' });
            break;
          }
          await cancelCandidateBookings(
            prisma,
            candidate.id,
            candidate.currentStep === ConversationStep.SCHEDULED ? 'RESCHEDULED' : 'CANCELLED'
          );
          await createBooking(
            prisma, candidate.id, candidate.vacancyId,
            nextSlot.slot.id, nextSlot.date, !nextSlot.windowOk
          );
          pendingUpdate.reminderScheduledFor = null;
          pendingUpdate.reminderState = 'SKIPPED';
          setStep(ConversationStep.SCHEDULED, { terminal: true });
          break;
        }

        case 'mark_no_interest': {
          pendingUpdate.reminderScheduledFor = null;
          pendingUpdate.reminderState = 'SKIPPED';
          setStep(ConversationStep.DONE, { terminal: true });
          break;
        }

        case 'pause_bot': {
          pendingUpdate.botPaused = true;
          pendingUpdate.botPausedAt = new Date();
          pendingUpdate.botPauseReason = action.data?.reason || 'Requiere atención humana';
          pendingUpdate.reminderScheduledFor = null;
          pendingUpdate.reminderState = 'CANCELLED';
          break;
        }

        case 'offer_interview':
        case 'reschedule':
          if (!nextSlot?.slot) {
            pendingUpdate.botPaused = true;
            pendingUpdate.botPausedAt = new Date();
            pendingUpdate.botPauseReason = action.type === 'reschedule'
              ? 'No hay un siguiente slot valido para reagendar'
              : 'Vacante con agenda habilitada sin slots validos disponibles';
            pendingUpdate.reminderScheduledFor = null;
            pendingUpdate.reminderState = 'CANCELLED';
            break;
          }
          pendingUpdate.reminderScheduledFor = null;
          pendingUpdate.reminderState = 'SKIPPED';
          setStep(ConversationStep.SCHEDULING);
          break;

        case 'nothing':
          console.info('[ACT_NOOP]', { action: action.type, candidateId: candidate.id });
          break;

        default:
          console.warn('[ACT_UNHANDLED]', { action: action?.type || 'unknown', candidateId: candidate.id });
          break;
      }
    } catch (err) {
      console.error('[ACT_ERROR]', { action: action.type, error: err?.message?.slice(0, 200) });
    }
  }

  const validSteps = Object.values(ConversationStep);
  const finalStep = terminalStep
    || requestedStep
    || (nextStep && validSteps.includes(nextStep) ? nextStep : null);

  if (finalStep && finalStep !== candidate.currentStep) {
    pendingUpdate.currentStep = finalStep;
  }

  if (Object.keys(pendingUpdate).length) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: pendingUpdate
    }).catch((e) => console.error('[ACT_STEP_UPDATE_ERROR]', e?.message));
  }
}
