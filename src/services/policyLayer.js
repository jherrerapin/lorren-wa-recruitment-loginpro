const CRITICAL_DISCARD_FIELDS = new Set(['age', 'documentType', 'documentNumber', 'gender']);
const GREETING_REGEX = /^(hola|buenas|buenos\s+dias|buenas\s+tardes|buenas\s+noches|mucho\s+gusto|si\s+claro|por\s+pdf|gracias|ok|listo|como estas)/i;
const ADDRESS_AGE_REGEX = /\b(calle|cra|carrera|avenida|av\.?|mz|manzana|torre|apto|barrio|localidad)\s*\d+/i;
const AGE_CONTEXT_REGEX = /\b(tengo|edad|anos|años|cumpli|cumplo|soy de)\b/i;

function hasStrongEvidence(evidence = {}) {
  return Number(evidence.confidence || 0) >= 0.75 && typeof evidence.snippet === 'string' && evidence.snippet.trim().length >= 2;
}

function appearsLikeName(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!normalized) return false;
  if (GREETING_REGEX.test(normalized)) return false;
  const parts = normalized.split(' ');
  if (parts.length < 2) return false;
  return parts.every((part) => /^[a-záéíóúñü.'-]+$/i.test(part) && part.length >= 2);
}

function hasReliableGenderEvidence(value, evidence = {}) {
  const source = String(evidence.source || '').toLowerCase();
  const snippet = String(evidence.snippet || '').toLowerCase();
  const confidence = Number(evidence.confidence || 0);
  if (!['FEMALE', 'MALE', 'OTHER'].includes(String(value || '').toUpperCase())) return false;

  const hasExplicitCandidateGender = /\b(soy mujer|soy hombre|me considero mujer|me considero hombre|me identifico como mujer|me identifico como hombre|sexo femenino|sexo masculino|genero femenino|género femenino|genero masculino|género masculino|soy candidata|soy candidato|estoy interesada|estoy interesado|interesada en la vacante|interesado en la vacante|quedo atenta|quedo atento|postulada|postulado|inscrita|inscrito|registrada|registrado|me postulo como candidata|me postulo como candidato|femenin|masculin)\b/.test(snippet);
  if (!hasExplicitCandidateGender) return false;
  if (confidence >= 0.9) return true;
  if (!source.includes('responses') && !source.includes('model') && !source.includes('openai') && !source.includes('local')) return false;
  return confidence >= 0.75;
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

    if (field === 'fullName' && !appearsLikeName(value)) {
      blocked.push({ field, reason: 'greeting_as_name', value, evidence });
      continue;
    }

    if (
      field === 'age'
      && ADDRESS_AGE_REGEX.test(String(evidence.snippet || value))
      && !AGE_CONTEXT_REGEX.test(String(evidence.snippet || ''))
    ) {
      blocked.push({ field, reason: 'address_as_age', value, evidence });
      protectedDiscardFields.push(field);
      continue;
    }

    if (field === 'gender' && !hasReliableGenderEvidence(value, evidence)) {
      reviewQueue.push({ field, value, evidence, reason: 'weak_gender_inference' });
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
