import axios from 'axios';
import { attachAdContextToMessage } from './adContext.js';

export const INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD = 'INTERVIEW_ATTEND_YES';
export const INTERVIEW_ATTENDANCE_DECLINE_PAYLOAD = 'INTERVIEW_ATTEND_NO';
export const INTERVIEW_ATTENDANCE_QUICK_REPLY_PAYLOADS = [
  INTERVIEW_ATTENDANCE_CONFIRM_PAYLOAD,
  INTERVIEW_ATTENDANCE_DECLINE_PAYLOAD
];

function requireTemplateString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${label}_required`);
  return normalized;
}

function buildTemplateQuickReplyComponents(rawPayloads = []) {
  if (!Array.isArray(rawPayloads)) {
    throw new TypeError('whatsapp_template_quick_reply_payloads_invalid');
  }
  return rawPayloads.map((value, index) => ({
    type: 'button',
    sub_type: 'quick_reply',
    index: String(index),
    parameters: [{
      type: 'payload',
      payload: requireTemplateString(value, 'whatsapp_template_quick_reply_payload')
    }]
  }));
}

export function buildWhatsAppTemplatePayload(to, options = {}) {
  const recipient = requireTemplateString(to, 'whatsapp_template_recipient');
  const name = requireTemplateString(options.name, 'whatsapp_template_name');
  const languageCode = requireTemplateString(options.languageCode, 'whatsapp_template_language');
  const rawParameters = options.bodyParameters ?? [];
  if (!Array.isArray(rawParameters)) {
    throw new TypeError('whatsapp_template_body_parameters_invalid');
  }
  const bodyParameters = rawParameters.map((value) => ({
    type: 'text',
    text: requireTemplateString(value, 'whatsapp_template_body_parameter')
  }));
  const quickReplyPayloads = options.quickReplyPayloads === undefined
    ? INTERVIEW_ATTENDANCE_QUICK_REPLY_PAYLOADS
    : options.quickReplyPayloads;
  const quickReplyComponents = buildTemplateQuickReplyComponents(quickReplyPayloads);

  const template = {
    name,
    language: { code: languageCode }
  };
  const components = [];
  if (bodyParameters.length) {
    components.push({
      type: 'body',
      parameters: bodyParameters
    });
  }
  components.push(...quickReplyComponents);
  if (components.length) template.components = components;

  return {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template
  };
}

async function postWhatsAppPayload(payload) {
  const url = `https://graph.facebook.com/v23.0/${process.env.META_PHONE_NUMBER_ID}/messages`;
  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });

  return response.data;
}

export async function sendTemplateMessage(to, options = {}) {
  return postWhatsAppPayload(buildWhatsAppTemplatePayload(to, options));
}

export async function sendTextMessage(to, body) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  };

  return postWhatsAppPayload(payload);
}

export async function sendImageMessage(to, image, caption = '') {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: {
      id: image?.id
    }
  };

  if (caption) {
    payload.image.caption = caption;
  }

  return postWhatsAppPayload(payload);
}

export async function sendDocumentMessage(to, document, caption = '') {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: {
      id: document?.id
    }
  };

  if (document?.filename) {
    payload.document.filename = document.filename;
  }

  if (caption) {
    payload.document.caption = caption;
  }

  return postWhatsAppPayload(payload);
}

export async function sendAudioMessage(to, audio) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: {
      id: audio?.id
    }
  };

  return postWhatsAppPayload(payload);
}

function payloadPhoneNumberId(payload = {}) {
  const entry = payload?.entry?.[0];
  const change = entry?.changes?.[0];
  return String(change?.value?.metadata?.phone_number_id || '').trim();
}

export function isRecruitmentWhatsappPayload(payload = {}, expectedPhoneNumberId = process.env.META_PHONE_NUMBER_ID) {
  const expected = String(expectedPhoneNumberId || '').trim();
  const received = payloadPhoneNumberId(payload);

  // Fail open only when configuration or metadata is absent so existing test
  // fixtures and non-message webhook shapes keep their historical behavior.
  if (!expected || !received) return true;
  return received === expected;
}

export function extractMessages(payload) {
  if (!isRecruitmentWhatsappPayload(payload)) return [];
  const entry = payload?.entry?.[0];
  const change = entry?.changes?.[0];
  return (change?.value?.messages || []).map(attachAdContextToMessage);
}

export function extractContacts(payload) {
  if (!isRecruitmentWhatsappPayload(payload)) return [];
  const entry = payload?.entry?.[0];
  const change = entry?.changes?.[0];
  return change?.value?.contacts || [];
}
