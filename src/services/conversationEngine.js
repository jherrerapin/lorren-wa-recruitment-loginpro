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
 *   MALE    → flujo completo: datos → CV → agendamiento de entrevista
 *   FEMALE  → flujo alternativo: datos → CV → cierre amable → cola revisión humana
 *   UNKNOWN → OpenAI pregunta el género de forma natural durante la recolección de datos
 */

import axios from 'axios';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// ─────────────────────────────────────────────
// Helpers de contexto
// ─────────────────────────────────────────────

function buildCandidateContext(candidate) {
  const genderLabel = {
    MALE: 'Masculino',
    FEMALE: 'Femenino',
    OTHER: 'Otro',
    UNKNOWN: 'No determinado aún'
  }[candidate.gender] ?? 'No determinado aún';

  const fields = [
    candidate.fullName        && `Nombre: ${candidate.fullName}`,
    candidate.documentType && candidate.documentNumber
                              && `Documento: ${candidate.documentType} ${candidate.documentNumber}`,
    candidate.age             && `Edad: ${candidate.age}`,
    candidate.gender          && `Género: ${genderLabel}`,
    candidate.neighborhood    && `Barrio: ${candidate.neighborhood}`,
    candidate.experienceInfo  && `Experiencia: ${candidate.experienceInfo}`,
    candidate.experienceTime  && `Tiempo de experiencia: ${candidate.experienceTime}`,
    candidate.medicalRestrictions && `Restricciones médicas: ${candidate.medicalRestrictions}`,
    candidate.transportMode   && `Transporte: ${candidate.transportMode}`
  ].filter(Boolean);

  return fields.length
    ? `Datos capturados hasta ahora:\n${fields.join('\n')}`
    : 'No se han capturado datos aún.';
}

