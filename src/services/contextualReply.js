import axios from 'axios';
import { sanitizeRequiredDocumentsForBot } from './naturalReply.js';
import { ReplySimilarityThreshold, isSubstantiallySimilarReply } from './replySimilarityPolicy.js';
import { LORREN_ROLE_LABEL } from './botKnowledge.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const CONTEXTUAL_REPLY_MODEL = 'gpt-5.4-mini-2026-03-17';

const FALLBACK_INTENT_BY_SITUATION = Object.freeze({
  attachment_resume_photo: 'request_cv_pdf_word',
  attachment_cv_valid: 'continue_flow',
  attachment_id_doc: 'attachment_id_doc',
  attachment_other_doc: 'request_missing_cv',
  attachment_unreadable: 'attachment_unreadable',
  request_missing_data: 'request_missing_data',
  confirm_data_correction: 'confirm_correction',
  continue_flow: 'continue_flow',
  process_human_review_required: 'human_review'
});

const FIELD_LABELS = Object.freeze({
  fullName: 'nombre completo',
  documentType: 'tipo de documento',
  documentNumber: 'número de documento',
  phone: 'número de teléfono',
  age: 'edad',
  city: 'ciudad',
  locality: 'localidad',
  neighborhood: 'barrio',
  medicalRestrictions: 'restricciones médicas',
  transportMode: 'medio de transporte',
  experienceInfo: 'si tienes experiencia',
  experienceTime: 'tiempo de experiencia',
  experienceSummary: 'en qué tienes experiencia'
});

function asContextObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function parseStructuredOutput(data = {}) {
  const output = data?.output || [];
  for (const item of output) {
    for (const part of item?.content || []) {
      if (part?.parsed && typeof part.parsed === 'object') return part.parsed;
      if (typeof part?.text === 'string') {
        try { return JSON.parse(part.text); } catch {}
      }
    }
  }
  return null;
}

