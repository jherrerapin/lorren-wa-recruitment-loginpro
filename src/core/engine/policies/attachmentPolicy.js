const CV_FORMAT_REPLY =
  'Para registrar tu hoja de vida, adjunta el archivo en PDF o Word (DOC o DOCX).';

const UNSUPPORTED_CV_ATTACHMENT_TYPES = new Set([
  'document',
  'image',
  'video',
  'sticker',
  'unknown'
]);

function candidateFacts(input = {}) {
  const facts = input?.candidate?.facts;
  return facts && typeof facts === 'object' && !Array.isArray(facts)
    ? facts
    : {};
}

function interpretedFields(input = {}) {
  const fields = input?.interpretation?.fields;
  return fields && typeof fields === 'object' && !Array.isArray(fields)
    ? fields
    : {};
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function remainingPendingFields(input = {}) {
  const facts = candidateFacts(input);
  const extracted = interpretedFields(input);
  const pending = Array.isArray(input?.pending?.fields)
    ? input.pending.fields
    : [];

  return pending.filter((field) => (
    !hasValue(extracted[field])
    && !hasValue(facts[field])
  ));
}

function consentAccepted(input = {}) {
  const facts = candidateFacts(input);
  const status = String(facts.dataConsentStatus || '').trim().toUpperCase();
  const decision = String(input?.interpretation?.consent?.decision || '').trim().toUpperCase();

  return status === 'ACCEPTED' || decision === 'ACCEPTED';
}

function hasResolvedVacancy(input = {}) {
  const facts = candidateFacts(input);
  return Boolean(facts.vacancyId || input?.vacancy?.id);
}

function expectsCv(input = {}) {
  const facts = candidateFacts(input);
  const currentStep = String(facts.currentStep || '').trim().toUpperCase();

  if (currentStep === 'ASK_CV') return true;
  if (['SCHEDULING', 'SCHEDULED', 'DONE'].includes(currentStep)) return false;

  return consentAccepted(input)
    && hasResolvedVacancy(input)
    && remainingPendingFields(input).length === 0;
}

function hasUnsupportedCvAttachment(input = {}) {
  if (input?.attachments?.hasCv === true) return false;

  const items = Array.isArray(input?.attachments?.items)
    ? input.attachments.items
    : [];

  return items.some((item) => (
    UNSUPPORTED_CV_ATTACHMENT_TYPES.has(
      String(item?.type || '').trim().toLowerCase()
    )
  ));
}

/**
 * Pure attachment-response policy.
 *
 * Audio is deliberately excluded: audio follows the separate human-review
 * authority. This policy only explains supported CV formats when the process is
 * actually waiting for a CV and the normalized attachment evidence says no
 * valid CV was received.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export async function attachmentPolicy(input) {
  if (input?.execution?.mayReply !== true) return {};
  if (!expectsCv(input)) return {};
  if (!hasUnsupportedCvAttachment(input)) return {};

  return {
    reply: {
      text: CV_FORMAT_REPLY
    }
  };
}

export default attachmentPolicy;
