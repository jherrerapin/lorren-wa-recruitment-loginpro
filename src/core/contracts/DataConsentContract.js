export const DATA_CONSENT_VERSION = 'lorren-v2-2026-07-v3';

export const DATA_CONSENT_BUTTONS = Object.freeze([
  Object.freeze({ id: `data_consent:${DATA_CONSENT_VERSION}:accept`, title: 'Sí autorizo' }),
  Object.freeze({ id: `data_consent:${DATA_CONSENT_VERSION}:reject`, title: 'No autorizo' })
]);

export const DATA_CONSENT_TEXT = process.env.DATA_CONSENT_TEXT
  || 'Autorizo a LoginPro a tratar mis datos personales, hoja de vida y documentos enviados por WhatsApp para gestionar mi postulación, validar información, contactarme y conservar la trazabilidad del proceso. Entiendo que puedo solicitar consulta, actualización, corrección o revocatoria de esta autorización.';

export const DATA_CONSENT_PENDING_MODE = 'awaiting_data_consent';
export const CAMPAIGN_VACANCY_CONFIRMATION_MODE = 'campaign_vacancy_pending_confirmation';

const CONSENT_PENDING_CONTEXT_PREFIX = `${DATA_CONSENT_PENDING_MODE}:`;
const CONSENT_PROMPT = process.env.DATA_CONSENT_PROMPT
  || `Para continuar con tu postulación necesito que me indiques si autorizas a LoginPro a tratar tus datos con fines de reclutamiento.\n\n${DATA_CONSENT_TEXT}\n\nElige Sí autorizo o No autorizo. También puedes responder por escrito.`;

export function buildDataConsentPromptReply() {
  return CONSENT_PROMPT;
}

export function buildConsentPendingMode({ resumeMode = null, cvResendRequired = false } = {}) {
  const context = {
    resumeMode: String(resumeMode || '').trim() || null,
    cvResendRequired: Boolean(cvResendRequired)
  };
  if (!context.resumeMode && !context.cvResendRequired) return DATA_CONSENT_PENDING_MODE;
  const encoded = Buffer.from(JSON.stringify(context), 'utf8').toString('base64url');
  return `${CONSENT_PENDING_CONTEXT_PREFIX}${encoded}`;
}

export function parseConsentPendingMode(mode = '') {
  const value = String(mode || '');
  if (value === DATA_CONSENT_PENDING_MODE) {
    return { pending: true, resumeMode: null, cvResendRequired: false };
  }
  if (!value.startsWith(CONSENT_PENDING_CONTEXT_PREFIX)) {
    return { pending: false, resumeMode: null, cvResendRequired: false };
  }
  try {
    const decoded = JSON.parse(Buffer.from(
      value.slice(CONSENT_PENDING_CONTEXT_PREFIX.length),
      'base64url'
    ).toString('utf8'));
    return {
      pending: true,
      resumeMode: String(decoded?.resumeMode || '').trim() || null,
      cvResendRequired: Boolean(decoded?.cvResendRequired)
    };
  } catch {
    return { pending: true, resumeMode: null, cvResendRequired: false };
  }
}

export default Object.freeze({
  DATA_CONSENT_VERSION,
  DATA_CONSENT_BUTTONS,
  DATA_CONSENT_TEXT,
  DATA_CONSENT_PENDING_MODE,
  CAMPAIGN_VACANCY_CONFIRMATION_MODE,
  buildDataConsentPromptReply,
  buildConsentPendingMode,
  parseConsentPendingMode
});