function humanizeFieldName(field = '') {
  const raw = String(field || '').trim();
  if (!raw) return '';
  if (FIELD_LABELS[raw]) return FIELD_LABELS[raw];
  return raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

function formatMissingFields(fields = []) {
  const safeFields = Array.isArray(fields) ? fields : [];
  const labels = [...new Set(safeFields.map(humanizeFieldName).filter(Boolean))];
  if (!labels.length) return '';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} y ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} y ${labels.at(-1)}`;
}

/**
 * Fallback de seguridad basado únicamente en hechos del turno.
 *
 * No intenta variar frases, inferir una intención nueva ni decidir el avance del
 * proceso. La política conversacional debe entregar `situation`,
 * `missingFields`, `fallbackText` y `requiresHumanReview` ya validados.
 */
export function buildSafeContextualFallbackText(context) {
  const safeContext = asContextObject(context);
  const explicitFallback = String(safeContext.fallbackText || '').trim();
  if (explicitFallback) return explicitFallback;

  const missing = formatMissingFields(safeContext.missingFields);
  const situation = safeContext.situation || 'continue_flow';

  if (situation === 'attachment_resume_photo') {
    return 'Recibí la imagen, pero no puedo registrarla como hoja de vida. Envíala como archivo PDF o DOCX.';
  }

  if (situation === 'attachment_cv_valid') {
    return missing
      ? `Recibí tu hoja de vida y quedó asociada a tu registro. Para continuar me falta confirmar ${missing}.`
      : 'Recibí tu hoja de vida y quedó asociada a tu registro.';
  }

  if (situation === 'attachment_id_doc') {
    return 'El archivo recibido parece ser un documento de identidad y no reemplaza la hoja de vida. Para continuar, envía tu HV como archivo PDF o DOCX.';
  }

  if (situation === 'attachment_other_doc') {
    return 'El archivo recibido no corresponde a una hoja de vida válida. Para continuar, envía tu HV como archivo PDF o DOCX.';
  }

  if (situation === 'attachment_unreadable') {
    return 'No pude procesar el archivo que enviaste. Reenvía tu hoja de vida como archivo PDF o DOCX.';
  }

  if (situation === 'request_missing_data') {
    return missing
      ? `Para continuar necesito confirmar ${missing}.`
      : 'Para continuar necesito confirmar el dato que quedó pendiente.';
  }

  if (situation === 'confirm_data_correction') {
    return missing
      ? `La corrección quedó registrada. Ahora me falta confirmar ${missing}.`
      : 'La corrección quedó registrada.';
  }

  if (situation === 'process_human_review_required' || safeContext.requiresHumanReview) {
    return 'No tengo información suficiente para resolver este punto con seguridad. El equipo de selección revisará tu caso y te contactará por este medio.';
  }

  if (missing) return `Para continuar necesito confirmar ${missing}.`;

  return 'Recibí tu mensaje y conservaré el punto pendiente del proceso sin reiniciar tu registro.';
}

function buildContextPayload(context) {
  const safeContext = asContextObject(context);
  return {
    situation: safeContext.situation || 'continue_flow',
    decision: safeContext.decision || null,
    inboundText: String(safeContext.inboundText || ''),
    currentStep: safeContext.currentStep || null,
    missingFields: Array.isArray(safeContext.missingFields) ? safeContext.missingFields : [],
    requiresHumanReview: Boolean(safeContext.requiresHumanReview),
    candidate: {
      id: safeContext.candidate?.id || null,
      fullName: safeContext.candidate?.fullName || null,
      status: safeContext.candidate?.status || null
    },
    vacancy: {
      id: safeContext.vacancy?.id || null,
      title: safeContext.vacancy?.title || safeContext.vacancy?.role || null,
      role: safeContext.vacancy?.role || safeContext.vacancy?.title || null,
      city: safeContext.vacancy?.city || safeContext.vacancy?.operation?.city?.name || null,
      operationAddress: safeContext.vacancy?.operationAddress || null,
      interviewAddress: safeContext.vacancy?.interviewAddress || null,
      requirements: safeContext.vacancy?.requirements || null,
      conditions: safeContext.vacancy?.conditions || null,
      requiredDocuments: sanitizeRequiredDocumentsForBot(safeContext.vacancy?.requiredDocuments) || null,
      interviewDocumentation: sanitizeRequiredDocumentsForBot(safeContext.vacancy?.requiredDocuments) || null,
      roleDescription: safeContext.vacancy?.roleDescription || null
    },
    activeInterviewBooking: safeContext.activeInterviewBooking
      ? {
        scheduledAt: safeContext.activeInterviewBooking.scheduledAt || null,
        status: safeContext.activeInterviewBooking.status || null
      }
      : null,
    attachmentAnalysis: safeContext.attachmentAnalysis
      ? {
        classification: safeContext.attachmentAnalysis.classification || null,
        confidence: Number(safeContext.attachmentAnalysis.confidence || 0),
        rationale: safeContext.attachmentAnalysis.rationale || null,
        evidence: safeContext.attachmentAnalysis.evidence || []
      }
      : null,
    recentOutbound: Array.isArray(safeContext.recentMessages)
      ? safeContext.recentMessages.map((item) => String(item?.body || '')).filter(Boolean).slice(0, 6)
      : []
  };
}

function buildFallback(context, reason = 'fallback') {
  const safeContext = asContextObject(context);
  return {
    text: buildSafeContextualFallbackText(safeContext),
    situation: safeContext.situation || 'continue_flow',
    usedModel: false,
    fallbackUsed: true,
    reason,
    intent: safeContext.fallbackIntent || FALLBACK_INTENT_BY_SITUATION[safeContext.situation] || 'continue_flow',
    escalateHuman: Boolean(safeContext.requiresHumanReview),
    model: null
  };
}

export function shouldEscalateHumanReview(options) {
  const safeOptions = asContextObject(options);
  const {
    attachmentAnalysis = null,
    contradictionDetected = false,
    unresolvedQuestion = false
  } = safeOptions;

  if (contradictionDetected || unresolvedQuestion) return true;
  const classification = attachmentAnalysis?.classification || null;
  const confidence = Number(attachmentAnalysis?.confidence || 0);
  if (!classification) return false;
  return confidence < 0.2 && ['UNREADABLE', 'OTHER'].includes(classification);
}

export async function buildContextualReply(context) {
  const safeContext = asContextObject(context);

  if (safeContext.situation === 'attachment_resume_photo') {
    return {
      text: buildSafeContextualFallbackText(safeContext),
      situation: 'attachment_resume_photo',
      usedModel: false,
      fallbackUsed: true,
      reason: 'deterministic_attachment_resume_photo',
      intent: 'request_cv_pdf_word',
      escalateHuman: Boolean(safeContext.requiresHumanReview),
      model: null
    };
  }

  const payloadContext = buildContextPayload(safeContext);
  if (!process.env.OPENAI_API_KEY) return buildFallback(safeContext, 'openai_disabled');

  const payload = {
    model: CONTEXTUAL_REPLY_MODEL,
    input: [
      {
        role: 'system',
        content: [{
          type: 'input_text',
          text: `Eres ${LORREN_ROLE_LABEL} solo si el candidato pregunta directamente tu nombre, identidad o si eres bot; de resto actúas desde ese rol por WhatsApp sin presentarte. Redacta un mensaje breve, natural y contextual en español colombiano. Evita frases quemadas, no repitas texto reciente, responde preguntas primero y luego retoma el proceso solo si aporta valor. No inventes reglas: respeta la decision ya dada por el sistema. Para cualquier dato de la vacante, usa exclusivamente la vacante asignada incluida en el JSON del usuario, incluida la documentacion de entrevista indicada en la vacante; no uses conocimiento general, supuestos ni datos de otras vacantes. Si el dato no esta en esa vacante, di que no lo tienes registrado. Si requiere revision humana, dilo sin improvisar soluciones. Nunca digas que la hoja de vida puede enviarse en foto, imagen, impresa, Minerva física o como la tenga. Para este canal solo es válida como archivo PDF o DOCX.`
        }]
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: JSON.stringify(payloadContext) }]
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'contextual_reply',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reply: { type: 'string' },
            escalateHuman: { type: 'boolean' },
            reason: { type: 'string' }
          },
          required: ['reply', 'escalateHuman', 'reason']
        }
      }
    }
  };

  try {
    const response = await axios.post(RESPONSES_URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    const parsed = parseStructuredOutput(response.data);
    const text = String(parsed?.reply || '').trim();
    if (!text) return buildFallback(safeContext, 'empty_reply');

    const recentOutbound = Array.isArray(safeContext.recentMessages) ? safeContext.recentMessages : [];
    if (recentOutbound.some((item) => isSubstantiallySimilarReply(text, item?.body || '', {
      threshold: ReplySimilarityThreshold.CONTEXTUAL_REPLY
    }))) {
      return buildFallback(safeContext, 'repeat_guard');
    }

    return {
      text,
      situation: safeContext.situation || 'continue_flow',
      usedModel: true,
      fallbackUsed: false,
      reason: parsed?.reason || 'ok',
      intent: null,
      model: CONTEXTUAL_REPLY_MODEL,
      escalateHuman: Boolean(parsed?.escalateHuman || safeContext.requiresHumanReview)
    };
  } catch {
    return buildFallback(safeContext, 'responses_error');
  }
}

export function mapAttachmentSituation(classification = '') {
  if (classification === 'CV_VALID') return 'attachment_cv_valid';
  if (classification === 'CV_IMAGE_ONLY') return 'attachment_resume_photo';
  if (classification === 'ID_DOC') return 'attachment_id_doc';
  if (classification === 'UNREADABLE') return 'attachment_unreadable';
  return 'attachment_other_doc';
}

export function deriveAttachmentDecision(classification = '') {
  if (classification === 'CV_VALID') {
    return { saveCv: true, fallbackIntent: 'continue_flow', situation: 'attachment_cv_valid' };
  }
  if (classification === 'CV_IMAGE_ONLY') {
    return { saveCv: false, fallbackIntent: 'request_cv_pdf_word', situation: 'attachment_resume_photo' };
  }
  if (classification === 'ID_DOC') {
    return { saveCv: false, fallbackIntent: 'attachment_id_doc', situation: 'attachment_id_doc' };
  }
  if (classification === 'UNREADABLE') {
    return { saveCv: false, fallbackIntent: 'attachment_unreadable', situation: 'attachment_unreadable' };
  }
  return { saveCv: false, fallbackIntent: 'request_missing_cv', situation: 'attachment_other_doc' };
}
