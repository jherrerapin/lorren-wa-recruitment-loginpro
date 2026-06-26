import { sendDispatchWhatsappMessage as sendDispatchWhatsappMessageBase } from './dispatchWhatsappWebServiceV2.js';

export {
  closeDispatchWhatsappSession,
  getDispatchWhatsappStatus,
  getDispatchWhatsappStatusView,
  initDispatchWhatsappClient,
  sendDispatchWhatsappMediaMessage
} from './dispatchWhatsappWebServiceV2.js';

function formatTimeAmPm(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return String(value || '').trim();
  let hour = Number(match[1]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${match[2]} ${suffix}`;
}

function formatMessageTimes(value) {
  return String(value || '').replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:AM|PM|am|pm))/g, (_full, hour, minute) => formatTimeAmPm(`${hour}:${minute}`));
}

export async function sendDispatchWhatsappMessage(args = {}) {
  return sendDispatchWhatsappMessageBase({
    ...args,
    message: formatMessageTimes(args.message)
  });
}
