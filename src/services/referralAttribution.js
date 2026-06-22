import { extractMessages } from './whatsapp.js';

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePhone(value = '') {
  const digits = String(value || '').replace(/\D+/g, '');
  if (digits.startsWith('57') && digits.length > 10) return digits.slice(2);
  return digits || null;
}

function cleanReferrerName(value = '') {
  const cleaned = String(value || '')
    .replace(/\b(?:mi|un|una|el|la|senor|señor|senora|señora|amigo|amiga|compañero|companero|familiar|primo|prima|tio|tia)\b/gi, ' ')
    .replace(/\b(?:numero|telefono|celular|whatsapp|contacto|empresa|vacante|trabajo)\b.*$/i, '')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length < 3 || cleaned.length > 80) return null;
  return cleaned;
}

export function parseReferralFromText(text = '') {
  const original = String(text || '').trim();
  const normalized = normalizeText(original);
  if (!normalized) return { isReferral: false, referrerName: null, referrerPhone: null };

  const isReferral = /\b(referid[oa]|recomendad[oa]|recomendo|recomendó|recomienda|de parte de|me envio|me envió|me paso|me pasó|me compartio|me compartió|me dieron el numero|me dieron el número)\b/.test(normalized);

  if (!isReferral) {
    return { isReferral: false, referrerName: null, referrerPhone: null };
  }

  const phoneMatch = original.match(/(?:\+?57\s*)?(?:3\d{2})[\s.-]*\d{3}[\s.-]*\d{4}/);
  const referrerPhone = normalizePhone(phoneMatch?.[0] || '');

  const namePatterns = [
    /(?:referid[oa]\s+por|recomendad[oa]\s+por|me\s+recomend[oó]|me\s+recomienda|de\s+parte\s+de|me\s+envi[oó]|me\s+pas[oó]|me\s+comparti[oó])\s+([^,.\n;]+)/i,
    /(?:vengo\s+de\s+parte\s+de)\s+([^,.\n;]+)/i
  ];

  let referrerName = null;
  for (const pattern of namePatterns) {
    const match = original.match(pattern);
    if (match?.[1]) {
      referrerName = cleanReferrerName(match[1]);
      if (referrerName) break;
    }
  }

  return { isReferral: true, referrerName, referrerPhone };
}

export async function attributeCandidateReferralFromText(prisma, candidateId, text = '') {
  if (!prisma?.candidate?.update || !candidateId) {
    return { attributed: false, reason: 'prisma_not_ready' };
  }

  const parsed = parseReferralFromText(text);
  if (!parsed.isReferral) return { attributed: false, reason: 'no_referral_intent' };

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { id: true, sourceType: true, referrerName: true, referrerPhone: true, campaignId: true }
  });

  if (!candidate) return { attributed: false, reason: 'candidate_not_found' };

  const data = {
    referrerName: candidate.referrerName || parsed.referrerName,
    referrerPhone: candidate.referrerPhone || parsed.referrerPhone
  };

  if (!candidate.campaignId && candidate.sourceType !== 'META_ADS') {
    data.sourceType = 'REFERRED';
  }

  await prisma.candidate.update({ where: { id: candidateId }, data });

  return {
    attributed: true,
    reason: 'referral_text_detected',
    referrerName: data.referrerName || null,
    referrerPhone: data.referrerPhone || null
  };
}

export function referralAttributionMiddleware(prisma) {
  return async (req, _res, next) => {
    try {
      const messages = extractMessages(req.body);
      if (!messages.length) return next();

      for (const message of messages) {
        const from = message?.from;
        const body = message?.text?.body || '';
        if (!from || !body) continue;

        const parsed = parseReferralFromText(body);
        if (!parsed.isReferral) continue;

        const candidate = await prisma.candidate.upsert({
          where: { phone: from },
          update: {},
          create: { phone: from }
        });

        const result = await attributeCandidateReferralFromText(prisma, candidate.id, body);
        if (result.attributed) {
          console.info('[REFERRAL_ATTRIBUTION]', JSON.stringify({
            phone: from,
            candidateId: candidate.id,
            referrerName: result.referrerName || null,
            referrerPhone: result.referrerPhone || null
          }));
        }
      }

      return next();
    } catch (error) {
      console.warn('[REFERRAL_ATTRIBUTION_ERROR]', error?.message || error);
      return next();
    }
  };
}
