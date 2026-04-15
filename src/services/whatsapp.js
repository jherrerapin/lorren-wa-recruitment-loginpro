import axios from 'axios';

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

export function extractMessages(payload) {
  const entry = payload?.entry?.[0];
  const change = entry?.changes?.[0];
  return change?.value?.messages || [];
}

export function extractContacts(payload) {
  const entry = payload?.entry?.[0];
  const change = entry?.changes?.[0];
  return change?.value?.contacts || [];
}
