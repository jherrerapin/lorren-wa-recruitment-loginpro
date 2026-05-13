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
  if (vacancy.interviewAddress) lines.push(`Dirección de entrevista registrada: ${vacancy.interviewAddress}`);
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

export function sanitizeOutboundReply({ reply, vacancy = null, candidate = null, currentStep = null, source = 'unknown' } = {}) {
  const originalReply = String(reply || '').trim();
  if (!originalReply) {
    return { reply: originalReply, blocked: false, blockedClaims: [], reason: null };
  }

  const supportedText = collectSupportedText(vacancy || {});
  const normalizedReply = normalizeText(originalReply);
  const blockedClaims = [];

  for (const claim of CLAIM_PATTERNS) {
    if (claim.regex.test(normalizedReply) && !claimIsSupported(claim.key, supportedText)) {
      blockedClaims.push(claim.key);
    }
  }

  const registeredAddress = normalizeText(getInterviewAddress(vacancy || {}));
  for (const addressClaim of extractAddressClaims(originalReply)) {
    const normalizedAddress = normalizeText(addressClaim);
    if (normalizedAddress && (!registeredAddress || !registeredAddress.includes(normalizedAddress))) {
      blockedClaims.push(`unregistered_interview_address:${addressClaim}`);
    }
  }

  const uniqueBlockedClaims = [...new Set(blockedClaims)];
  if (!uniqueBlockedClaims.length) {
    return { reply: originalReply, blocked: false, blockedClaims: [], reason: null };
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

export function buildSafeFallbackReply() {
  return 'Te leí. Para continuar, confírmame el dato puntual o espera a que el equipo revise tu caso.';
}
