import axios from 'axios';
import {
  getResidenceFieldConfig,
  getResidenceFollowUp,
  normalizeCandidateFields,
  parseNaturalData
} from '../../src/services/candidateData.js';
import { detectConversationIntent } from '../../src/services/conversationIntent.js';

function extractMessage(payload = {}, role = 'user') {
  return payload?.messages?.find((message) => message.role === role)?.content || '';
}

function parseJsonSection(prompt = '', header = '') {
  const start = prompt.indexOf(header);
  if (start < 0) return null;
  const afterHeader = prompt.slice(start + header.length);
  const firstBrace = afterHeader.indexOf('{');
  if (firstBrace < 0) return null;

  let depth = 0;
  let endIndex = -1;
  for (let index = firstBrace; index < afterHeader.length; index += 1) {
    const char = afterHeader[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      endIndex = index + 1;
      break;
    }
  }

  if (endIndex < 0) return null;
  try {
    return JSON.parse(afterHeader.slice(firstBrace, endIndex));
  } catch {
    return null;
  }
}

function detectCity(text = '') {
  const normalized = String(text || '').toLowerCase();
  if (/\bibague\b/.test(normalized)) return 'Ibague';
  if (/\bbogota\b/.test(normalized)) return 'Bogota';
  return null;
}

function detectRoleHint(text = '') {
  const normalized = String(text || '').toLowerCase();
  if (/auxiliar de cargue y descargue/.test(normalized)) return 'auxiliar de cargue y descargue';
  if (/mensajer/.test(normalized)) return 'mensajero';
  if (/operari/.test(normalized)) return 'operario';
  return null;
}

