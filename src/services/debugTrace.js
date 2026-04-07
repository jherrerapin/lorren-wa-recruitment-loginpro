const CANDIDATE_FIELDS = ['fullName', 'documentType', 'documentNumber', 'age', 'neighborhood', 'locality', 'medicalRestrictions', 'transportMode'];

export { CANDIDATE_FIELDS };

export function createDebugTrace({ phone, currentStepBefore }) {
  return {
    phone,
    currentStep_before: currentStepBefore || null,
    currentStep_after: currentStepBefore || null,
    openai_used: false,
    openai_status: process.env.OPENAI_API_KEY ? 'fallback' : 'disabled',
    openai_model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    openai_temperature_omitted: true,
    openai_intent: 'unknown',
    openai_detected_fields: [],
    engine_primary: false,
    engine_fallback_used: false,
    engine_fallback_reason: null,
    engine_loop_guard: false,
    engine_actions: [],
    persisted_fields: [],
    consolidated_fields: [],
    rejected_fields: [],
    ignored_low_confidence_fields: [],
    suspicious_full_name_rejected: false,
    rejected_name_reason: null,
    normalized_fields: {},
    source_by_field: {},
    batched_message_count: 1,
    used_multiline_context: false,
    consolidated_input_summary: null,
    cv_detected: false,
    cv_saved: false,
    cv_invalid_mime: false,
    cv_download_failed: false,
    error_summary: null
  };
}

export function summarizeError(error) {
  if (!error) return null;
  const status = error?.response?.status ? `HTTP ${error.response.status}` : null;
  const code = error?.code || null;
  const name = error?.name || 'Error';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 180) : 'Unexpected error';
  return [name, status, code, message].filter(Boolean).join(' | ');
}

export function inferIntent(text = '') {
  const n = String(text).trim().toLowerCase();
  if (!n) return 'empty';
  if (/(no me interesa|ya no|mejor no|prefiero no|paso)/i.test(n)) return 'decline_intent';
  if (/(quiero informacion|quiero saber|informacion|antes quiero saber|primero quiero saber)/i.test(n)) return 'info_request';
  if (/(no te voy a dar mis datos|antes de darte mis datos|antes de enviar mis datos)/i.test(n)) return 'objection';
  if (/(ya envie eso|ya envié eso|ya lo envie|ya lo envié|ya mande eso)/i.test(n)) return 'already_sent';
  if (/(otra vacante|otro cargo|cambie de opinion|cambié de opinión|me interesa otra)/i.test(n)) return 'change_intent';
  if (/(si|sí|quiero|interesad|continuar|postular|aplicar)/i.test(n)) return 'apply_intent';
  if (/(hoja de vida|cv|curriculum)/i.test(n)) return 'cv_intent';
  return 'data_or_unknown';
}

