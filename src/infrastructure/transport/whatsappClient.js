import axios from 'axios';

const REQUEST_TIMEOUT_MS = 15000;
const MAX_TEXT_LENGTH = 4096;
const MAX_INTERACTIVE_TEXT_LENGTH = 1024;
const MAX_BUTTONS = 3;
const MAX_BUTTON_ID_LENGTH = 256;
const MAX_BUTTON_TITLE_LENGTH = 20;

export class WhatsAppDeliveryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WhatsAppDeliveryError';
    this.status = details.status ?? null;
    this.providerCode = details.providerCode ?? null;
    this.requestAttempted = details.requestAttempted ?? null;
  }
}

function requireString(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new TypeError(`${name} exceeds the ${maxLength} character limit`);
  }
  return normalized;
}

function normalizeOptions(interactiveOptions) {
  if (!Array.isArray(interactiveOptions)) {
    throw new TypeError('interactiveOptions must be an array');
  }
  if (interactiveOptions.length > MAX_BUTTONS) {
    throw new TypeError(`interactiveOptions cannot contain more than ${MAX_BUTTONS} buttons`);
  }

  const ids = new Set();
  const titles = new Set();
  return interactiveOptions.map((option, index) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
      throw new TypeError(`interactiveOptions[${index}] must be an object`);
    }
    const id = requireString(option.id, `interactiveOptions[${index}].id`, MAX_BUTTON_ID_LENGTH);
    const title = requireString(option.label, `interactiveOptions[${index}].label`, MAX_BUTTON_TITLE_LENGTH);
    if (ids.has(id)) throw new TypeError(`interactiveOptions[${index}].id must be unique`);
    if (titles.has(title)) throw new TypeError(`interactiveOptions[${index}].label must be unique`);
    ids.add(id);
    titles.add(title);

    return {
      type: 'reply',
      reply: { id, title }
    };
  });
}

function buildPayload(phone, text, buttons) {
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone
  };

  if (!buttons.length) {
    return {
      ...base,
      type: 'text',
      text: {
        preview_url: false,
        body: text
      }
    };
  }

  return {
    ...base,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: { buttons }
    }
  };
}

function describeProviderFailure(error) {
  const status = Number.isInteger(error?.response?.status) ? error.response.status : null;
  const providerCode = error?.response?.data?.error?.code ?? null;
  const parts = ['WhatsApp delivery failed'];
  if (status !== null) parts.push(`HTTP ${status}`);
  if (providerCode !== null) parts.push(`Meta code ${providerCode}`);
  if (status === null && providerCode === null) parts.push('network or provider error');
  return {
    message: parts.join(' - '),
    status,
    providerCode
  };
}

function outboundApiUrl() {
  if (process.env.WHATSAPP_API_URL?.trim()) {
    return requireString(process.env.WHATSAPP_API_URL, 'WHATSAPP_API_URL', 2048);
  }
  const phoneNumberId = requireString(process.env.META_PHONE_NUMBER_ID, 'META_PHONE_NUMBER_ID', 64);
  const version = requireString(process.env.META_API_VERSION || 'v23.0', 'META_API_VERSION', 16);
  if (!/^\d+$/.test(phoneNumberId)) throw new TypeError('META_PHONE_NUMBER_ID must contain digits only');
  if (!/^v\d+\.\d+$/.test(version)) throw new TypeError('META_API_VERSION must use the vXX.X format');
  return `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
}

/** Send one text or reply-button message through the WhatsApp Cloud API. */
export async function sendMessage(phone, text, interactiveOptions = []) {
  try {
    const apiUrl = outboundApiUrl();
    const token = requireString(process.env.WHATSAPP_TOKEN || process.env.META_ACCESS_TOKEN, 'WHATSAPP_TOKEN or META_ACCESS_TOKEN', 8192);
    const recipient = requireString(phone, 'phone', 32);
    const buttons = normalizeOptions(interactiveOptions);
    const body = requireString(
      text,
      'text',
      buttons.length ? MAX_INTERACTIVE_TEXT_LENGTH : MAX_TEXT_LENGTH
    );
    const payload = buildPayload(recipient, body, buttons);

    const response = await axios.post(apiUrl, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: REQUEST_TIMEOUT_MS
    });

    return response.data;
  } catch (error) {
    if (error instanceof WhatsAppDeliveryError) throw error;
    if (error instanceof TypeError) {
      throw new WhatsAppDeliveryError(`WhatsApp delivery configuration or payload is invalid: ${error.message}`, { requestAttempted: false });
    }

    const failure = describeProviderFailure(error);
    throw new WhatsAppDeliveryError(failure.message, failure);
  }
}

export const whatsappClient = Object.freeze({ sendMessage });

export default whatsappClient;
