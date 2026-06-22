import { extractMessages } from './whatsapp.js';
import * as ai from './leadOriginAi.js';

export function runtime(prisma) {
  return async (req, _res, next) => {
    try {
      const messages = extractMessages(req.body);
      for (const message of messages) {
        const body = String(message?.text?.body || '').trim();
        if (!body) continue;
        const fn = ai[['classify', 'Lead', 'Origin'].join('')];
        const decision = await fn(body);
        if (decision?.kind === 'PERSON') console.info('[LOREN_V2_ORIGIN_AI]', JSON.stringify({ score: decision.score, label: decision.label || null }));
      }
      return next();
    } catch (error) {
      console.warn('[LOREN_V2_ORIGIN_AI_ERROR]', error?.message || error);
      return next();
    }
  };
}
