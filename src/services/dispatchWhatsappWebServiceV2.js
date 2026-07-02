import { getDispatchWhatsappStatus } from './dispatchWhatsappWebService.js';

export {
  getDispatchWhatsappStatus,
  getDispatchWhatsappStatusView,
  initDispatchWhatsappClient,
  sendDispatchWhatsappMessage,
  sendDispatchWhatsappMediaMessage
} from './dispatchWhatsappWebService.js';

export async function closeDispatchWhatsappSession() {
  return getDispatchWhatsappStatus();
}
