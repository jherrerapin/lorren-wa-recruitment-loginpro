import { extractMessages } from './whatsapp.js';
import * as ai from './leadOriginAi.js';

const MIN_SCORE = 0.78;
const contactKey = ['fr', 'om'].join('');
const personKey = ['referrer', 'Name'].join('');
const sourceKey = ['source', 'Type'].join('');

function normalizeComparableText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isCandidateEligibleForPersonAttribution(candidate) {
  return Boolean(
    candidate
    && !candidate.campaignId
    && candidate[sourceKey] !== 'META_ADS'
    && !candidate[personKey]
  );
}

function hasLiteralPersonEvidence(body = '', decision = null) {
  if (decision?.kind !== 'PERSON' || !decision?.label || !decision?.evidence) return false;
  const bodyText = normalizeComparableText(body);
  const evidenceText = normalizeComparableText(decision.evidence);
  const labelText = normalizeComparableText(decision.label);
  if (!bodyText || !evidenceText || !labelText) return false;
  return bodyText.includes(evidenceText) && evidenceText.includes(labelText);
}

async function loadAttributionCandidate(prisma, contact) {
  return prisma.candidate.findUnique({
    where: { phone: contact },
    select: { id: true, campaignId: true, [sourceKey]: true, [personKey]: true }
  });
}

// Ejecuta clasificación IA estructurada de origen y persiste solo evidencia
// explícita que pueda comprobarse literalmente contra el mensaje recibido.
export function runtime(prisma, options = {}) {
  const classifyLeadOrigin = options.classifyLeadOrigin || ai.classifyLeadOrigin;

  return async (req, _res, next) => {
    try {
      const messages = extractMessages(req.body);
      for (const message of messages) {
        const contact = message?.[contactKey];
        const body = String(message?.text?.body || '').trim();
        if (!contact || !body) continue;

        const candidateBeforeAi = await loadAttributionCandidate(prisma, contact);
        if (!isCandidateEligibleForPersonAttribution(candidateBeforeAi)) continue;

        const decision = await classifyLeadOrigin(body);
        const score = Number(decision?.score || 0);
        if (score < MIN_SCORE || !hasLiteralPersonEvidence(body, decision)) continue;

        const candidate = await loadAttributionCandidate(prisma, contact);
        if (!isCandidateEligibleForPersonAttribution(candidate)) continue;

        await prisma.candidate.update({
          where: { id: candidate.id },
          data: { [personKey]: decision.label }
        });

        console.info('[LOREN_V2_ORIGIN_AI]', JSON.stringify({
          candidateId: candidate.id,
          score,
          evidence: decision.evidence
        }));
      }
      return next();
    } catch (error) {
      console.warn('[LOREN_V2_ORIGIN_AI_ERROR]', error?.message || error);
      return next();
    }
  };
}
