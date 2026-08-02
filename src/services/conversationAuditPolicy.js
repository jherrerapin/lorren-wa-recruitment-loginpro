import { createHash } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_GAP_MS = 24 * 60 * 60 * 1000;
const RESPONSE_STALE_MS = 10 * 60 * 1000;
const SEVERITY_WEIGHT = { critical: 20, high: 10, medium: 5, low: 2 };
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

const ISSUE_CATALOG = {
  BOT_OVER_HUMAN: ['El bot respondió encima de una intervención humana', 'critical'],
  SCHEDULED_WITHOUT_BOOKING: ['Estado agendado sin reserva activa', 'critical'],
  PREMATURE_DONE: ['Proceso cerrado antes de completar la agenda', 'high'],
  CV_RECEIVED_BUT_STUCK: ['Hoja de vida recibida pero el flujo sigue solicitándola', 'high'],
  REJECTED_WITH_OPEN_STEP: ['Candidato rechazado con flujo todavía abierto', 'high'],
  PAUSED_WITHOUT_REASON: ['Bot pausado sin motivo trazable', 'high'],
  DELIVERY_FAILURE: ['Mensaje saliente con entrega fallida o incierta', 'high'],
  UNANSWERED_INBOUND: ['Mensaje del candidato sin respuesta posterior', 'high'],
  QUESTION_NOT_ANSWERED: ['Pregunta del candidato no atendida antes de retomar el formulario', 'high'],
  UNSUPPORTED_SENSITIVE_CLAIM: ['Respuesta con información sensible no respaldada por la vacante', 'high'],
  REPEATED_DATA_REQUEST: ['El bot volvió a pedir un dato ya entregado', 'medium'],
  DUPLICATE_REPLY: ['Respuesta del bot repetida o casi idéntica', 'medium'],
  LOOP_PATTERN: ['Patrón de respuesta repetido tres o más veces', 'high'],
  TECHNICAL_LEAK: ['Respuesta con lenguaje técnico o interno', 'high'],
  EXCESSIVE_LENGTH: ['Respuesta más extensa que el contrato conversacional', 'medium'],
  MARKDOWN_OR_LIST: ['Respuesta con lista o formato impropio de WhatsApp', 'low'],
  REPEATED_GREETING: ['Saludo repetido dentro de la misma conversación', 'low'],
  UNNECESSARY_IDENTITY_DISCLOSURE: ['El bot se identificó como IA sin que se lo preguntaran', 'medium'],
  LOOP_GUARD_USED: ['El sistema tuvo que sustituir una respuesta repetitiva', 'low'],
  MANUAL_REVIEW_PENDING: ['Conversación pendiente de intervención humana', 'medium']
};

const TOPIC_PATTERNS = {
  salary: /\b(salario|sueldo|pago|remuneraci[oó]n|cu[aá]nto pagan|valor del turno|auxilio)\b|\$\s?\d/i,
  schedule: /\b(horario|turno|jornada|entrada|salida|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|a\.?\s?m\.?|p\.?\s?m\.?)\b/i,
  location: /\b(d[oó]nde|direcci[oó]n|ubicaci[oó]n|queda en|zona de trabajo|lugar de trabajo)\b/i,
  requirements: /\b(requisito|experiencia|estudio|t[eé]cnico|tecn[oó]logo|edad|perfil)\b/i,
  documents: /\b(documento|c[eé]dula|antecedentes|certificado|hoja de vida impresa|papeles)\b/i,
  benefits: /\b(beneficio|ruta|alimentaci[oó]n|bono|prestaciones|contrato)\b/i,
  identity: /\b(quien eres|qui[eé]n eres|eres un bot|eres una ia|c[oó]mo te llamas|tu nombre)\b/i,
  availability: /\b(hay vacante|vacante disponible|siguen contratando|a[uú]n est[aá] disponible|est[aá] abierta)\b/i
};

