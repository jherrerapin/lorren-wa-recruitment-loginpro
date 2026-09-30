import { createHmac, timingSafeEqual } from 'node:crypto';

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bodyBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) {
    return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  }
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  return null;
}

/** Verify Meta's x-hub-signature-256 against the exact received body bytes. */
export function verifySignature(rawBody, signature, appSecret) {
  try {
    const bytes = bodyBuffer(rawBody);
    const secret = nonEmptyString(appSecret);
    const header = nonEmptyString(signature);
    if (!bytes || !secret || !header || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;

    const receivedDigest = Buffer.from(header.slice('sha256='.length), 'hex');
    const expectedDigest = createHmac('sha256', secret).update(bytes).digest();
    if (receivedDigest.length !== expectedDigest.length) return false;

    return timingSafeEqual(receivedDigest, expectedDigest);
  } catch {
    return false;
  }
}

function normalizeTimestamp(value) {
  if ((typeof value === 'string' && /^\d{10,13}$/.test(value)) || typeof value === 'number') {
    const numeric = Number(value);
    const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  return null;
}

function normalizeTextMessage(message) {
  if (message.type !== 'text') return null;
  const text = nonEmptyString(asRecord(message.text).body);
  if (!text) return null;
  return { type: 'text', text, payload: null };
}

function normalizeInteractiveMessage(message) {
  if (message.type === 'button') {
    const button = asRecord(message.button);
    const payload = nonEmptyString(button.payload);
    const text = nonEmptyString(button.text) || payload;
    return text ? { type: 'interactive', text, payload } : null;
  }

  if (message.type !== 'interactive') return null;
  const interactive = asRecord(message.interactive);
  const reply = Object.keys(asRecord(interactive.button_reply)).length
    ? asRecord(interactive.button_reply)
    : asRecord(interactive.list_reply);
  const payload = nonEmptyString(reply.id);
  const text = nonEmptyString(reply.title) || payload;
  return text ? { type: 'interactive', text, payload } : null;
}

function normalizeMediaMessage(message) {
  if (!['document', 'image', 'audio'].includes(message.type)) return null;
  const source = asRecord(message[message.type]);
  const mediaId = nonEmptyString(source.id);
  const mimeType = nonEmptyString(source.mime_type);
  if (!mediaId || !mimeType) return null;

  const caption = nonEmptyString(source.caption);
  const fileName = nonEmptyString(source.filename);
  return {
    type: message.type,
    text: caption || '',
    payload: null,
    media: {
      mediaId,
      mimeType,
      fileName
    }
  };
}

function normalizeMessage(message) {
  const record = asRecord(message);
  const messageId = nonEmptyString(record.id);
  const from = nonEmptyString(record.from);
  if (!messageId || !from) return null;

  const content = normalizeTextMessage(record)
    || normalizeInteractiveMessage(record)
    || normalizeMediaMessage(record);
  if (!content) return null;

  const referral = Object.fromEntries(
    ['headline', 'source_url', 'ad_id', 'source_id', 'source_type', 'ctwa_clid']
      .map((key) => [key, nonEmptyString(asRecord(record.referral)[key])])
      .filter(([, value]) => value !== null)
  );

  return {
    messageId,
    from,
    timestamp: normalizeTimestamp(record.timestamp),
    ...content,
    ...(Object.keys(referral).length ? { referral } : {})
  };
}

/**
 * Flatten the first actionable candidate message from a Meta webhook. Delivery
 * receipts, read notifications and unsupported events safely return null.
 */
export function parseWebhookPayload(body) {
  const payload = asRecord(body);
  if (payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return null;

  for (const entryValue of payload.entry) {
    const entry = asRecord(entryValue);
    if (!Array.isArray(entry.changes)) continue;

    for (const changeValue of entry.changes) {
      const change = asRecord(changeValue);
      const messages = Array.isArray(asRecord(change.value).messages)
        ? asRecord(change.value).messages
        : [];

      for (const message of messages) {
        const normalized = normalizeMessage(message);
        if (normalized) return normalized;
      }
    }
  }

  return null;
}

export default Object.freeze({ verifySignature, parseWebhookPayload });
