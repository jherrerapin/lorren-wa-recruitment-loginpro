import axios from 'axios';
import { buildPolicyReply } from './responsePolicy.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const CONTEXTUAL_REPLY_MODEL = 'gpt-5.4-mini-2026-03-17';

const FALLBACK_INTENT_BY_SITUATION = {
  attachment_resume_photo: 'request_cv_pdf_word',
  attachment_id_doc: 'attachment_id_doc',
  attachment_other_doc: 'request_missing_cv',
  attachment_unreadable: 'attachment_unreadable',
  request_missing_data: 'request_missing_data',
  confirm_data_correction: 'confirm_correction',
  continue_flow: 'continue_flow',
  process_human_review_required: 'continue_flow'
};

function normalize(text = '') {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function similarity(a = '', b = '') {
  const aTokens = new Set(normalize(a).split(' ').filter(Boolean));
  const bTokens = new Set(normalize(b).split(' ').filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
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

function buildContextPayload(context = {}) {
  return {
    situation: context.situation || 'continue_flow',
    decision: context.decision || null,
    inboundText: String(context.inboundText || ''),
    currentStep: context.currentStep || null,
    missingFields: Array.isArray(context.missingFields) ? context.missingFields : [],
    requiresHumanReview: Boolean(context.requiresHumanReview),
    candidate: {
      id: context.candidate?.id || null,
      fullName: context.candidate?.fullName || null,
      status: context.candidate?.status || null
    },
    vacancy: {
      id: context.vacancy?.id || null,
      title: context.vacancy?.title || context.vacancy?.role || null,
      city: context.vacancy?.city || context.vacancy?.operation?.city?.name || null
    },
    activeInterviewBooking: context.activeInterviewBooking
      ? {
        scheduledAt: context.activeInterviewBooking.scheduledAt || null,
        status: context.activeInterviewBooking.status || null
      }
      : null,
    attachmentAnalysis: context.attachmentAnalysis
      ? {
        classification: context.attachmentAnalysis.classification || null,
        confidence: Number(context.attachmentAnalysis.confidence || 0),
        rationale: context.attachmentAnalysis.rationale || null,
        evidence: context.attachmentAnalysis.evidence || []
      }
      : null,
    recentOutbound: Array.isArray(context.recentMessages)
      ? context.recentMessages.map((item) => String(item?.body || '')).filter(Boolean).slice(0, 6)
      : []
  };
}

function buildFallback(context = {}, reason = 'fallback') {
  const intent = context.fallbackIntent
    || FALLBACK_INTENT_BY_SITUATION[context.situation]
    || 'continue_flow';
  const fallback = buildPolicyReply({
    replyIntent: intent,
    recentOutbound: context.recentMessages || [],
    fallback: context.fallbackText || ''
  });
  return {
    text: fallback.text,
    situation: context.situation || 'continue_flow',
    usedModel: false,
    fallbackUsed: true,
    reason,
    intent: fallback.intent,
    escalateHuman: Boolean(context.requiresHumanReview),
    model: null
  };
}

export function shouldEscalateHumanReview({ attachmentAnalysis = null, contradictionDetected = false, unresolvedQuestion = false } = {}) {
  if (contradictionDetected || unresolvedQuestion) return true;
  const classification = attachmentAnalysis?.classification || null;
  const confidence = Number(attachmentAnalysis?.confidence || 0);
  if (!classification) return false;
  return confidence < 0.2 && ['UNREADABLE', 'OTHER'].includes(classification);
}

export async function buildContextualReply(context = {}) {
  const payloadContext = buildContextPayload(context);
  if (!process.env.OPENAI_API_KEY) return buildFallback(context, 'openai_disabled');

  const payload = {
    model: CONTEXTUAL_REPLY_MODEL,
    input: [
      {
        role: 'system',
        content: [{
          type: 'input_text',
          text: 'Eres un reclutador humano por WhatsApp. Redacta un mensaje breve, natural y contextual en español colombiano. Evita frases quemadas, no repitas texto reciente, responde preguntas primero y luego retoma el proceso. No inventes reglas: respeta la decision ya dada por el sistema. Si requiere revision humana, dilo sin improvisar soluciones.'
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
    if (!text) return buildFallback(context, 'empty_reply');

    const recentOutbound = Array.isArray(context.recentMessages) ? context.recentMessages : [];
    if (recentOutbound.some((item) => similarity(text, item?.body || '') >= 0.85)) {
      return buildFallback(context, 'repeat_guard');
    }

    return {
      text,
      situation: context.situation || 'continue_flow',
      usedModel: true,
      fallbackUsed: false,
      reason: parsed?.reason || 'ok',
      intent: null,
      model: CONTEXTUAL_REPLY_MODEL,
      escalateHuman: Boolean(parsed?.escalateHuman || context.requiresHumanReview)
    };
  } catch {
    return buildFallback(context, 'responses_error');
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
