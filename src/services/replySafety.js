import { buildMissingFieldReply } from './readinessGuard.js';

function normalizeScopeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const PROFILE_REQUEST_SCOPE_CATALOG = [
  {
    key: 'email',
    fields: ['email', 'correo'],
    requestPattern: /\b(?:correo(?:\s+electronico)?|email|e-mail|mail)\b/i
  },
  {
    key: 'phone',
    fields: ['phone', 'telefono'],
    requestPattern: /\b(?:telefono|celular|numero\s+de\s+(?:contacto|telefono|celular)|whatsapp)\b/i
  },
  {
    key: 'address',
    fields: ['address', 'direccion'],
    requestPattern: /\b(?:direccion|lugar\s+de\s+residencia|domicilio)\b/i
  }
];

function replyAsksForCandidateData(reply = '') {
  const normalized = normalizeScopeText(reply);
  if (!normalized) return false;
  return /\b(?:me\s+falta|faltan?|necesito|confirma(?:r|me)?|confirmame|comparteme|envia(?:me)?|indica(?:me)?|dime|pasame|regalame|cual\s+es)\b/
    .test(normalized);
}

function readinessAllowsProfileRequest(readiness = {}, request = {}) {
  const missingFields = (readiness.missingFields || readiness.missingForDone || [])
    .map((field) => normalizeScopeText(field));
  const missingLabels = (readiness.missingFieldLabels || [])
    .map((label) => normalizeScopeText(label));
  const allowedValues = new Set([...missingFields, ...missingLabels]);

  return request.fields.some((field) => allowedValues.has(normalizeScopeText(field)))
    || missingLabels.some((label) => request.requestPattern.test(label));
}

export function guardReplyAgainstReadinessDrift(reply = '', readiness = {}) {
  const originalReply = String(reply || '').trim();
  if (!originalReply || !replyAsksForCandidateData(originalReply)) {
    return { reply: originalReply, blocked: false, reason: null, requestedFieldsOutsideReadiness: [] };
  }

  const normalizedReply = normalizeScopeText(originalReply);
  const requestedFieldsOutsideReadiness = PROFILE_REQUEST_SCOPE_CATALOG
    .filter((request) => request.requestPattern.test(normalizedReply))
    .filter((request) => !readinessAllowsProfileRequest(readiness, request))
    .map((request) => request.key);

  if (!requestedFieldsOutsideReadiness.length) {
    return { reply: originalReply, blocked: false, reason: null, requestedFieldsOutsideReadiness: [] };
  }

  return {
    reply: buildMissingFieldReply(readiness),
    blocked: true,
    reason: 'profile_request_outside_readiness',
    requestedFieldsOutsideReadiness
  };
}

const CV_UNSAFE_FALLBACK_REPLY = 'Para continuar, envíame tu hoja de vida como archivo PDF o DOCX. No puedo registrarla en foto ni impresa por este medio.';

const UNSAFE_CV_REPLY_PATTERNS = [
  /hoja\s+de\s+vida\s+en\s+foto/i,
  /foto\s+de\s+la\s+hoja\s+de\s+vida/i,
  /imagen\s+de\s+la\s+hoja\s+de\s+vida/i,
  /foto\s+clara\s+(?:del\s+)?(?:cv|curriculum|hoja\s+de\s+vida)/i,
  /m[aá]ndala\s+en\s+foto/i,
  /puede\s+ser\s+foto/i,
  /\bimpresa\b/i,
  /como\s+la\s+tengas/i,
  /como\s+la\s+tenga/i,
  /minerva\s*1003/i,
  /formato\s+minerva\s*1003\s+o\s+impresa/i
];

