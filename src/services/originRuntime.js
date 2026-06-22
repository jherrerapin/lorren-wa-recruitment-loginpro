import { extractMessages } from './whatsapp.js';

export function runtime(prisma) {
  return async (req, _res, next) => {
    try {
      const messages = extractMessages(req.body);
      for (const message of messages) {
        if (message?.text?.body) console.info('[LOREN_V2_ORIGIN_AI_PENDING]');
      }
      return next();
    } catch (error) {
      console.warn('[LOREN_V2_ORIGIN_AI_ERROR]', error?.message || error);
      return next();
    }
  };
}
