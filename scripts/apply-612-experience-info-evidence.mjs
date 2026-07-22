import { readFileSync, writeFileSync } from 'node:fs';

const read = (file) => readFileSync(file, 'utf8');
const write = (file, content) => writeFileSync(file, content, 'utf8');

function replaceOnce(file, source, target, label) {
  const content = read(file);
  if (content.includes(target)) return;
  const count = content.split(source).length - 1;
  if (count !== 1) throw new Error(`${label}: se esperaba una sola ancla y se encontraron ${count}`);
  write(file, content.replace(source, target));
}

const sanitizerFile = 'src/services/fieldSanitizer.js';

replaceOnce(
  sanitizerFile,
  `  if (field === 'gender') {
    return pending.some((item) => /\\b(genero|sexo|mujer|hombre)\\b/.test(item));
  }

  return false;`,
  `  if (field === 'gender') {
    return pending.some((item) => /\\b(genero|sexo|mujer|hombre)\\b/.test(item));
  }

  if (field === 'experienceInfo' || field === 'experienceTime') {
    return pending.some((item) => /\\b(experiencia|tiempo de experiencia|trabajado|laborado)\\b/.test(item));
  }

  return false;`,
  'fieldSanitizer: contexto pendiente de experiencia'
);

{
  let source = read(sanitizerFile);
  const marker = 'function isStringCandidateValue';
  if (!source.includes('function sanitizeExperienceInfo(')) {
    const index = source.indexOf(marker);
    if (index < 0) throw new Error('fieldSanitizer: no se encontró marcador de helpers');
    const helper = `function hasExplicitNoExperienceEvidence(text = '') {
  const normalized = normalizeText(text);
  return /\\b(?:no tengo|no cuento con|sin|ninguna|cero)\\s+(?:experiencia|experiencia laboral)\\b/.test(normalized)
    || /\\b(?:nunca|no)\\s+he\\s+(?:trabajado|laborado)\\b/.test(normalized)
    || /\\bno\\s+he\\s+tenido\\s+experiencia\\b/.test(normalized);
}

function hasExplicitPositiveExperienceEvidence(text = '') {
  const normalized = normalizeText(text);
  if (!normalized || hasExplicitNoExperienceEvidence(normalized)) return false;

  const explicitExperience = /\\b(?:tengo|cuento con|poseo|acredito|he adquirido)\\s+(?:mas de\\s+|aproximadamente\\s+)?(?:\\d+\\s+(?:anos?|meses?|semanas?)\\s+de\\s+)?experiencia\\b/.test(normalized)
    || /\\b(?:he trabajado|he laborado|trabajo|laboro|me he desempenado)\\b/.test(normalized);
  const durationWithWorkContext = /\\b\\d+\\s+(?:anos?|meses?|semanas?)\\b/.test(normalized)
    && /\\b(?:experiencia|trabaj|labor|operacion|logistic|cargo|oficio|personal|coordin|turno|bodega|cargue|descargue)\\w*\\b/.test(normalized);
  const operationalResponsibility = /\\b(?:manejo|coordino|coordinacion|lidero|superviso)\\s+(?:de\\s+)?personal\\b/.test(normalized);

  return explicitExperience || durationWithWorkContext || operationalResponsibility;
}

function sanitizeExperienceInfo(value, evidence, text, context = {}, turnType = null) {
  const normalizedValue = normalizeText(value);
  const isPositive = ['si', 'sii', 'sip'].includes(normalizedValue);
  const isNegative = normalizedValue === 'no';
  if (!isPositive && !isNegative) return { ok: false, reason: 'invalid_experience_info_value' };

  const fieldContext = fieldWasPending('experienceInfo', context)
    || lastQuestionAskedForField('experienceInfo', context);
  const normalizedText = normalizeText(text);
  const shortAnswer = /^(?:si|sii|sip|no)$/.test(normalizedText);
  const explicitNo = hasExplicitNoExperienceEvidence(text);
  const explicitYes = hasExplicitPositiveExperienceEvidence(text);

  if (isPositive && explicitNo) return { ok: false, reason: 'experience_info_contradicts_negative_evidence' };
  if (isNegative && explicitYes) return { ok: false, reason: 'experience_info_contradicts_positive_evidence' };
  if (shortAnswer && fieldContext) return { ok: true, value: isPositive ? 'Sí' : 'No' };
  if (isPositive && explicitYes) return { ok: true, value: 'Sí' };
  if (isNegative && explicitNo) return { ok: true, value: 'No' };

  const usableEvidence = evidenceIsUsable('experienceInfo', evidence, { allowLocalParser: true });
  if (fieldContext && usableEvidence && !turnLooksLikeOnlyConversation(turnType)) {
    return { ok: true, value: isPositive ? 'Sí' : 'No' };
  }

  return { ok: false, reason: 'missing_experience_evidence' };
}

`;
    source = `${source.slice(0, index)}${helper}${source.slice(index)}`;
    write(sanitizerFile, source);
  }
}

replaceOnce(
  sanitizerFile,
  `function evaluateField(field, value, evidence, text, context, turnType) {
  if (!hasValue(value)) return { ok: false, reason: 'empty' };
  if (isStringCandidateValue(value) && looksLikeNonDataText(value)) return { ok: false, reason: 'non_data_text' };

  if (field === 'fullName') return sanitizeFullName(value, evidence, text, context, turnType);`,
  `function evaluateField(field, value, evidence, text, context, turnType) {
  if (!hasValue(value)) return { ok: false, reason: 'empty' };
  if (field === 'experienceInfo') return sanitizeExperienceInfo(value, evidence, text, context, turnType);
  if (isStringCandidateValue(value) && looksLikeNonDataText(value)) return { ok: false, reason: 'non_data_text' };

  if (field === 'fullName') return sanitizeFullName(value, evidence, text, context, turnType);`,
  'fieldSanitizer: precedencia de experienceInfo'
);

const webhookFile = 'src/routes/webhook.js';
replaceOnce(
  webhookFile,
  `  const extractionEvidence = aiResult?.extraction?.fieldEvidence || {};
  const sanitizerContext = { currentStep: candidate.currentStep };
  const understanding = await conversationUnderstanding(cleanText, { aiResult, context: sanitizerContext });`,
  `  const extractionEvidence = aiResult?.extraction?.fieldEvidence || {};
  const sanitizerContext = {
    currentStep: candidate.currentStep,
    pendingFields: getMissingFields(candidate, currentVacancy)
  };
  const understanding = await conversationUnderstanding(cleanText, { aiResult, context: sanitizerContext });`,
  'webhook: contexto pendiente para sanitizer'
);

console.log('Patch #612 applied.');
