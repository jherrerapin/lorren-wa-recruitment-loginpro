/**
 * conversationEngine.js
 *
 * AI-first conversational core:
 * - think() lets the model reason over a curated candidate/vacancy state.
 * - act() applies deterministic side effects and hard guard rails.
 *
 * The model decides what is missing, what was corrected and how to reply.
 * JS keeps persistence, scheduling, CV flow and safety rules deterministic.
 */

import axios from 'axios';
import { modelSupportsTemperature, parseOptionalTemperature } from './aiParser.js';
import { splitFieldDecisions } from './debugTrace.js';
import { getCandidateResidenceValue, getResidenceFieldConfig } from './candidateData.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const ENGINE_FALLBACK_REPLY = 'Te lei, dame un momento y continuo contigo.';
const CORE_PROFILE_FIELDS = [
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'medicalRestrictions',
  'transportMode'
];

function extractUsage(responseData = {}) {
  const usage = responseData?.usage || {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (inputTokens + outputTokens);
  return {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0
  };
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function buildFieldState(value) {
  return hasValue(value)
    ? { captured: true, value }
    : { captured: false };
}

function getCoreFieldGaps(candidate = {}, vacancy = null) {
  const gaps = CORE_PROFILE_FIELDS.filter((field) => !hasValue(candidate[field]));
  if (!hasValue(getCandidateResidenceValue(candidate, vacancy || candidate?.vacancy))) {
    gaps.push(getResidenceFieldConfig(vacancy || candidate?.vacancy).field);
  }
  return gaps;
}

function normalizeMedicalRestrictionsLabel(value) {
  if (!value) return null;
  const normalized = String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (/sin restricciones?|no tengo restricciones?|ninguna restriccion/.test(normalized)) {
    return 'Sin restricciones medicas';
  }
  return value;
}

function isSystemControlledOutbound(message = {}) {
  const source = message?.rawPayload?.source;
  return typeof source === 'string' && source.trim() !== '';
}

export function hasRecentHumanIntervention(recentMessages = []) {
  const lastOutbound = [...(recentMessages || [])]
    .reverse()
    .find((message) => message?.direction === 'OUTBOUND');

  return Boolean(lastOutbound) && !isSystemControlledOutbound(lastOutbound);
}

function buildMessageActor(message = {}) {
  if (message.direction === 'INBOUND') return 'Candidato';
  if (!isSystemControlledOutbound(message)) return 'Humano';
  if (String(message?.rawPayload?.source || '').startsWith('admin_')) return 'Equipo';
  return 'Bot';
}

export function buildCandidateStateForModel(candidate = {}, vacancy = null, recentMessages = []) {
  const genderLabel = {
    MALE: 'Masculino',
    FEMALE: 'Femenino',
    OTHER: 'Otro',
    UNKNOWN: 'No determinado'
  }[candidate.gender] ?? 'No determinado';

  const hasCv = Boolean(candidate.cvStorageKey || candidate.cvData || candidate.cvOriginalName || candidate.cvMimeType);
  const coreDataComplete = getCoreFieldGaps(candidate, vacancy).length === 0;
  const residenceConfig = getResidenceFieldConfig(vacancy || candidate?.vacancy);
  const residenceValue = getCandidateResidenceValue(candidate, vacancy || candidate?.vacancy);

  return {
    currentStep: candidate.currentStep || 'MENU',
    status: candidate.status || null,
    vacancyResolved: Boolean(candidate.vacancyId),
    botPaused: Boolean(candidate.botPaused),
    botPauseReason: candidate.botPauseReason || null,
    humanInterventionDetected: hasRecentHumanIntervention(recentMessages),
    progress: {
      coreDataComplete,
      hasCv,
      readyForCvRequest: coreDataComplete && !hasCv,
      readyForScheduling: coreDataComplete && hasCv,
      femalePipeline: candidate.gender === 'FEMALE'
    },
    profile: {
      fullName: buildFieldState(candidate.fullName),
      documentType: buildFieldState(candidate.documentType),
      documentNumber: buildFieldState(candidate.documentNumber),
      age: buildFieldState(candidate.age),
      gender: buildFieldState(genderLabel),
      neighborhood: buildFieldState(candidate.neighborhood),
      locality: buildFieldState(candidate.locality),
      residenceArea: {
        field: residenceConfig.field,
        label: residenceConfig.label,
        state: buildFieldState(residenceValue)
      },
      medicalRestrictions: buildFieldState(normalizeMedicalRestrictionsLabel(candidate.medicalRestrictions)),
      transportMode: buildFieldState(candidate.transportMode),
      experienceInfo: buildFieldState(candidate.experienceInfo),
      experienceTime: buildFieldState(candidate.experienceTime)
    }
  };
}

export function buildVacancyStateForModel(vacancy) {
  if (!vacancy) {
    return {
      resolved: false
    };
  }

  const availabilityStatus = vacancy.isActive && vacancy.acceptingApplications
    ? 'OPEN'
    : (vacancy.isActive ? 'PAUSED' : 'INACTIVE');

  return {
    resolved: true,
    title: vacancy.title || vacancy.role || null,
    role: vacancy.role || vacancy.title || null,
    city: vacancy.operation?.city?.name || vacancy.city || null,
    availabilityStatus,
    operation: {
      name: vacancy.operation?.name || null,
      zone: vacancy.operationAddress || null,
      interviewAddress: vacancy.interviewAddress || null
    },
    schedulingEnabled: Boolean(vacancy.schedulingEnabled),
    acceptingApplications: Boolean(vacancy.acceptingApplications),
    isActive: Boolean(vacancy.isActive),
    requirements: vacancy.requirements || null,
    conditions: vacancy.conditions || null,
    requiredDocuments: vacancy.requiredDocuments || null,
    roleDescription: vacancy.roleDescription || null
  };
}

function buildConversationHistory(recentMessages = []) {
  if (!recentMessages.length) return 'Sin historial previo.';
  return recentMessages
    .map((message) => `${buildMessageActor(message)}: ${message.body || ''}`)
    .join('\n');
}

function buildNextSlotContext(nextSlot) {
  if (!nextSlot?.slot) return '';

  const label = nextSlot.isConfirmedBooking
    ? 'Entrevista ya agendada'
    : (nextSlot.isAlternative ? 'Siguiente slot de entrevista disponible' : 'Slot de entrevista disponible');

  const warning = !nextSlot.windowOk && nextSlot.windowExtension?.needsWindowExtension
    ? ' (fuera de ventana 24h de WhatsApp; requiere reenganche)'
    : '';

  const previousOfferLine = nextSlot.previousFormattedDate
    ? `\nHorario anterior rechazado: ${nextSlot.previousFormattedDate}`
    : '';

  return `${previousOfferLine}\n${label}: ${nextSlot.formattedDate}${warning}`;
}

function buildGenderFlowInstruction(candidate, vacancy) {
  const gender = candidate.gender ?? 'UNKNOWN';
  const schedulingEnabled = vacancy?.schedulingEnabled ?? false;

  if (gender === 'UNKNOWN') {
    return `GENERO: No determinado.
Detecta el genero usando comprension semantica del turno completo y del historial reciente, no por coincidencia literal de una palabra.
Si hay evidencia clara y consistente en contexto, extraelo sin esperar otra confirmacion.
Si la evidencia es ambigua, no infieras: preguntalo cuando sea natural.
Extraelo en extractedFields como "gender": "MALE" | "FEMALE" | "OTHER".`;
  }

  if (gender === 'FEMALE') {
    return `GENERO: Femenino.
FLUJO ESPECIAL:
- Recolecta datos y hoja de vida normalmente.
- NO ofrezcas ni menciones agendamiento automatico.
- Cuando haya datos + HV, usa "mark_female_pipeline" y cierra de forma calida.`;
  }

  if (!schedulingEnabled) {
    return `GENERO: ${gender === 'MALE' ? 'Masculino' : 'Otro'}.
FLUJO SOLO POSTULACION:
- Recolecta datos y hoja de vida.
- Cuando ya exista datos + HV, cierra el proceso con nextStep "DONE".
- NO menciones entrevistas ni uses acciones de agenda.`;
  }

  return `GENERO: ${gender === 'MALE' ? 'Masculino' : 'Otro'}.
FLUJO POSTULACION + ENTREVISTA:
- Recolecta datos y hoja de vida.
- Cuando ya exista datos + HV y haya un slot valido, usa "offer_interview".
- No cierres la conversacion antes de manejar la agenda.`;
}

function buildConfirmationStepInstructions(currentStep) {
  if (currentStep !== 'CONFIRMING_DATA') return '';

  return `
INSTRUCCIONES PARA CONFIRMING_DATA:
- CONFIRMING_DATA no es una trampa ni un formulario.
- Si el candidato confirma con "si", "correcto", "esta bien", "todo bien" o parecido, tomalo como confirmacion real.
- Si ya hay informacion suficiente, sal de este paso y pasa a ASK_CV o al siguiente paso util.
- Si falta algo real, pide solo ese dato y vuelve a COLLECTING_DATA.
- Si el candidato corrige un dato en lenguaje natural, sobrescribelo y sigue normal.
- No vuelvas a pedir todo el resumen salvo ambiguedad real o conflicto real.
- Si al confirmar tambien pregunta algo, responde primero la pregunta y luego continua.`;
}

function buildSchedulingStepInstructions(currentStep, candidate, vacancy, nextSlot) {
  if (!vacancy?.schedulingEnabled) return '';

  if (!vacancy?.isActive || !vacancy?.acceptingApplications) {
    return `
INSTRUCCION CRITICA DE DISPONIBILIDAD:
- Esta vacante no esta abierta para recibir personal en este momento.
- No ofrezcas entrevistas ni agendamiento.
- Puedes pedir datos y hoja de vida para dejar el perfil registrado por si se reactiva.`;
  }

  if (candidate.gender === 'FEMALE') {
    return `
INSTRUCCION CRITICA DE AGENDA:
Aunque la vacante tenga agenda habilitada, una candidata femenina NO debe pasar por agendamiento automatico.
Si ya tiene datos + hoja de vida, usa "mark_female_pipeline".`;
  }

  if (!['ASK_CV', 'SCHEDULING', 'SCHEDULED', 'CONFIRMING_DATA', 'COLLECTING_DATA'].includes(currentStep)) {
    return '';
  }

  const slotInstruction = nextSlot?.isConfirmedBooking
    ? `La entrevista ya esta agendada para ${nextSlot.formattedDate}.`
    : (nextSlot?.slot
      ? `Hay un horario valido disponible: ${nextSlot.formattedDate}.`
      : 'No hay un horario valido disponible ahora.');

  const actionInstruction = nextSlot?.isConfirmedBooking
    ? '- Si el candidato pide cambiar la entrevista o dice que no puede, usa "reschedule" solo si existe un siguiente slot valido.'
    : '- Si ya estan completos los datos y la hoja de vida, y existe un horario valido, usa "offer_interview".';

  return `
INSTRUCCIONES CRITICAS DE AGENDA:
${slotInstruction}
${actionInstruction}
- Si el candidato confirma el horario, usa "confirm_booking".
- Si el candidato indica que no puede asistir o pide otro horario, usa "reschedule" solo si existe un siguiente slot valido.
- Si no hay slot valido para ofrecer o reagendar, usa "pause_bot" con una razon clara.
- Si la vacante es solo postulacion, nunca menciones entrevistas.`;
}

function buildSystemPrompt({ vacancy, candidate, recentMessages, nextSlot, currentStep }) {
  const candidateState = buildCandidateStateForModel(candidate, vacancy, recentMessages);
  const vacancyState = buildVacancyStateForModel(vacancy);

  return `Sos un reclutador del equipo de seleccion de LoginPro atendiendo candidatos por WhatsApp.
Suena como una persona real del area de seleccion: cercana, clara, agil y humana.

COMO RESPONDES:
- Usa tono colombiano natural.
- Maximo 3 oraciones por respuesta.
- No uses listas con vietas, numeracion ni Markdown en la respuesta.
- No digas que eres un bot o una IA.
- No repitas frases casi iguales a mensajes recientes del bot.
- No mezcles varias plantillas en una sola respuesta.

PRIORIDADES:
- Antes de responder, relee el historial reciente completo y el estado curado.
- Entiende la intencion real del candidato antes de pedir datos.
- Si el candidato pregunta algo de la vacante, responde eso primero.
- Si plantea una objecion, atiendela antes de retomar el flujo.
- Si ya envio datos en fragmentos, consolidalos.
- Si corrige algo, usa el valor nuevo y no reabras la misma confirmacion.
- Si detectas un dato incoherente con el contexto reciente, corrigelo o pídelo de forma puntual; no confirmes datos absurdos.
- Si ya envio la hoja de vida y en este mensaje por fin aclara ciudad o vacante, ubica el proceso, explica brevemente la vacante real y luego sigue solo con lo faltante.
- Si expresa no interes, cierra correctamente con "mark_no_interest".
- Si un humano ya intervino, no respondas encima; usa "pause_bot" o "nothing" segun corresponda.

FALLOS RECURRENTES QUE DEBES EVITAR:
- No tomes saludos como nombre.
- No confundas edad con anos de experiencia.
- No pierdas datos enviados en varios fragmentos.
- No ignores transportes como carro, automovil, bici, bicicleta, cicla, bus o independiente.
- Si la vacante es en Bogota, pide y usa la localidad como zona de residencia; no sigas pidiendo barrio.
- Si el candidato da una localidad o la menciona como barrio para Bogota, guardala como localidad.
- No uses la frase "barrio o localidad": pide un solo dato segun la ciudad (Bogota = localidad; otras ciudades = barrio).
- Si la vacante exige experiencia (experienceRequired = YES), debes pedir y capturar experiencia (si/no) y tiempo de experiencia.
- Si la vacante NO exige experiencia, no bloquees el avance por ese dato.
- Si el candidato pregunta por ciudad y no hay vacantes activas, explicalo con claridad.
- Si la vacante existe pero esta inactiva o pausada, explica que hoy no se esta recibiendo personal, pero aun puedes pedir datos y hoja de vida para dejar el perfil registrado.
- Si despues de datos + hoja de vida o despues de una entrevista agendada aparece una pregunta que no puedes responder con la vacante o el historial, usa "pause_bot" con una razon concreta.
- No te quedes en bucle cuando el usuario corrige.
- No reabras confirmacion si el dato ya fue corregido.
- No respondas como formulario disfrazado.

ESTADO CURADO DE LA VACANTE (JSON):
${JSON.stringify(vacancyState, null, 2)}

ESTADO CURADO DEL CANDIDATO (JSON):
${JSON.stringify(candidateState, null, 2)}

${buildNextSlotContext(nextSlot)}

${buildGenderFlowInstruction(candidate, vacancy)}
${buildSchedulingStepInstructions(currentStep, candidate, vacancy, nextSlot)}

PASO ACTUAL DEL FLUJO: ${currentStep}
${buildConfirmationStepInstructions(currentStep)}

HISTORIAL RECIENTE:
${buildConversationHistory(recentMessages)}

Devuelve SOLO un objeto JSON con este formato:
{
  "reply": string,
  "nextStep": string,
  "actions": [ { "type": string, "data": object } ],
  "extractedFields": object
}

nextStep validos: MENU | GREETING_SENT | COLLECTING_DATA | CONFIRMING_DATA | ASK_CV | DONE | SCHEDULING | SCHEDULED

ACCIONES DISPONIBLES:
- "save_fields"           -> guardar campos del candidato. data: { ...campos }
- "request_confirmation"  -> pedir confirmacion solo si hay ambiguedad o conflicto real
- "mark_rejected"         -> no cumple requisitos. data: { reason, details }
- "offer_interview"       -> ofrecer horario
- "confirm_booking"       -> candidato acepto el horario
- "reschedule"            -> ofrecer siguiente slot valido
- "request_cv"            -> pedir hoja de vida
- "mark_female_pipeline"  -> candidata femenina completa: datos + CV listos
- "mark_no_interest"      -> candidato ya no quiere continuar
- "pause_bot"             -> requiere atencion humana. data: { reason }
- "nothing"               -> no se requiere accion del sistema

REGLAS CRITICAS:
- Decide que falta leyendo el estado curado del candidato; no dependas de una lista fija de faltantes.
- Si el candidato envia un mensaje largo con datos mezclados, extrae todo lo valido en extractedFields.
- extractedFields tiene peso real: guarda correcciones y datos nuevos aunque no esten solo en save_fields.
- Si haces una pregunta y pides algo en el mismo mensaje, responde primero la duda y luego retoma el siguiente paso.
- Si no hubo progreso real, no repitas la misma estructura del bot anterior; reformula y aporta algo mas util.
- Nunca pidas el genero de forma directa; solo inferir si el candidato lo expresa claramente.
- Si el mensaje del candidato suena a cierre humano, desistimiento o pausa, adaptate al contexto.

Devuelve SOLO el JSON. Sin texto antes ni despues.`;
}

function parseEngineJson(rawText = '{}') {
  const text = String(rawText || '').trim();
  try { return JSON.parse(text); } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try { return JSON.parse(objectMatch[0]); } catch {}
  }

  return null;
}

function normalizeReplySignature(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlapRatio(a = '', b = '') {
  const aTokens = new Set(normalizeReplySignature(a).split(' ').filter(Boolean));
  const bTokens = new Set(normalizeReplySignature(b).split(' ').filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }

  return intersection / Math.max(aTokens.size, bTokens.size);
}

function isSubstantiallySimilarReply(nextReply = '', previousReply = '') {
  const next = normalizeReplySignature(nextReply);
  const previous = normalizeReplySignature(previousReply);
  if (!next || !previous) return false;
  if (next === previous) return true;
  if (next.length > 24 && previous.length > 24 && (next.includes(previous) || previous.includes(next))) {
    return true;
  }
  return tokenOverlapRatio(nextReply, previousReply) >= 0.78;
}

function hasMeaningfulEngineProgress(decision = {}, currentStep = '') {
  if (!decision || typeof decision !== 'object') return false;
  if (decision.nextStep && decision.nextStep !== currentStep) return true;
  if (decision.extractedFields && Object.keys(decision.extractedFields).length) return true;

  const actions = Array.isArray(decision.actions) ? decision.actions : [];
  return actions.some((action) => !['nothing', 'request_confirmation'].includes(action?.type));
}

function buildLoopGuardReply({ candidate = {}, currentStep = '', recentMessages = [] } = {}) {
  if (currentStep === 'ASK_CV') {
    return 'Ya revise lo que me enviaste. Cuando puedas, adjunta la hoja de vida en PDF o Word y sigo contigo.';
  }

  if (currentStep === 'CONFIRMING_DATA' && !getCoreFieldGaps(candidate).length) {
    return 'Ya tome nota de lo que corregiste. Si ves otro ajuste puntual me lo escribes y, si no, sigo con el siguiente paso.';
  }

  if (!candidate?.vacancyId) {
    if (!getCoreFieldGaps(candidate).length) {
      return 'Ya tengo tus datos principales registrados. Si quieres actualizar vacante o ciudad, dime el ajuste puntual y lo hago sin pedirte todo de nuevo.';
    }
    return 'Para ubicar bien tu proceso, cuentame desde que ciudad nos escribes y para que vacante o cargo aplicas.';
  }

  if (getCoreFieldGaps(candidate).length) {
    return 'Ya te lei. Comparteme solo el dato que falta o el ajuste puntual y avanzamos.';
  }

  const lastOutbound = [...recentMessages]
    .reverse()
    .find((message) => message.direction === 'OUTBOUND')?.body || '';

  if (/para continuar necesito|confirma tus datos|si todo esta correcto/.test(normalizeReplySignature(lastOutbound))) {
    return 'Ya vi tu mensaje. No hace falta repetir lo mismo: sigo con el ajuste o con la siguiente parte del proceso.';
  }

  return 'Ya revise lo que enviaste. Continuo contigo sin repetir el mismo mensaje.';
}

function applyLoopGuardToDecision(decision, context = {}) {
  const recentOutbound = (context.recentMessages || [])
    .filter((message) => message.direction === 'OUTBOUND')
    .slice(-3);

  if (!recentOutbound.length || hasMeaningfulEngineProgress(decision, context.currentStep)) {
    return { ...decision, loopGuardApplied: false };
  }

  const isLooping = recentOutbound.some((message) => isSubstantiallySimilarReply(decision.reply, message.body || ''));
  if (!isLooping) {
    return { ...decision, loopGuardApplied: false };
  }

  return {
    ...decision,
    reply: buildLoopGuardReply(context),
    loopGuardApplied: true
  };
}

function mergeEngineFields(actions = [], extractedFields = {}) {
  const merged = { ...(extractedFields || {}) };
  for (const action of actions || []) {
    if (action?.type !== 'save_fields' || typeof action?.data !== 'object' || !action.data) continue;
    Object.assign(merged, action.data);
  }
  return merged;
}

export function extractEngineCandidateFields(actions = [], extractedFields = {}) {
  return mergeEngineFields(actions, extractedFields);
}

function mapEngineGender(rawGender, Gender) {
  if (!rawGender) return null;
  const mapping = {
    MALE: Gender.MALE,
    FEMALE: Gender.FEMALE,
    OTHER: Gender.OTHER
  };
  return mapping[String(rawGender).toUpperCase()] || null;
}

export async function think({ inboundText, candidate, vacancy, recentMessages = [], nextSlot = null, currentStep }) {
  const fallbackReply = ENGINE_FALLBACK_REPLY;

  if (!process.env.OPENAI_API_KEY) {
    return {
      reply: fallbackReply,
      nextStep: currentStep,
      actions: [],
      extractedFields: {},
      raw: null,
      fallback: true,
      fallbackReason: 'missing_openai_api_key',
      loopGuardApplied: false
    };
  }

  try {
    const model = DEFAULT_MODEL;
    const temperature = parseOptionalTemperature();
    const useTemperature = temperature.value !== null && modelSupportsTemperature(model);

    const response = await axios.post(
      OPENAI_URL,
      {
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt({ vacancy, candidate, recentMessages, nextSlot, currentStep }) },
          { role: 'user', content: String(inboundText || '') }
        ],
        max_completion_tokens: 650,
        ...(useTemperature ? { temperature: temperature.value } : {})
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 18000
      }
    );

    const raw = parseEngineJson(response.data?.choices?.[0]?.message?.content || '{}');
    if (!raw || typeof raw.reply !== 'string') {
      console.warn('[ENGINE_PARSE_FAIL]', { phone: candidate?.phone });
      return {
        reply: fallbackReply,
        nextStep: currentStep,
        actions: [],
        extractedFields: {},
        raw,
        fallback: true,
        fallbackReason: 'invalid_engine_json',
        loopGuardApplied: false,
        usage: extractUsage(response.data)
      };
    }

    const decision = applyLoopGuardToDecision({
      reply: raw.reply.trim(),
      nextStep: raw.nextStep || currentStep,
      actions: Array.isArray(raw.actions) ? raw.actions : [],
      extractedFields: raw.extractedFields || {},
      raw,
      fallback: false,
      fallbackReason: null
    }, {
      candidate,
      currentStep,
      recentMessages
    });

    return {
      ...decision,
      raw,
      fallback: false,
      fallbackReason: null,
      usage: extractUsage(response.data)
    };
  } catch (error) {
    console.error('[ENGINE_ERROR]', {
      phone: candidate?.phone,
      error: error?.message?.slice(0, 200)
    });
    return {
      reply: fallbackReply,
      nextStep: currentStep,
      actions: [],
      extractedFields: {},
      raw: null,
      fallback: true,
      fallbackReason: error?.code || error?.message || 'engine_error',
      loopGuardApplied: false,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    };
  }
}