export function isSuspiciousFullName(value = '') {
  const name = String(value || '').trim();
  const normalized = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!name) return false;
  if (/\d/.test(name)) return true;
  if (!/^[A-Za-zÁÉÍÓÚÑáéíóúñ\s'.-]+$/.test(name)) return true;

  if (/[?¿]/.test(name)) return true;

  const explicitNonNamePatterns = [
    /\b(me interesa|estoy interesado|estoy interesada|quiero continuar|deseo continuar|quiero seguir|quiero aplicar|quiero postularme|ok|okay|si estoy interesado|si estoy interesada)\b/,
    /\b(me|interesa|quiero|deseo|estoy|tengo|poseo|busco|necesito|puedo|continuar)\b/,
    /\b(que|cuales|como|cuando|donde|datos|necesitas|vehiculo|vehículo|moto)\b/
  ];
  if (explicitNonNamePatterns.some((pattern) => pattern.test(normalized))) return true;

  const commonIntentPhrases = [
    'si estoy interesado',
    'si estoy interesada',
    'que datos necesitas',
    'tengo moto',
    'poseo vehiculo',
    'poseo vehículo',
    'me interesa',
    'quiero continuar',
    'deseo continuar',
    'ok'
  ];
  if (commonIntentPhrases.some((phrase) => normalized.includes(phrase))) return true;

  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return true;
  if (parts.some((p) => p.length < 2)) return true;

  if (parts.length > 4) return true;

  const connectors = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
  const lexicalParts = parts.filter((p) => !connectors.has(p.toLowerCase()));
  if (lexicalParts.length < 2) return true;

  return false;
}

function normalizeComparableValue(field, value) {
  if (value === undefined || value === null) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  if (field === 'documentNumber') return raw.replace(/\D/g, '');
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isEquivalentFieldValue(field, currentValue, nextValue) {
  return normalizeComparableValue(field, currentValue) === normalizeComparableValue(field, nextValue);
}

function isIncompleteFieldValue(field, value) {
  const normalized = normalizeComparableValue(field, value);
  if (!normalized) return true;

  switch (field) {
    case 'age': {
      const age = Number.parseInt(normalized, 10);
      return !Number.isFinite(age) || age < 14 || age > 80;
    }
    case 'transportMode':
      return ['ninguno', 'ninguna', 'sin', 'transporte'].includes(normalized);
    case 'medicalRestrictions':
      return ['no', 'ninguna', 'ninguno', 'pendiente'].includes(normalized);
    case 'locality':
      return normalized.length < 3;
    default:
      return false;
  }
}

function canConsolidateField(field, currentValue, nextValue) {
  const currentNormalized = normalizeComparableValue(field, currentValue);
  const nextNormalized = normalizeComparableValue(field, nextValue);
  if (!currentNormalized || !nextNormalized || currentNormalized === nextNormalized) return false;
  if (isIncompleteFieldValue(field, currentValue)) return true;

  switch (field) {
    case 'fullName':
      return isSuspiciousFullName(String(currentValue || '')) && !isSuspiciousFullName(String(nextValue || ''));
    case 'documentType':
      return !['cc', 'ti', 'ce', 'ppt', 'pasaporte'].includes(currentNormalized)
        && ['cc', 'ti', 'ce', 'ppt', 'pasaporte'].includes(nextNormalized);
    case 'documentNumber':
      return currentNormalized.length < nextNormalized.length
        && (nextNormalized.startsWith(currentNormalized) || nextNormalized.endsWith(currentNormalized));
    case 'neighborhood':
    case 'locality':
      return currentNormalized.length < nextNormalized.length && nextNormalized.includes(currentNormalized);
    case 'age':
      return false;
    case 'transportMode':
      return currentNormalized === 'sin medio de transporte' && nextNormalized !== 'sin medio de transporte';
    case 'medicalRestrictions':
      return currentNormalized.length < nextNormalized.length
        || /sin restricciones|no tengo restricciones|ninguna restriccion/.test(nextNormalized);
    default:
      return false;
  }
}

export function splitFieldDecisions(parsedData = {}, candidate = {}, options = {}) {
  const sourceByField = options.sourceByField || {};
  const allowOverwriteFields = new Set(options.allowOverwriteFields || []);
  const decisions = {
    persistedData: {},
    persistedFields: [],
    consolidatedFields: [],
    rejectedFields: [],
    ignoredLowConfidenceFields: [],
    suspiciousFullNameRejected: false,
    rejectedNameReason: null
  };

  for (const field of CANDIDATE_FIELDS) {
    const value = parsedData[field];
    if (value === undefined || value === null || value === '') continue;
    const fieldSource = sourceByField[field] || 'unknown';

    if (field === 'fullName' && isSuspiciousFullName(value)) {
      decisions.rejectedFields.push('fullName');
      decisions.suspiciousFullNameRejected = true;
      decisions.rejectedNameReason = sourceByField.fullName ? `suspicious_${sourceByField.fullName}` : 'suspicious_name_pattern';
      continue;
    }

    const trimmedValue = String(value).trim();
    const candidateHasValue = candidate[field] !== undefined && candidate[field] !== null && candidate[field] !== '';
    const shouldForceOverwrite = allowOverwriteFields.has(field);

    if (candidateHasValue && !shouldForceOverwrite) {
      if (isEquivalentFieldValue(field, candidate[field], value)) {
        continue;
      }
      if (canConsolidateField(field, candidate[field], value)) {
        decisions.persistedData[field] = value;
        decisions.persistedFields.push(field);
        decisions.consolidatedFields.push(field);
        continue;
      }
      decisions.rejectedFields.push(field);
      continue;
    }

    decisions.persistedData[field] = value;
    decisions.persistedFields.push(field);
    if (candidateHasValue && shouldForceOverwrite) {
      decisions.consolidatedFields.push(field);
    }
  }

  return decisions;
}

export function sanitizeForRawPayload(message = {}) {
  return {
    id: message.id,
    from: message.from,
    timestamp: message.timestamp,
    type: message.type,
    text: message.text?.body ? { body: message.text.body } : undefined,
    document: message.document ? {
      id: message.document.id,
      filename: message.document.filename,
      mime_type: message.document.mime_type,
      sha256: message.document.sha256
    } : undefined
  };
}
