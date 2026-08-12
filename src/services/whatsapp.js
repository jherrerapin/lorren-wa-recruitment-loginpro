import axios from 'axios';
import { attachAdContextToMessage } from './adContext.js';
import { logWhatsappWebhookDiagnostics } from './whatsappWebhookDiagnostics.js';

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

export function extractMessages(payload) {
  logWhatsappWebhookDiagnostics(payload, '/webhook');
  const entry = payload?.entry?.[0];
  const change = entry?.changes?.[0];
  return (change?.value?.messages || []).map(attachAdContextToMessage);
}

export function extractContacts(payload) {
  const entry = payload?.entry?.[0];
  const change = entry?.changes?.[0];
  return change?.value?.contacts || [];
}