export async function act({ actions, candidate, extractedFields = {}, candidateFields = {}, nextStep, nextSlot, prisma }) {
  const { normalizeCandidateFields } = await import('./candidateData.js');
  const { cancelCandidateBookings, createBooking } = await import('./interviewScheduler.js');
  const { CandidateStatus, ConversationStep, Gender } = await import('@prisma/client');

  const normalizedActions = Array.isArray(actions) ? actions : [];
  const mergedRawFields = Object.keys(candidateFields || {}).length
    ? candidateFields
    : extractEngineCandidateFields(normalizedActions, extractedFields);

  const mergedFields = normalizeCandidateFields(mergedRawFields);
  const mappedGender = mapEngineGender(mergedRawFields.gender, Gender);
  const engineSourceByField = Object.fromEntries(
    Object.keys(mergedFields).map((field) => [field, 'engine'])
  );
  const fieldDecisions = splitFieldDecisions(mergedFields, candidate, {
    sourceByField: engineSourceByField,
    allowOverwriteFields: ['age', 'transportMode', 'medicalRestrictions', 'experienceInfo', 'experienceTime']
  });
  const persistedFields = { ...(fieldDecisions.persistedData || {}) };
  if (mappedGender && (!candidate.gender || candidate.gender === Gender.UNKNOWN)) {
    persistedFields.gender = mappedGender;
  }

  const candidateAfterMerge = { ...candidate, ...persistedFields };
  const coreFieldGapsAfterMerge = getCoreFieldGaps(candidateAfterMerge);
  const hasNewCoreData = Object.keys(persistedFields).some((field) => CORE_PROFILE_FIELDS.includes(field));
  const hasCvAfterMerge = Boolean(candidateAfterMerge.cvStorageKey || candidateAfterMerge.cvData || candidateAfterMerge.cvOriginalName || candidateAfterMerge.cvMimeType);

  if (Object.keys(persistedFields).length) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: persistedFields
    }).catch((error) => {
      console.error('[ACT_FIELDS_ERROR]', { error: error?.message?.slice(0, 200) });
    });
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
      switch (action?.type) {
        case 'save_fields':
          break;

        case 'request_cv':
          if (coreFieldGapsAfterMerge.length) {
            console.info('[ACT_REQUEST_CV_DEFERRED]', {
              candidateId: candidate.id,
              missingFields: coreFieldGapsAfterMerge
            });
            setStep(ConversationStep.COLLECTING_DATA);
            break;
          }
          setStep(ConversationStep.ASK_CV);
          break;

        case 'request_confirmation':
          if (candidate.currentStep === ConversationStep.CONFIRMING_DATA && hasNewCoreData) {
            if (coreFieldGapsAfterMerge.length) {
              setStep(ConversationStep.COLLECTING_DATA);
            } else if (!hasCvAfterMerge) {
              setStep(ConversationStep.ASK_CV);
            }
            break;
          }

          if (candidate.currentStep === ConversationStep.CONFIRMING_DATA && !coreFieldGapsAfterMerge.length && !hasCvAfterMerge) {
            setStep(ConversationStep.ASK_CV);
            break;
          }

          setStep(ConversationStep.CONFIRMING_DATA);
          break;

        case 'mark_female_pipeline':
          pendingUpdate.gender = Gender.FEMALE;
          pendingUpdate.status = CandidateStatus.REGISTRADO;
          pendingUpdate.botPaused = true;
          pendingUpdate.botPausedAt = new Date();
          pendingUpdate.botPauseReason = 'Candidata femenina pendiente de revision humana';
          pendingUpdate.reminderScheduledFor = null;
          pendingUpdate.reminderState = 'SKIPPED';
          setStep(ConversationStep.DONE, { terminal: true });
          break;

        case 'mark_rejected':
          pendingUpdate.status = CandidateStatus.RECHAZADO;
          pendingUpdate.rejectionReason = action.data?.reason || 'No cumple requisitos';
          pendingUpdate.rejectionDetails = action.data?.details || null;
          pendingUpdate.reminderScheduledFor = null;
          pendingUpdate.reminderState = 'SKIPPED';
          setStep(ConversationStep.DONE, { terminal: true });
          break;

        case 'confirm_booking':
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
            prisma,
            candidate.id,
            candidate.vacancyId,
            nextSlot.slot.id,
            nextSlot.date,
            !nextSlot.windowOk
          );
          pendingUpdate.reminderScheduledFor = null;
          pendingUpdate.reminderState = 'SKIPPED';
          setStep(ConversationStep.SCHEDULED, { terminal: true });
          break;

        case 'mark_no_interest':
          pendingUpdate.reminderScheduledFor = null;
          pendingUpdate.reminderState = 'SKIPPED';
          setStep(ConversationStep.DONE, { terminal: true });
          break;

        case 'pause_bot':
          pendingUpdate.botPaused = true;
          pendingUpdate.botPausedAt = new Date();
          pendingUpdate.botPauseReason = action.data?.reason || 'Requiere atencion humana';
          pendingUpdate.reminderScheduledFor = null;
          pendingUpdate.reminderState = 'CANCELLED';
          break;

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
          break;

        default:
          console.warn('[ACT_UNHANDLED]', {
            action: action?.type || 'unknown',
            candidateId: candidate.id
          });
          break;
      }
    } catch (error) {
      console.error('[ACT_ERROR]', {
        action: action?.type,
        error: error?.message?.slice(0, 200)
      });
    }
  }

  let finalStep = terminalStep
    || requestedStep
    || null;

  if (!finalStep && nextStep && Object.values(ConversationStep).includes(nextStep)) {
    finalStep = nextStep;
  }

  if (!terminalStep && !coreFieldGapsAfterMerge.length && !hasCvAfterMerge && finalStep === ConversationStep.CONFIRMING_DATA) {
    finalStep = ConversationStep.ASK_CV;
  }

  if (!terminalStep && coreFieldGapsAfterMerge.length && finalStep === ConversationStep.ASK_CV) {
    finalStep = ConversationStep.COLLECTING_DATA;
  }

  if (finalStep && finalStep !== candidate.currentStep) {
    pendingUpdate.currentStep = finalStep;
  }

  if (Object.keys(pendingUpdate).length) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: pendingUpdate
    }).catch((error) => console.error('[ACT_STEP_UPDATE_ERROR]', error?.message));
  }
}
