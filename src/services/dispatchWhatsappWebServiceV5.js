import { sendDispatchWhatsappMessage as baseSendText } from './dispatchWhatsappWebServiceV6.js';

export {
  closeDispatchWhatsappSession,
  getDispatchWhatsappStatus,
  getDispatchWhatsappStatusView,
  initDispatchWhatsappClient,
  sendDispatchWhatsappMediaMessage
} from './dispatchWhatsappWebServiceV6.js';

function hourLabel(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return String(value || '');
  let hour = Number(match[1]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${match[2]} ${suffix}`;
}

function labelHours(value) {
  return String(value || '').replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:AM|PM|am|pm))/g, (_text, hour, minute) => hourLabel(`${hour}:${minute}`));
}

export async function sendDispatchWhatsappMessage(args = {}) {
  return baseSendText({ ...args, message: labelHours(args.message) });
}
