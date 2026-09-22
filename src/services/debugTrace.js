import { getOpenAiModelConfig } from './openAiModelConfig.js';

const CANDIDATE_FIELDS = [
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'gender',
  'neighborhood',
  'locality',
  'medicalRestrictions',
  'transportMode',
  'experienceInfo',
  'experienceTime',
  'experienceSummary'
];

export { CANDIDATE_FIELDS };

export function createDebugTrace({ phone, currentStepBefore }) {
  const models = getOpenAiModelConfig();
  return {
    phone,
    currentStep_before: currentStepBefore || null,
    currentStep_after: currentStepBefore || null,
    openai_used: false,
    openai_status: process.env.OPENAI_API_KEY ? 'fallback' : 'disabled',
    openai_model: models.extraction.model,
    response_model: models.conversation.model,
    response_model_source: models.conversation.source,
    extraction_model: models.extraction.model,
    extraction_model_source: models.extraction.source,
    openai_temperature_omitted: true,
    openai_input_tokens: 0,
    openai_output_tokens: 0,
    openai_total_tokens: 0,
    model_usage: { extractionModel: models.extraction.model, responseModel: models.conversation.model, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    blockedClaims: [],
    fallbackReason: null,
    openai_intent: 'unknown',
    openai_detected_fields: [],
    engine_primary: false,
    engine_fallback_used: false,
    engine_fallback_reason: null,
    engine_loop_guard: false,
    engine_actions: [],
    engine_preview_eligible: false,
    engine_preview_executed: false,
    engine_preview_used: false,
    engine_preview_fallback: false,
    engine_preview_field_count: 0,
    engine_preview_effective_field_count: 0,
    engine_preview_decision_available: false,
    engine_preview_plan_reused: false,
    engine_preview_consumption: 'none',
    persisted_fields: [],
    consolidated_fields: [],
    rejected_fields: [],
    ignored_low_confidence_fields: [],
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

export function buildEnginePreviewTrace({ eligible = false, preview = {}, turnInterpretation = {} } = {}) {
  const previewFields = preview?.fields && typeof preview.fields === 'object'
    ? Object.keys(preview.fields).filter(Boolean)
    : [];
  const interpretationFields = turnInterpretation?.fields && typeof turnInterpretation.fields === 'object'
    ? turnInterpretation.fields
    : {};
  const sourceByField = turnInterpretation?.sourceByField && typeof turnInterpretation.sourceByField === 'object'
    ? turnInterpretation.sourceByField
    : {};
  const effectiveFieldCount = previewFields.filter((field) => (
    Object.hasOwn(interpretationFields, field)
    && ['engine', 'merged'].includes(sourceByField[field])
  )).length;
  const executed = Boolean(eligible);
  const fallback = executed && Boolean(preview?.fallback);

  return {
    engine_preview_eligible: Boolean(eligible),
    engine_preview_executed: executed,
    engine_preview_used: executed && Boolean(preview?.used),
    engine_preview_fallback: fallback,
    engine_preview_field_count: executed ? previewFields.length : 0,
    engine_preview_effective_field_count: effectiveFieldCount,
    engine_preview_decision_available: executed && !fallback && Boolean(preview?.decision),
    engine_preview_plan_reused: false,
    engine_preview_consumption: effectiveFieldCount > 0 ? 'fields' : 'none'
  };
}

export function applyEnginePreviewPlanReuse(debugTrace = {}, decisionReused = false) {
  const planReused = Boolean(decisionReused && debugTrace.engine_preview_decision_available);
  debugTrace.engine_preview_plan_reused = planReused;
  if (planReused) {
    debugTrace.engine_preview_consumption = Number(debugTrace.engine_preview_effective_field_count || 0) > 0
      ? 'fields_and_plan'
      : 'plan_reused';
  }
  return debugTrace;
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
  const normalized = String(text).trim().toLowerCase();
  if (!normalized) return 'empty';
  if (/(no me interesa|ya no|mejor no|prefiero no|paso)/i.test(normalized)) return 'decline_intent';
  if (/(quiero informacion|quiero saber|informacion|antes quiero saber|primero quiero saber)/i.test(normalized)) return 'info_request';
  if (/(no te voy a dar mis datos|antes de darte mis datos|antes de enviar mis datos)/i.test(normalized)) return 'objection';
  if (/(ya envie eso|ya envié eso|ya lo envie|ya lo envié|ya mande eso)/i.test(normalized)) return 'already_sent';
  if (/(otra vacante|otro cargo|cambie de opinion|cambié de opinión|me interesa otra)/i.test(normalized)) return 'change_intent';
  if (/(si|sí|quiero|interesad|continuar|postular|aplicar)/i.test(normalized)) return 'apply_intent';
  if (/(hoja de vida|cv|curriculum)/i.test(normalized)) return 'cv_intent';
  return 'data_or_unknown';
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

function isResidenceAliasedToName(field, value, parsedData = {}, candidate = {}) {
  if (!['neighborhood', 'locality'].includes(field)) return false;
  const residence = normalizeComparableValue(field, value);
  if (!residence) return false;
  return [parsedData.fullName, candidate.fullName]
    .map((name) => normalizeComparableValue('fullName', name))
    .filter(Boolean)
    .some((name) => name === residence);
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
    case 'gender':
      return ['unknown', 'pendiente'].includes(normalized);
    case 'transportMode':
      return ['ninguno', 'ninguna', 'sin', 'transporte'].includes(normalized);
    case 'medicalRestrictions':
      return ['pendiente'].includes(normalized);
    case 'locality':
    case 'neighborhood':
      return normalized.length < 2;
    case 'experienceInfo':
      return ['pendiente', 'tal vez'].includes(normalized);
    case 'experienceTime':
      return !/\d/.test(normalized);
    case 'experienceSummary':
      return normalized.length < 12;
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
    case 'age':
      return false;
    case 'documentType':
      return !['cc', 'ppt'].includes(currentNormalized) && ['cc', 'ppt'].includes(nextNormalized);
    case 'documentNumber':
      return currentNormalized.length < nextNormalized.length
        && (nextNormalized.startsWith(currentNormalized) || nextNormalized.endsWith(currentNormalized));
    case 'neighborhood':
    case 'locality':
      return currentNormalized.length < nextNormalized.length && nextNormalized.includes(currentNormalized);
    case 'gender':
      return currentNormalized === 'unknown' && ['female', 'male', 'other'].includes(nextNormalized);
    case 'transportMode':
      return currentNormalized === 'sin medio de transporte' && nextNormalized !== 'sin medio de transporte';
    case 'medicalRestrictions':
      return currentNormalized.length < nextNormalized.length;
    case 'experienceInfo':
      return currentNormalized !== nextNormalized;
    case 'experienceTime':
      return currentNormalized.length < nextNormalized.length || (!/\d/.test(currentNormalized) && /\d/.test(nextNormalized));
    case 'experienceSummary':
      return currentNormalized.length < nextNormalized.length;
    default:
      return false;
  }
}

export function splitFieldDecisions(parsedData = {}, candidate = {}, options = {}) {
  const allowOverwriteFields = new Set(options.allowOverwriteFields || []);
  const decisions = {
    persistedData: {},
    persistedFields: [],
    consolidatedFields: [],
    rejectedFields: [],
    ignoredLowConfidenceFields: []
  };

  for (const field of CANDIDATE_FIELDS) {
    const value = parsedData[field];
    if (value === undefined || value === null || value === '') continue;

    if (isResidenceAliasedToName(field, value, parsedData, candidate)) {
      decisions.rejectedFields.push(field);
      continue;
    }

    const candidateHasValue = candidate[field] !== undefined && candidate[field] !== null && candidate[field] !== '';
    const shouldForceOverwrite = allowOverwriteFields.has(field);

    if (candidateHasValue && !shouldForceOverwrite) {
      if (isEquivalentFieldValue(field, candidate[field], value)) continue;
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
    if (candidateHasValue && shouldForceOverwrite) decisions.consolidatedFields.push(field);
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
    } : undefined,
    interactive: message.interactive ? {
      type: message.interactive.type,
      button_reply: message.interactive.button_reply ? {
        id: message.interactive.button_reply.id,
        title: message.interactive.button_reply.title
      } : undefined,
      list_reply: message.interactive.list_reply ? {
        id: message.interactive.list_reply.id,
        title: message.interactive.list_reply.title
      } : undefined
    } : undefined
  };
}
