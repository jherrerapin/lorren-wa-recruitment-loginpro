const loggedPayloadEndpoints = new WeakMap();

export function collectWhatsappWebhookDiagnostics(payload = {}) {
  const diagnostics = [];

  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {};
      const phoneNumberId = String(value?.metadata?.phone_number_id || '').trim() || null;
      const messages = Array.isArray(value?.messages) ? value.messages : [];

      for (const message of messages) {
        diagnostics.push({
          phone_number_id: phoneNumberId,
          wamid: String(message?.id || '').trim() || null
        });
      }
    }
  }

  return diagnostics;
}

function shouldLogPayloadEndpoint(payload, endpoint) {
  if (!payload || typeof payload !== 'object') return true;
  let endpoints = loggedPayloadEndpoints.get(payload);
  if (!endpoints) {
    endpoints = new Set();
    loggedPayloadEndpoints.set(payload, endpoints);
  }
  if (endpoints.has(endpoint)) return false;
  endpoints.add(endpoint);
  return true;
}

export function logWhatsappWebhookDiagnostics(payload = {}, endpoint = '') {
  const normalizedEndpoint = String(endpoint || '').trim() || 'unknown';
  if (!shouldLogPayloadEndpoint(payload, normalizedEndpoint)) return;

  for (const diagnostic of collectWhatsappWebhookDiagnostics(payload)) {
    console.info('[WA_WEBHOOK_DIAG]', JSON.stringify({
      endpoint: normalizedEndpoint,
      ...diagnostic
    }));
  }
}