function isConfiguredInterviewDocumentReply(reply = '', vacancy = null) {
  const configuredDocuments = String(vacancy?.requiredDocuments || '').trim();
  if (!configuredDocuments) return false;

  const text = String(reply || '');
  if (!/\b(?:entrevista|traer|llevar|recuerda|documentaci[oó]n|documentos?)\b/i.test(text)) return false;

  const normalizedReply = normalizeText(text);
  const normalizedDocuments = normalizeText(configuredDocuments);
  const configuredSensitiveTerms = [
    'foto',
    'imagen',
    'impresa',
    'como la tenga',
    'como la tengas',
    'minerva 1003'
  ].filter((term) => normalizedDocuments.includes(normalizeText(term)));

  return configuredSensitiveTerms.length > 0
    && configuredSensitiveTerms.some((term) => normalizedReply.includes(normalizeText(term)));
}

const LEGACY_CV_UPLOAD_FORMAT_PATTERNS = [
  /PDF\s*,\s*DOC\s+(?:o|or)\s+DOCX/gi,
  /PDF\s+(?:o|or)\s+Word\/DOCX/gi,
  /PDF\s*,\s*Word\s+(?:o|or)\s+DOCX/gi
];

function isCandidateCvUploadInstruction(reply = '') {
  const text = String(reply || '');
  const mentionsCv = /\b(?:hoja\s+de\s+vida|hv|curr[ií]culum|cv)\b/i.test(text);
  const requestsFileUpload = /\b(?:adjunt\w*|envi\w*|carg\w*|archivo\s+real|registr\w*)\b/i.test(text);
  return mentionsCv && requestsFileUpload;
}

export function normalizeCvUploadFormatInstruction(reply = '', vacancy = null) {
  const originalReply = String(reply || '').trim();
  if (!originalReply || isConfiguredInterviewDocumentReply(originalReply, vacancy)) {
    return { reply: originalReply, changed: false };
  }
  if (!isCandidateCvUploadInstruction(originalReply)) {
    return { reply: originalReply, changed: false };
  }

  let normalizedReply = originalReply;
  for (const pattern of LEGACY_CV_UPLOAD_FORMAT_PATTERNS) {
    normalizedReply = normalizedReply.replace(pattern, 'PDF o DOCX');
  }

  return {
    reply: normalizedReply,
    changed: normalizedReply !== originalReply
  };
}

function containsUnsafeCvInstruction(reply = '', vacancy = null) {
  const text = String(reply || '');
  if (!text || text.trim() === CV_UNSAFE_FALLBACK_REPLY) return false;
  if (isConfiguredInterviewDocumentReply(text, vacancy)) return false;
  return UNSAFE_CV_REPLY_PATTERNS.some((pattern) => pattern.test(text));
}

const UNSUPPORTED_VACANCY_FACT_REPLY = 'Sobre ese punto no tengo una condición registrada para confirmarla. Te comparto solo la información registrada de la vacante: {summary}. Si quieres, seguimos con tu proceso.';

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9#\s$.,:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectSupportedText(vacancy = {}) {
  const parts = [
    vacancy.conditions,
    vacancy.requirements,
    vacancy.requiredDocuments,
    vacancy.operationAddress,
    vacancy.interviewAddress,
    vacancy.roleDescription,
    vacancy.salary,
    vacancy.schedule,
    vacancy.benefits,
    vacancy.contractType,
    vacancy.operation?.address,
    vacancy.operation?.name,
    vacancy.operation?.city?.name,
    vacancy.city,
    vacancy.title,
    vacancy.role
  ];
  return normalizeText(parts.filter(Boolean).join(' '));
}

function getInterviewAddress(vacancy = {}) {
  return String(vacancy?.interviewAddress || vacancy?.interview?.address || '').trim();
}

function registeredVacancySummary(vacancy = {}) {
  const lines = [];
  const title = vacancy.title || vacancy.role;
  if (title) lines.push(`Vacante: ${title}`);
  const city = vacancy.operation?.city?.name || vacancy.city;
  if (city) lines.push(`Ciudad: ${city}`);
  if (vacancy.requirements) lines.push(`Requisitos: ${vacancy.requirements}`);
  if (vacancy.conditions) lines.push(`Condiciones: ${vacancy.conditions}`);
  if (vacancy.requiredDocuments) lines.push(`Documentos requeridos: ${vacancy.requiredDocuments}`);
  if (vacancy.operationAddress) lines.push(`Zona de operación: ${vacancy.operationAddress}`);
  return lines.join(' | ') || 'no tengo condiciones adicionales registradas para esta vacante';
}