const REQUEST_PATTERNS = {
  documentNumber: /\b(c[eé]dula|n[uú]mero de documento|documento de identidad|cc|ppt)\b/i,
  age: /\b(edad|cu[aá]ntos a[nñ]os tienes|a[nñ]os de edad)\b/i,
  residence: /\b(localidad|barrio|d[oó]nde vives|residencia|zona donde vives|municipio)\b/i,
  transport: /\b(medio de transporte|c[oó]mo te transportas|tienes moto|transporte)\b/i,
  experience: /\b(tienes experiencia|tiempo de experiencia|cu[aá]ntos meses|cu[aá]ntos a[nñ]os de experiencia)\b/i,
  cv: /\b(hoja de vida|hv|pdf|docx|archivo)\b/i
};

const ABSENCE_LANGUAGE = /\b(no (?:tengo|est[aá]|cuento|aparece)|sin informaci[oó]n|debo confirmar|voy a validar|no est[aá] registrado)\b/i;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function resolveConversationAuditRange(options = {}) {
  const now = toDate(options.now) || new Date();
  const days = clampInt(options.days, 1, 90, 15);
  const end = toDate(options.end) || now;
  const start = toDate(options.start) || new Date(end.getTime() - (days * DAY_MS));
  if (start >= end) throw new Error('conversation_audit_range_invalid');
  return { days, start, end };
}

export function isAuditableMessage(message = {}) {
  const payload = asObject(message.rawPayload);
  return payload.target !== 'admin_supervisor'
    && payload.visibility !== 'internal'
    && payload.neverSendToCandidate !== true
    && payload.source !== 'admin_manual_review_request';
}

function sourceText(payload = {}) {
  return String(payload.source || payload.sourceCategory || '').trim().toLowerCase();
}

export function classifyConversationActor(message = {}) {
  if (String(message.direction || '').toUpperCase() === 'INBOUND') return 'candidate';
  const payload = asObject(message.rawPayload);
  const source = sourceText(payload);
  const actor = String(payload.actor || payload.actorRole || '').trim().toUpperCase();
  if (payload.manualIntervention === true
    || payload.sourceCategory === 'MANUAL_AUTHORIZED'
    || ['RECRUITER', 'ADMIN'].includes(actor)
    || source.startsWith('admin_')
    || source.startsWith('manual_')) return 'human';
  if (actor === 'REMINDER' || source.startsWith('reminder')) return 'reminder';
  if (actor === 'SYSTEM' || source.startsWith('system')) return 'system';
  return 'bot';
}

