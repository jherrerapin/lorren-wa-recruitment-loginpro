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

export function logWhatsappWebhookDiagnostics(payload = {}, endpoint = '') {
  const normalizedEndpoint = String(endpoint || '').trim() || 'unknown';
  for (const diagnostic of collectWhatsappWebhookDiagnostics(payload)) {
    console.info('[WA_WEBHOOK_DIAG]', JSON.stringify({
      endpoint: normalizedEndpoint,
      ...diagnostic
    }));
  }
}
