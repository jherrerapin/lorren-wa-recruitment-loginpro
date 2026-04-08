export function createWhatsappMock() {
  const sentMessages = [];

  return {
    sentMessages,
    handleSend(url, payload) {
      sentMessages.push({
        url,
        to: payload?.to || null,
        body: payload?.text?.body || '',
        payload
      });
      return { messaging_product: 'whatsapp', messages: [{ id: `mock-wa-${sentMessages.length}` }] };
    }
  };
}
