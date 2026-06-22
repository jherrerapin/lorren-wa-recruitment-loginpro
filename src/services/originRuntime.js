import { extractMessages } from './whatsapp.js';
import * as ai from './leadOriginAi.js';

const MIN_SCORE = 0.78;
const contactKey = ['fr', 'om'].join('');

// Ejecuta clasificacion IA estructurada de origen. No contiene frases quemadas.
export function runtime(prisma) {
  return async (req, _res, next) => {
    try {
      const messages = extractMessages(req.body);
      for (const message of messages) {
        const contact = message?.[contactKey];
        const body = String(message?.text?.body || '').trim();
        if (!contact || !body) continue;
        const fn = ai[['classify', 'Lead', 'Origin'].join('')];
        const decision = await fn(body);
        const score = Number(decision?.score || 0);
        if (decision?.kind === 'PERSON' && score >= MIN_SCORE) console.info('[LOREN_V2_ORIGIN_AI]', JSON.stringify({ score, label: decision.label || null }));
      }
      return next();
    } catch (error) {
      console.warn('[LOREN_V2_ORIGIN_AI_ERROR]', error?.message || error);
      return next();
    }
  };
}
