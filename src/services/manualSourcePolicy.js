const MANUAL_SOURCE_PREFIXES = ['admin_', 'manual_'];
const MANUAL_SOURCE_VALUES = new Set(['MANUAL_AUTHORIZED', 'manual_authorized', 'admin_outbound']);

function normalizeSource(source = '') {
  return String(source || '').trim();
}

function normalizeActor(actor = '') {
  return String(actor || '').trim().toUpperCase();
}

export function getOutboundSource(rawPayload = {}) {
  return rawPayload?.source || rawPayload?.sourceCategory || null;
}

export function isManualOutboundSource(source = '') {
  const normalizedSource = normalizeSource(source);
  if (!normalizedSource) return true;
  if (MANUAL_SOURCE_VALUES.has(normalizedSource)) return true;
  return MANUAL_SOURCE_PREFIXES.some((prefix) => normalizedSource.toLowerCase().startsWith(prefix));
}

export function inferOutboundActorFromSource(source = '') {
  const normalizedSource = normalizeSource(source);
  const lowerSource = normalizedSource.toLowerCase();
  if (!normalizedSource) return 'RECRUITER';
  if (isManualOutboundSource(normalizedSource)) return 'RECRUITER';
  if (lowerSource.startsWith('reminder')) return 'REMINDER';
  if (lowerSource.startsWith('system')) return 'SYSTEM';
  return 'BOT';
}

export function classifyOutboundActor(rawPayload = {}) {
  const source = getOutboundSource(rawPayload);
  const explicitActor = normalizeActor(rawPayload?.actor || rawPayload?.actorRole);
  const actor = explicitActor || inferOutboundActorFromSource(source);
  const isManual = actor === 'RECRUITER' || actor === 'ADMIN' || isManualOutboundSource(source);

  return {
    actor,
    source,
    isManual
  };
}

export function isHumanOutboundMessage(message = {}) {
  if (message?.direction !== 'OUTBOUND') return false;
  return classifyOutboundActor(message?.rawPayload || {}).isManual;
}