function buildVacancyContext(vacancy) {
  if (!vacancy) return 'Vacante: no identificada aún.';
  return [
    `Vacante: ${vacancy.title || vacancy.role}`,
    `Cargo: ${vacancy.role}`,
    `Ciudad: ${vacancy.city}`,
    vacancy.operationAddress  && `Dirección: ${vacancy.operationAddress}`,
    `Requisitos: ${vacancy.requirements}`,
    `Condiciones: ${vacancy.conditions}`,
    vacancy.requiredDocuments && `Documentación para entrevista: ${vacancy.requiredDocuments}`,
    vacancy.roleDescription   && `Descripción del cargo: ${vacancy.roleDescription}`,
    vacancy.schedulingEnabled ? 'Agendamiento de entrevistas: habilitado' : 'Agendamiento: no aplica'
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
  const warning = !nextSlot.windowOk && nextSlot.windowExtension?.needsWindowExtension
    ? ' (fuera de ventana 24h de WhatsApp — se programará re-enganche automático)'
    : '';
  return `\nPróximo slot de entrevista disponible: ${nextSlot.formattedDate}${warning}`;
}

// ─────────────────────────────────────────────
// Lógica de género — decide el flujo
// ─────────────────────────────────────────────

/**
 * Retorna la instrucción de flujo según el género detectado.
 * UNKNOWN → OpenAI pregunta de forma natural.
 * FEMALE  → recolectar todo + CV, pero NO agendar, cerrar con cola humana.
 * MALE    → flujo completo incluyendo agendamiento si schedulingEnabled.
 */
function buildGenderFlowInstruction(candidate, vacancy) {
  const gender = candidate.gender ?? 'UNKNOWN';

  if (gender === 'UNKNOWN') {
    return `GÉNERO: No determinado aún.
Durante la recolección de datos, determina el género del candidato de forma natural.
Puedes inferirlo del nombre si es inequívoco (María → FEMALE, Carlos → MALE).
Si el nombre no lo aclara, pregúntalo de forma amable y directa en algún momento
durante la conversación (no como primer dato, sino cuando sea natural).
Extráelo en extractedFields como "gender": "MALE" | "FEMALE" | "OTHER".`;
  }

  if (gender === 'FEMALE') {
    return `GÉNERO: Femenino (detectado).
FLUJO ESPECIAL — CANDIDATA FEMENINA:
- Continúa recolectando todos los datos normalmente (nombre, documento, edad, barrio, etc.).
- Solicita la hoja de vida igual que con cualquier candidato.
- NO ofrezcas ni menciones agendamiento de entrevista. No uses la acción offer_interview ni confirm_booking.
- Cuando ya tengas todos los datos y la hoja de vida, usa la acción "mark_female_pipeline"
  y cierra la conversación de forma amable con un mensaje como:
  "Listo [nombre], tus datos quedaron registrados. Un reclutador del equipo va a revisar
  tu hoja de vida y se comunicará contigo pronto. ¡Muchas gracias por tu interés!"
- Ese mensaje debe sonar natural y cálido, no como un rechazo.`;
  }

  // MALE u OTHER → flujo normal
  return `GÉNERO: ${gender === 'MALE' ? 'Masculino' : 'Otro'} (detectado).
FLUJO NORMAL: recolecta todos los datos, solicita CV, y si schedulingEnabled ofrece entrevista.`;
}

// ─────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────

function buildSystemPrompt({ vacancy, candidate, recentMessages, nextSlot, currentStep }) {
  const missingFields = getMissingFields(candidate);
  const hasMissing = missingFields.length > 0;
  const cvPending = !candidate.cvData && currentStep === 'ASK_CV';

  return `Eres un reclutador humano de LoginPro atendiendo candidatos por WhatsApp.
Tu nombre no importa — eres simplemente la persona del equipo de selección.

TONO Y ESTILO:
- Natural, cálido, directo. Como un colombiano trabajando en RRHH.
- Sin listas con viñetas. Sin formato Markdown. Sin negritas.
- Máximo 3-4 oraciones por respuesta.
- Usa el nombre del candidato cuando sea natural, no en cada frase.
- Si el candidato saluda, responde el saludo antes de pedir datos.
- Si pregunta algo sobre la vacante, respóndelo con la info que tienes.
- Si no sabes algo: "eso lo maneja directamente el equipo, te confirman".
- Nunca digas que eres un bot o IA, a menos que el candidato lo pregunte directamente.
- No repitas frases que ya enviaste antes en el historial.

${buildVacancyContext(vacancy)}

${buildCandidateContext(candidate)}
${hasMissing ? `\nDatos que aún faltan: ${missingFields.join(', ')}` : '\nTodos los datos del candidato están completos.'}
${cvPending ? '\nEstá pendiente que el candidato envíe su hoja de vida.' : ''}
${buildNextSlotContext(nextSlot)}

${buildGenderFlowInstruction(candidate, vacancy)}

PASO ACTUAL DEL FLUJO: ${currentStep}

HISTORIAL RECIENTE:
${buildConversationHistory(recentMessages)}

TU TAREA:
Lee el último mensaje del candidato, entiende qué quiso decir, y devuelve SOLO un objeto JSON:

{
  "reply": string,
  "nextStep": string,
  "actions": [ { "type": string, "data": object } ],
  "extractedFields": object
}

nextStep válidos: MENU | GREETING_SENT | COLLECTING_DATA | CONFIRMING_DATA | ASK_CV | DONE | SCHEDULING | SCHEDULED | FEMALE_PIPELINE_DONE

ACCIONES DISPONIBLES:
- "save_fields"           — guardar campos del candidato. data: { ...campos }
- "request_confirmation"  — pedir confirmación de datos
- "mark_rejected"         — no cumple requisitos. data: { reason, details }
- "offer_interview"       — ofrecer horario (solo candidatos MALE u OTHER, requiere nextSlot)
- "confirm_booking"       — candidato aceptó el horario
- "reschedule"            — candidato rechazó el horario, ofrecer el siguiente
- "request_cv"            — pedir hoja de vida
- "mark_female_pipeline"  — candidata femenina completa: datos + CV listos, pasa a cola humana
- "mark_no_interest"      — candidato expresó que no quiere continuar
- "pause_bot"             — necesita atención humana. data: { reason }
- "nothing"               — no se requiere acción del sistema

CRITERIOS DE RECHAZO:
- Edad claramente fuera del rango de la vacante
- Documento vencido o inexistente (candidato lo menciona explícitamente)
- Extranjero sin CE, PPT o Pasaporte

Si el candidato da datos, extráelos en extractedFields e incluye save_fields en actions.
Decide si hay suficientes datos para pedir confirmación, o si aún faltan campos importantes.
En ese caso, pídeselos de forma natural — nunca como un formulario.

Devuelve SOLO el JSON. Sin texto antes ni después.`;
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
 * @param {Array}        p.recentMessages
 * @param {object|null}  p.nextSlot
 * @param {string}       p.currentStep
 */
export async function think({ inboundText, candidate, vacancy, recentMessages = [], nextSlot = null, currentStep }) {
  const fallbackReply = '¡Hola! Gracias por escribir. ¿En qué puedo ayudarte?';

  if (!process.env.OPENAI_API_KEY) {
    return { reply: fallbackReply, nextStep: currentStep, actions: [], extractedFields: {}, raw: null, fallback: true };
  }

  try {
    const response = await axios.post(
      OPENAI_URL,
      {
        model: DEFAULT_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt({ vacancy, candidate, recentMessages, nextSlot, currentStep }) },
          { role: 'user', content: String(inboundText || '') }
        ],
        max_completion_tokens: 600,
        temperature: 0.55
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
export async function act({ actions, candidate, nextStep, nextSlot, prisma }) {
  const { normalizeCandidateFields }  = await import('./candidateData.js');
  const { createBooking }             = await import('./interviewScheduler.js');
  const { CandidateStatus, ConversationStep, Gender } = await import('@prisma/client');

  for (const action of actions) {
    try {
      switch (action.type) {

        case 'save_fields': {
          const raw    = action.data || {};
          const fields = normalizeCandidateFields(raw);

          // Normalizar género si OpenAI lo extrajo
          if (raw.gender) {
            const gMap = { MALE: Gender.MALE, FEMALE: Gender.FEMALE, OTHER: Gender.OTHER };
            const normalized = gMap[String(raw.gender).toUpperCase()];
            if (normalized) fields.gender = normalized;
          }

          if (Object.keys(fields).length) {
            await prisma.candidate.update({ where: { id: candidate.id }, data: fields });
          }
          break;
        }

        case 'mark_female_pipeline': {
          // Candidata femenina completa: marcar como REGISTRADO, paso DONE,
          // gender FEMALE, bot pausado para revisión humana.
          await prisma.candidate.update({
            where: { id: candidate.id },
            data: {
              gender:          Gender.FEMALE,
              status:          CandidateStatus.REGISTRADO,
              currentStep:     ConversationStep.DONE,
              botPaused:       true,
              botPausedAt:     new Date(),
              botPauseReason:  'Candidata femenina — pendiente revisión humana de hoja de vida',
              reminderScheduledFor: null,
              reminderState:   'SKIPPED'
            }
          });
          console.info('[FEMALE_PIPELINE]', { phone: candidate.phone, candidateId: candidate.id });
          break;
        }

        case 'mark_rejected': {
          await prisma.candidate.update({
            where: { id: candidate.id },
            data: {
              status:           CandidateStatus.RECHAZADO,
              currentStep:      ConversationStep.DONE,
              rejectionReason:  action.data?.reason  || 'No cumple requisitos',
              rejectionDetails: action.data?.details || null,
              reminderScheduledFor: null,
              reminderState:    'SKIPPED'
            }
          });
          break;
        }

        case 'confirm_booking': {
          if (!nextSlot?.slot || !candidate.vacancyId) break;
          await createBooking(
            prisma, candidate.id, candidate.vacancyId,
            nextSlot.slot.id, nextSlot.date, !nextSlot.windowOk
          );
          await prisma.candidate.update({
            where: { id: candidate.id },
            data:  { currentStep: ConversationStep.SCHEDULED }
          });
          break;
        }

        case 'mark_no_interest': {
          await prisma.candidate.update({
            where: { id: candidate.id },
            data:  { currentStep: ConversationStep.DONE }
          });
          break;
        }

        case 'pause_bot': {
          await prisma.candidate.update({
            where: { id: candidate.id },
            data: {
              botPaused:      true,
              botPausedAt:    new Date(),
              botPauseReason: action.data?.reason || 'Requiere atención humana'
            }
          });
          break;
        }

        // nothing | request_confirmation | offer_interview | reschedule | request_cv
        // — reply ya generado por think(), sin efecto en DB
        default:
          break;
      }
    } catch (err) {
      console.error('[ACT_ERROR]', { action: action.type, error: err?.message?.slice(0, 200) });
    }
  }

  // Actualizar paso del flujo si cambió
  const validSteps = Object.values(ConversationStep);
  if (nextStep && validSteps.includes(nextStep) && nextStep !== candidate.currentStep) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data:  { currentStep: nextStep }
    }).catch((e) => console.error('[ACT_STEP_UPDATE_ERROR]', e?.message));
  }
}