function hashLabel(value, prefix) {
  const digest = createHash('sha256').update(String(value || '')).digest('hex').slice(0, 10);
  return `${prefix}-${digest}`;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactConversationText(value, candidate = {}) {
  let text = String(value || '');
  const sensitiveValues = [candidate.fullName, candidate.phone, candidate.documentNumber]
    .filter((item) => typeof item === 'string' && item.trim().length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const sensitive of sensitiveValues) {
    text = text.replace(new RegExp(escapeRegExp(sensitive.trim()), 'gi'), '[DATO_PROTEGIDO]');
  }
  for (const part of String(candidate.fullName || '').split(/\s+/).filter((item) => item.length >= 4)) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(part)}\\b`, 'gi'), '[NOMBRE]');
  }
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/(?:\+?57\s*)?(?:3\d{2})[\s.-]?\d{3}[\s.-]?\d{4}/g, '[TEL]')
    .replace(/\b\d{6,12}\b/g, '[NUMERO]');
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value) {
  return new Set(normalizeText(value).split(' ').filter((token) => token.length > 2));
}

function textSimilarity(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size < 4 || right.size < 4) return normalizeText(a) === normalizeText(b) ? 1 : 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.max(left.size, right.size);
}

function evidenceFromMessage(message, candidate) {
  return {
    messageId: hashLabel(message.id, 'msg'),
    at: toDate(message.createdAt)?.toISOString() || null,
    excerpt: redactConversationText(String(message.body || '').slice(0, 280), candidate)
  };
}

function buildIssue(code, detail, message, candidate, extra = {}) {
  const [title, severity] = ISSUE_CATALOG[code] || [code, 'medium'];
  return {
    code,
    severity,
    title,
    detail,
    evidence: message ? [evidenceFromMessage(message, candidate)] : [],
    ...extra
  };
}

function addIssue(issues, issue) {
  const key = `${issue.code}|${issue.evidence?.[0]?.messageId || issue.detail}`;
  if (!issues.some((item) => `${item.code}|${item.evidence?.[0]?.messageId || item.detail}` === key)) {
    issues.push(issue);
  }
}

function startsWithGreeting(body) {
  return /^\s*(hola|buenos d[ií]as|buenas tardes|buenas noches|mucho gusto)\b/i.test(body || '');
}

function sentenceCount(body) {
  return String(body || '').split(/[.!?]+(?:\s|$)/).map((part) => part.trim()).filter(Boolean).length;
}

function hasMarkdownList(body) {
  return /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+/m.test(body || '');
}

function hasTechnicalLeak(body) {
  return /\b(openai|gpt-?\d|modelo usado|prompt|json|backend|currentstep|missing_[a-z_]+|internal_server_error|lote|reintento|token(?:es)?|c[oó]digo interno|raz[oó]n t[eé]cnica)\b/i.test(body || '');
}

function asksIdentity(body) {
  return TOPIC_PATTERNS.identity.test(body || '');
}

function mentionsIdentity(body) {
  return /\b(soy (?:un )?bot|soy una ia|inteligencia artificial|asistente virtual)\b/i.test(body || '');
}

function detectQuestionTopic(body) {
  if (!/[?¿]/.test(body || '') && !/\b(cu[aá]l|cu[aá]nto|d[oó]nde|cu[aá]ndo|qu[eé]|c[oó]mo)\b/i.test(body || '')) return null;
  return Object.entries(TOPIC_PATTERNS).find(([, pattern]) => pattern.test(body || ''))?.[0] || 'general';
}

function responseAddressesTopic(body, topic) {
  if (!topic || topic === 'general') return String(body || '').trim().length >= 20;
  return TOPIC_PATTERNS[topic]?.test(body || '') || ABSENCE_LANGUAGE.test(body || '');
}

function isDataRequest(body) {
  return Object.values(REQUEST_PATTERNS).some((pattern) => pattern.test(body || ''))
    && /\b(comp[aá]rteme|ind[ií]came|conf[ií]rmame|necesito|env[ií]a|cu[eé]ntame|por favor)\b/i.test(body || '');
}

function inboundEvidenceFields(message) {
  const body = String(message.body || '');
  const fields = new Set();
  if (/\b(?:cc|c\.?c\.?|ppt|c[eé]dula|documento)\b.{0,20}\d{6,12}|\b\d{6,12}\b/i.test(body)) fields.add('documentNumber');
  if (/\b(?:tengo|edad|soy de)\s+\d{2}\s*a[nñ]os|\b\d{2}\s*a[nñ]os\b/i.test(body)) fields.add('age');
  if (/\b(vivo en|resido en|mi localidad es|mi barrio es|soy de|municipio)\b/i.test(body)) fields.add('residence');
  if (/\b(moto|carro|autom[oó]vil|bicicleta|cicla|bus|transporte p[uú]blico|caminando|a pie)\b/i.test(body)) fields.add('transport');
  if (/\b(experiencia|trabaj[eé]|meses|a[nñ]os trabajando|sin experiencia)\b/i.test(body)) fields.add('experience');
  if (String(message.messageType || '').toUpperCase() === 'DOCUMENT' || /\b(adjunto|env[ií]o|mand[eé]).{0,20}(hoja de vida|hv|pdf|docx)\b/i.test(body)) fields.add('cv');
  return fields;
}

function requestedFields(body) {
  const fields = [];
  for (const [field, pattern] of Object.entries(REQUEST_PATTERNS)) {
    if (pattern.test(body || '')) fields.push(field);
  }
  return fields;
}

function vacancyFacts(candidate = {}) {
  const vacancy = candidate.vacancy || {};
  return {
    all: [vacancy.title, vacancy.roleDescription, vacancy.requirements, vacancy.conditions, vacancy.operationAddress, vacancy.interviewAddress, vacancy.requiredDocuments].filter(Boolean).join('\n'),
    salary: [vacancy.conditions, vacancy.roleDescription].filter(Boolean).join('\n'),
    schedule: [vacancy.conditions, vacancy.roleDescription].filter(Boolean).join('\n'),
    location: [vacancy.operationAddress, vacancy.interviewAddress, vacancy.city].filter(Boolean).join('\n'),
    requirements: [vacancy.requirements, vacancy.roleDescription].filter(Boolean).join('\n'),
    documents: [vacancy.requiredDocuments].filter(Boolean).join('\n'),
    benefits: [vacancy.conditions, vacancy.roleDescription].filter(Boolean).join('\n'),
    availability: [vacancy.acceptingApplications === true ? 'vacante abierta disponible' : '', vacancy.acceptingApplications === false ? 'vacante pausada no disponible' : ''].join(' ')
  };
}

function unsupportedClaim(body, candidate) {
  if (!body || ABSENCE_LANGUAGE.test(body)) return null;
  const facts = vacancyFacts(candidate);
  for (const topic of ['salary', 'schedule', 'location', 'requirements', 'documents', 'benefits', 'availability']) {
    if (!TOPIC_PATTERNS[topic].test(body)) continue;
    const factText = normalizeText(facts[topic]);
    if (!factText) return topic;
    const claimTokens = [...tokenSet(body)].filter((token) => token.length >= 4);
    const factTokens = tokenSet(factText);
    const overlap = claimTokens.filter((token) => factTokens.has(token)).length;
    if (overlap === 0 && topic !== 'location') return topic;
  }
  return null;
}

function detectLoopGuard(payload = {}) {
  const object = asObject(payload);
  if (object.loopGuardApplied === true) return true;
  return Object.values(object).some((value) => asObject(value).loopGuardApplied === true);
}

function activeBookingCount(candidate = {}) {
  return Array.isArray(candidate.interviewBookings) ? candidate.interviewBookings.length : 0;
}

function candidateHasCv(candidate = {}) {
  return Boolean(candidate.cvStorageKey || candidate.cvOriginalName || candidate.cvData);
}

function conversationRisk(issues) {
  const penalty = issues.reduce((sum, issue) => sum + (SEVERITY_WEIGHT[issue.severity] || 0), 0);
  const score = Math.max(0, 100 - penalty);
  const critical = issues.filter((issue) => issue.severity === 'critical').length;
  const high = issues.filter((issue) => issue.severity === 'high').length;
  const medium = issues.filter((issue) => issue.severity === 'medium').length;
  const label = critical || high ? 'RIESGO_ALTO' : (medium >= 2 || score < 90 ? 'REVISAR' : 'ADECUADA');
  return { score, label, critical, high, medium, low: issues.filter((issue) => issue.severity === 'low').length };
}

function compareConversationRisk(a, b) {
  const labelRank = { RIESGO_ALTO: 3, REVISAR: 2, ADECUADA: 1 };
  return (labelRank[b.risk.label] - labelRank[a.risk.label])
    || (a.risk.score - b.risk.score)
    || (new Date(b.startedAt) - new Date(a.startedAt));
}

export {
  SESSION_GAP_MS, RESPONSE_STALE_MS, SEVERITY_WEIGHT, SEVERITY_RANK,
  asObject, toDate, sourceText, hashLabel, normalizeText, textSimilarity,
  buildIssue, addIssue, startsWithGreeting, sentenceCount, hasMarkdownList,
  hasTechnicalLeak, asksIdentity, mentionsIdentity, detectQuestionTopic,
  responseAddressesTopic, isDataRequest, inboundEvidenceFields, requestedFields,
  unsupportedClaim, detectLoopGuard, activeBookingCount, candidateHasCv,
  conversationRisk, compareConversationRisk
};