const CLAIM_PATTERNS = [
  { key: 'prestaciones_de_ley', regex: /\b(?:todas\s+las\s+)?prestaciones(?:\s+de\s+ley)?\b/ },
  { key: 'contrato_directo', regex: /\bcontrato\s+directo\b/ },
  { key: 'contrato_indefinido', regex: /\bcontrato\s+indefinido\b/ },
  { key: 'contrato_fijo', regex: /\bcontrato\s+(?:a\s+termino\s+)?fijo\b/ },
  { key: 'obra_labor', regex: /\bobra\s+(?:o\s+)?labor\b|\bcontrato\s+por\s+obra\b/ },
  { key: 'vinculacion_inmediata', regex: /\bvinculaci(?:o|ó)n\s+inmediata\b|\bcontrataci(?:o|ó)n\s+inmediata\b/ },
  { key: 'pagos_quincenales', regex: /\bpagos?\s+quincenales?\b|\bpagan?\s+quincenal\b/ },
  { key: 'frecuencia_pago', regex: /\bpago\s+(?:semanal|mensual|diario)\b|\bpagan?\s+(?:semanal|mensual|diario)\b/ },
  { key: 'salario_especifico', regex: /\b(?:salario|sueldo)\b\s*(?:de|es|:)?\s*\$?\s*\d[\d.,]*/ },
  { key: 'bonos', regex: /\bbonos?\b|\bbonificaci(?:o|ó)n(?:es)?\b/ },
  { key: 'auxilio_transporte', regex: /\bauxilio\s+de\s+transporte\b/ },
  { key: 'seguridad_social', regex: /\bseguridad\s+social\b|\b(?:eps|arl|afp)\b|\bcaja\s+de\s+compensaci(?:o|ó)n\b/ },
  { key: 'turnos', regex: /\bturnos?\s+(?:rotativos?|fijos?|nocturnos?|diurnos?)\b|\bhorario\s+(?:rotativo|fijo|nocturno|diurno)\b/ },
  { key: 'horario_especifico', regex: /\b(?:horario|turno)\b\s*(?:de|es|:)\s*(?:de\s+)?(?:\d{1,2}|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|diurno|nocturno)/ },
  { key: 'horas_extra', regex: /\bhoras?\s+extra\b|\btiempo\s+extra\b/ }
];