function inferGenderFromName(fullName = '') {
  const firstName = String(fullName || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  if (['maria', 'ana', 'laura', 'paula', 'luisa', 'andrea'].includes(firstName)) return 'FEMALE';
  if (['juan', 'carlos', 'andres', 'camilo', 'jose', 'william', 'sergio'].includes(firstName)) return 'MALE';
  return null;
}

function buildResidenceVacancyContext(vacancyState = {}) {
  return {
    city: vacancyState.city || null,
    title: vacancyState.title || null,
    role: vacancyState.role || null,
    operationAddress: vacancyState.operation?.address || vacancyState.operationAddress || null,
    interviewAddress: vacancyState.interviewAddress || vacancyState.operation?.address || null
  };
}

function listMissingCoreFields(candidateState = {}, vacancyState = {}, profileState = null) {
  const profile = candidateState.profile || {};
  const effectiveProfileState = profileState || Object.fromEntries(
    Object.entries(profile)
      .filter(([, state]) => state?.captured)
      .map(([field, state]) => [field, state.value])
  );
  const residenceConfig = getResidenceFieldConfig(buildResidenceVacancyContext(vacancyState), effectiveProfileState);
  const residenceField = residenceConfig?.field || 'neighborhood';
  const residenceLabel = residenceConfig?.label || 'barrio';
  return [
    ['fullName', 'nombre completo'],
    ['documentType', 'tipo de documento'],
    ['documentNumber', 'numero de documento'],
    ['age', 'edad'],
    [residenceField, residenceLabel],
    ['medicalRestrictions', 'restricciones medicas'],
    ['transportMode', 'medio de transporte']
  ]
    .filter(([field]) => !profile[field]?.captured)
    .map(([, label]) => label);
}

function answerVacancyQuestion(vacancyState = {}, text = '') {
  const normalized = String(text || '').toLowerCase();
  if (!vacancyState?.resolved) {
    return 'Claro. Para ubicar bien la vacante, cuentame desde que ciudad nos escribes y que cargo te interesa.';
  }
  if (/(donde|direccion|ubicacion|queda)/.test(normalized)) {
    return vacancyState.operation?.address
      ? `Claro. La vacante es en ${vacancyState.city || 'la ciudad registrada'} y la direccion registrada es ${vacancyState.operation.address}.`
      : `Claro. La vacante esta registrada en ${vacancyState.city || 'la ciudad indicada'}.`;
  }
  if (/(requisit|document)/.test(normalized)) {
    return vacancyState.requirements
      ? `Claro. Los requisitos registrados son ${vacancyState.requirements}.`
      : 'Claro. Los requisitos exactos te los confirma el equipo directamente.';
  }
  if (/(horario|salario|pago|condicion|beneficio|contrato)/.test(normalized)) {
    return vacancyState.conditions
      ? `Claro. Las condiciones registradas para esta vacante son ${vacancyState.conditions}.`
      : 'Claro. Esa condicion te la confirma el equipo directamente.';
  }
  if (/(cargo|funcion|rol|hacer)/.test(normalized)) {
    const description = vacancyState.roleDescription || vacancyState.role || vacancyState.title;
    return `Claro. El cargo es ${vacancyState.title || vacancyState.role || 'la vacante consultada'}${description ? ` y la descripcion disponible es ${description}.` : '.'}`;
  }
  return `Claro. La vacante disponible es ${vacancyState.title || vacancyState.role || 'la vacante consultada'} en ${vacancyState.city || 'la ciudad registrada'}.`;
}

function parseSlotText(prompt = '') {
  const match = prompt.match(/(?:Slot de entrevista disponible|Siguiente slot de entrevista disponible|Entrevista ya agendada):\s*([^\n]+)/i);
  return match?.[1]?.trim() || null;
}

function mergeProfileState(candidateState = {}, extractedFields = {}) {
  const merged = {};
  const profile = candidateState.profile || {};
  for (const [field, state] of Object.entries(profile)) {
    if (state?.captured) merged[field] = state.value;
  }
  Object.assign(merged, extractedFields);
  return merged;
}

function buildAiParserResponse(userText) {
  const parsed = normalizeCandidateFields(parseNaturalData(userText));
  const inferredGender = inferGenderFromName(parsed.fullName);
  if (inferredGender) parsed.gender = inferredGender;
  const intent = detectConversationIntent(userText, { isDoneStep: false });
  const city = detectCity(userText);
  const roleHint = detectRoleHint(userText);
  return {
    intent,
    city,
    roleHint,
    ...parsed
  };
}

function buildEngineDecision(systemPrompt, userText) {
  const candidateState = parseJsonSection(systemPrompt, 'ESTADO CURADO DEL CANDIDATO (JSON):') || {};
  const vacancyState = parseJsonSection(systemPrompt, 'ESTADO CURADO DE LA VACANTE (JSON):') || {};
  const parsed = normalizeCandidateFields(parseNaturalData(userText));
  const inferredGender = inferGenderFromName(parsed.fullName || candidateState.profile?.fullName?.value);
  if (inferredGender) parsed.gender = inferredGender;
  const city = detectCity(userText);
  const roleHint = detectRoleHint(userText);
  if (city) parsed.city = city;
  if (roleHint) parsed.roleHint = roleHint;

  const mergedProfile = mergeProfileState(candidateState, parsed);
  const mergedCandidateState = {
    ...candidateState,
    profile: {
      ...(candidateState.profile || {}),
      ...Object.fromEntries(Object.entries(parsed).map(([field, value]) => [field, { captured: true, value }]))
    }
  };
  const residenceVacancyContext = buildResidenceVacancyContext(vacancyState);
  const residenceFollowUp = getResidenceFollowUp(mergedProfile, residenceVacancyContext);
  const missingFields = listMissingCoreFields(mergedCandidateState, vacancyState, mergedProfile);

  const currentStep = candidateState.currentStep || 'MENU';
  const hasCv = Boolean(candidateState.progress?.hasCv);
  const completeAfterMerge = missingFields.length === 0 && !residenceFollowUp;
  const questionLike = /\?|que|cual|donde|cuando|requisit|salario|pago|horario|ubicacion|direccion|funcion|cargo/.test(String(userText || '').toLowerCase());
  const noInterest = /\b(no me interesa|ya no|mejor no|prefiero no|paso)\b/i.test(userText);
  const affirmative = /^(si|sí|correcto|esta bien|está bien|todo bien|listo|perfecto)\b/i.test(String(userText || '').trim());
  const rescheduleIntent = /\b(otro horario|otra hora|otro dia|reagend|cambiar horario|no puedo|no me queda|no me sirve|mas tarde|mas temprano|otra opcion)\b/i.test(userText);
  const confirmBookingIntent = /\b(confirmo|agendame|agendar|me sirve|me queda bien|si puedo|sí puedo|vale ese horario)\b/i.test(userText) || affirmative;
  const slotText = parseSlotText(systemPrompt);

  if (candidateState.humanInterventionDetected) {
    return {
      reply: 'Quedo atento. El equipo ya tomo esta conversacion.',
      nextStep: currentStep,
      actions: [{ type: 'pause_bot', data: { reason: 'Intervencion humana detectada en el chat' } }],
      extractedFields: {}
    };
  }

  if (noInterest) {
    return {
      reply: 'Entiendo. Si mas adelante deseas retomar el proceso, me vuelves a escribir.',
      nextStep: 'DONE',
      actions: [{ type: 'mark_no_interest' }],
      extractedFields: {}
    };
  }

  if ((currentStep === 'SCHEDULING' || currentStep === 'SCHEDULED') && vacancyState.schedulingEnabled && !candidateState.progress?.femalePipeline) {
    if (rescheduleIntent && slotText) {
      return {
        reply: `Listo, te puedo proponer ${slotText}.`,
        nextStep: 'SCHEDULING',
        actions: [{ type: 'reschedule' }],
        extractedFields: {}
      };
    }
    if (confirmBookingIntent && slotText) {
      return {
        reply: `Perfecto, te confirmo ${slotText}.`,
        nextStep: 'SCHEDULED',
        actions: [{ type: 'confirm_booking' }],
        extractedFields: {}
      };
    }
  }

  if (questionLike && vacancyState.resolved) {
    const answer = answerVacancyQuestion(vacancyState, userText);
    if (!completeAfterMerge && currentStep !== 'ASK_CV') {
      const nextMissing = residenceFollowUp || missingFields.slice(0, 2).join(' y ');
      return {
        reply: residenceFollowUp ? `${answer} ${residenceFollowUp}` : `${answer} Si quieres seguir, comparteme ${nextMissing}.`,
        nextStep: 'COLLECTING_DATA',
        actions: Object.keys(parsed).length ? [{ type: 'save_fields', data: parsed }] : [{ type: 'nothing' }],
        extractedFields: parsed
      };
    }
    return {
      reply: answer,
      nextStep: currentStep,
      actions: Object.keys(parsed).length ? [{ type: 'save_fields', data: parsed }] : [{ type: 'nothing' }],
      extractedFields: parsed
    };
  }

  if (residenceFollowUp && currentStep !== 'MENU' && currentStep !== 'GREETING_SENT') {
    return {
      reply: residenceFollowUp,
      nextStep: 'COLLECTING_DATA',
      actions: Object.keys(parsed).length ? [{ type: 'save_fields', data: parsed }] : [{ type: 'nothing' }],
      extractedFields: parsed
    };
  }

  if (vacancyState.resolved && hasCv && (parsed.city || parsed.roleHint) && !completeAfterMerge) {
    const nextMissing = missingFields.slice(0, 3).join(', ');
    return {
      reply: `Perfecto, ya ubique la vacante ${vacancyState.title || vacancyState.role || 'registrada'} en ${vacancyState.city || 'la ciudad indicada'}. Para continuar comparteme ${nextMissing}.`,
      nextStep: 'COLLECTING_DATA',
      actions: Object.keys(parsed).length ? [{ type: 'save_fields', data: parsed }] : [{ type: 'nothing' }],
      extractedFields: parsed
    };
  }

  if (currentStep === 'CONFIRMING_DATA') {
    if (affirmative) {
      if (completeAfterMerge && !hasCv) {
        return {
          reply: 'Listo, ya tengo tus datos. Cuando puedas, adjuntame la hoja de vida en PDF o Word.',
          nextStep: 'ASK_CV',
          actions: [{ type: 'request_cv' }],
          extractedFields: {}
        };
      }
      if (completeAfterMerge && hasCv && candidateState.progress?.femalePipeline) {
        return {
          reply: 'Listo, ya quedaron tus datos y tu hoja de vida registradas. El equipo revisara tu perfil y te contactara.',
          nextStep: 'DONE',
          actions: [{ type: 'mark_female_pipeline' }],
          extractedFields: {}
        };
      }
      return {
        reply: residenceFollowUp || `Perfecto. Para seguir me faltan ${missingFields.join(', ')}.`,
        nextStep: 'COLLECTING_DATA',
        actions: [{ type: 'nothing' }],
        extractedFields: {}
      };
    }

    if (Object.keys(parsed).length) {
      if (completeAfterMerge && !hasCv) {
        return {
          reply: 'Listo, ya actualice ese dato. Ahora enviame tu hoja de vida en PDF o Word.',
          nextStep: 'ASK_CV',
          actions: [{ type: 'save_fields', data: parsed }, { type: 'request_cv' }],
          extractedFields: parsed
        };
      }
      return {
        reply: residenceFollowUp || `Listo, ya actualice ese dato. Para seguir me faltan ${missingFields.join(', ')}.`,
        nextStep: completeAfterMerge ? 'ASK_CV' : 'COLLECTING_DATA',
        actions: [{ type: 'save_fields', data: parsed }],
        extractedFields: parsed
      };
    }
  }

  if (completeAfterMerge && !hasCv) {
    return {
      reply: 'Listo, ya tengo tus datos. Cuando puedas, adjuntame la hoja de vida en PDF o Word.',
      nextStep: 'ASK_CV',
      actions: Object.keys(parsed).length
        ? [{ type: 'save_fields', data: parsed }, { type: 'request_cv' }]
        : [{ type: 'request_cv' }],
      extractedFields: parsed
    };
  }

  if (completeAfterMerge && hasCv) {
    if (candidateState.progress?.femalePipeline) {
      return {
        reply: 'Listo, ya quedaron tus datos y tu hoja de vida registradas. El equipo revisara tu perfil y te contactara.',
        nextStep: 'DONE',
        actions: [{ type: 'mark_female_pipeline' }],
        extractedFields: parsed
      };
    }
    if (vacancyState.schedulingEnabled && slotText) {
      return {
        reply: `Perfecto, te puedo ofrecer ${slotText}.`,
        nextStep: 'SCHEDULING',
        actions: [{ type: 'offer_interview' }],
        extractedFields: parsed
      };
    }
    return {
      reply: 'Listo, ya quedaron tus datos y tu hoja de vida registradas. El equipo revisara tu perfil y te contactara.',
      nextStep: 'DONE',
      actions: [{ type: 'nothing' }],
      extractedFields: parsed
    };
  }

  if (Object.keys(parsed).length) {
    if (completeAfterMerge) {
      return {
        reply: 'Listo, ya tengo la informacion clave. Cuando puedas, enviame la hoja de vida en PDF o Word.',
        nextStep: 'ASK_CV',
        actions: [{ type: 'save_fields', data: parsed }, { type: 'request_cv' }],
        extractedFields: parsed
      };
    }
    return {
      reply: residenceFollowUp || `Listo, ya registre eso. Para continuar me faltan ${missingFields.join(', ')}.`,
      nextStep: 'COLLECTING_DATA',
      actions: [{ type: 'save_fields', data: parsed }],
      extractedFields: parsed
    };
  }

  const followUp = vacancyState.resolved
    ? 'Si quieres continuar, cuentame tus datos en el orden que prefieras.'
    : 'Cuentame desde que ciudad nos escribes y para que vacante o cargo estas aplicando.';

  return {
    reply: followUp,
    nextStep: currentStep,
    actions: [{ type: 'nothing' }],
    extractedFields: {}
  };
}

function buildNaturalReply(systemPrompt = '') {
  const dateMatch = systemPrompt.match(/Horario a ofrecer:\s*([^\n.]+)/i) || systemPrompt.match(/Fecha\/hora:\s*([^\n.]+)/i);
  const dateText = dateMatch?.[1]?.trim() || 'el horario disponible';
  if (/confirm[aá].*entrevista agendada/i.test(systemPrompt) || /recordatorio una hora antes/i.test(systemPrompt)) {
    return `Listo, tu entrevista quedo agendada para ${dateText}. Te escribimos una hora antes para recordarte.`;
  }
  return `Perfecto, te puedo ofrecer ${dateText}. Me confirmas si te sirve.`;
}

export function installOpenAIMock({ whatsappMock, responder } = {}) {
  const originalPost = axios.post.bind(axios);

  axios.post = async (url, payload, config) => {
    if (String(url).includes('graph.facebook.com')) {
      return { data: whatsappMock.handleSend(url, payload, config) };
    }

    if (String(url).includes('/chat/completions')) {
      const systemPrompt = extractMessage(payload, 'system');
      const userText = extractMessage(payload, 'user');

      let content;
      if (typeof responder === 'function') {
        content = responder({ url, payload, systemPrompt, userText });
      } else if (/Eres un reclutador humano experto leyendo mensajes de WhatsApp/.test(systemPrompt)) {
        content = buildAiParserResponse(userText);
      } else if (/Sos un reclutador del equipo de seleccion de LoginPro/.test(systemPrompt) && /Devuelve SOLO un objeto JSON/.test(systemPrompt)) {
        content = buildEngineDecision(systemPrompt, userText);
      } else {
        content = buildNaturalReply(systemPrompt);
      }

      const messageContent = typeof content === 'string' ? content : JSON.stringify(content);
      return {
        data: {
          choices: [
            {
              message: {
                content: messageContent
              }
            }
          ]
        }
      };
    }

    return originalPost(url, payload, config);
  };

  return () => {
    axios.post = originalPost;
  };
}
