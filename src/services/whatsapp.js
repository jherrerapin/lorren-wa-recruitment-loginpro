import axios from 'axios';
import { attachAdContextToMessage } from './adContext.js';

export async function sendTextMessage(to, body) {
  const url = `https://graph.facebook.com/v23.0/${process.env.META_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });

  return response.data;
}

export async function sendImageMessage(to, image, caption = '') {
  const url = `https://graph.facebook.com/v23.0/${process.env.META_PHONE_NUMBER_ID}/messages`;
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

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });

  return response.data;
}

export async function sendDocumentMessage(to, document, caption = '') {
  const url = `https://graph.facebook.com/v23.0/${process.env.META_PHONE_NUMBER_ID}/messages`;
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

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });

  return response.data;
}

export async function sendAudioMessage(to, audio) {
  const url = `https://graph.facebook.com/v23.0/${process.env.META_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: {
      id: audio?.id
    }
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });

  return response.data;
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
