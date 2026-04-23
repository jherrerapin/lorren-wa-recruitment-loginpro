const CRITICAL_DISCARD_FIELDS = new Set(['age', 'documentType', 'documentNumber', 'gender']);
const GREETING_REGEX = /^(hola|buenas|buenos\s+dias|buenas\s+tardes|buenas\s+noches|mucho\s+gusto|si\s+claro|por\s+pdf)/i;
const ADDRESS_AGE_REGEX = /\b(calle|cra|carrera|avenida|av\.?|mz|manzana|torre|apto|barrio|localidad)\s*\d+/i;

function hasStrongEvidence(evidence = {}) {
  return Number(evidence.confidence || 0) >= 0.75 && typeof evidence.snippet === 'string' && evidence.snippet.trim().length >= 2;
}

export function applyFieldPolicy(extraction = {}, currentCandidate = {}) {
  const fields = extraction.fields || {};
  const fieldEvidence = extraction.fieldEvidence || {};
  const persistedFields = {};
  const reviewQueue = [];
  const blocked = [];
  const protectedDiscardFields = [];

  for (const [field, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === '') continue;
    const evidence = fieldEvidence[field] || {};

    if (field === 'fullName' && GREETING_REGEX.test(String(value))) {
      blocked.push({ field, reason: 'greeting_as_name', value, evidence });
      continue;
    }

    if (field === 'age' && ADDRESS_AGE_REGEX.test(String(evidence.snippet || value))) {
      blocked.push({ field, reason: 'address_as_age', value, evidence });
      protectedDiscardFields.push(field);
      continue;
    }

    if (!hasStrongEvidence(evidence)) {
      reviewQueue.push({ field, value, evidence, reason: 'low_confidence' });
      if (CRITICAL_DISCARD_FIELDS.has(field)) protectedDiscardFields.push(field);
      continue;
    }

    persistedFields[field] = value;
  }

  return {
    persistedFields,
    reviewQueue,
    blocked,
    protectedDiscardFields: [...new Set(protectedDiscardFields)],
    shouldPreventAutoDiscard: protectedDiscardFields.length > 0,
    metadata: {
      blockedCount: blocked.length,
      reviewCount: reviewQueue.length,
      criticalProtectionActive: protectedDiscardFields.length > 0
    },
    currentCandidate
  };
}