function claimIsSupported(claim, supportedText) {
  const aliases = {
    prestaciones_de_ley: ['prestaciones de ley', 'prestaciones'],
    contrato_directo: ['contrato directo'],
    contrato_indefinido: ['contrato indefinido'],
    contrato_fijo: ['contrato fijo', 'termino fijo', 'término fijo'],
    obra_labor: ['obra labor', 'obra o labor'],
    vinculacion_inmediata: ['vinculacion inmediata', 'contratacion inmediata'],
    pagos_quincenales: ['pagos quincenales', 'pago quincenal', 'quincenal'],
    frecuencia_pago: ['pago semanal', 'pago mensual', 'pago diario', 'semanal', 'mensual', 'diario'],
    bonos: ['bono', 'bonos', 'bonificacion'],
    auxilio_transporte: ['auxilio de transporte'],
    seguridad_social: ['seguridad social', 'eps', 'arl', 'afp', 'caja de compensacion'],
    turnos: ['turnos rotativos', 'turnos fijos', 'turnos nocturnos', 'turnos diurnos', 'horario'],
    horario_especifico: ['horario', 'turno', 'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 'viernes', 'sabado', 'sábado', 'domingo'],
    horas_extra: ['horas extra', 'tiempo extra']
  };
  if (claim === 'salario_especifico') return /\b(?:salario|sueldo)\b\s*(?:de|es|:)?\s*\$?\s*\d[\d.,]*/.test(supportedText);
  return (aliases[claim] || [claim]).some((alias) => supportedText.includes(normalizeText(alias)));
}

function extractAddressClaims(reply = '') {
  const text = String(reply || '');
  const matches = text.match(/\b(?:calle|cl|carrera|cra|kr|avenida|av|autopista|diagonal|transversal|tv|km|kilometro|kilómetro)\s+\d{1,3}[^\n.]{0,80}/gi) || [];
  return matches.map((match) => match.trim());
}

export function isManualAuthorizedSource(source = '') {
  const normalized = String(source || '').trim();
  if (!normalized) return false;
  if (normalized === 'MANUAL_AUTHORIZED' || normalized === 'manual_authorized') return true;
  return normalized === 'admin_outbound' || normalized.toLowerCase().startsWith('admin_manual_');
}

export function sanitizeOutboundReply({ reply, vacancy = null, candidate = null, currentStep = null, source = 'unknown' } = {}) {
  const originalReply = String(reply || '').trim();
  if (!originalReply) {
    return { reply: originalReply, blocked: false, blockedClaims: [], reason: null };
  }

  if (isManualAuthorizedSource(source)) {
    return { reply: originalReply, blocked: false, blockedClaims: [], reason: null, source };
  }

  const cvFormatNormalization = normalizeCvUploadFormatInstruction(originalReply, vacancy);
  const normalizedCvReply = cvFormatNormalization.reply;

  if (containsUnsafeCvInstruction(normalizedCvReply, vacancy)) {
    return {
      reply: CV_UNSAFE_FALLBACK_REPLY,
      blocked: true,
      blockedClaims: ['unsafe_cv_instruction'],
      reason: 'unsafe_cv_instruction'
    };
  }

  const supportedText = collectSupportedText(vacancy || {});
  const normalizedReply = normalizeText(normalizedCvReply);
  const blockedClaims = [];

  for (const claim of CLAIM_PATTERNS) {
    if (claim.regex.test(normalizedReply) && !claimIsSupported(claim.key, supportedText)) {
      blockedClaims.push(claim.key);
    }
  }

  const registeredAddress = normalizeText(getInterviewAddress(vacancy || {}));
  const canRevealInterviewAddress = currentStep === 'SCHEDULED';
  for (const addressClaim of extractAddressClaims(normalizedCvReply)) {
    const normalizedAddress = normalizeText(addressClaim);
    if (normalizedAddress && (!registeredAddress || !registeredAddress.includes(normalizedAddress))) {
      blockedClaims.push(`unregistered_interview_address:${addressClaim}`);
    } else if (normalizedAddress && registeredAddress && registeredAddress.includes(normalizedAddress) && !canRevealInterviewAddress) {
      blockedClaims.push(`interview_address_before_confirmed_booking:${addressClaim}`);
    }
  }

  const uniqueBlockedClaims = [...new Set(blockedClaims)];
  if (!uniqueBlockedClaims.length) {
    return {
      reply: normalizedCvReply,
      blocked: false,
      blockedClaims: [],
      reason: null,
      normalizations: cvFormatNormalization.changed ? ['cv_upload_format'] : []
    };
  }

  return {
    reply: UNSUPPORTED_VACANCY_FACT_REPLY.replace('{summary}', registeredVacancySummary(vacancy || {})),
    blocked: true,
    blockedClaims: uniqueBlockedClaims,
    reason: 'unsupported_sensitive_vacancy_claim',
    source,
    currentStep,
    candidateId: candidate?.id || null
  };
}

export { CV_UNSAFE_FALLBACK_REPLY };

export function buildSafeFallbackReply() {
  return 'Te leí. Para continuar, confírmame el dato puntual o espera a que el equipo revise tu caso.';
}
