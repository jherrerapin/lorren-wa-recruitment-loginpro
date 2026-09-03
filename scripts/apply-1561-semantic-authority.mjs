import fs from 'node:fs';

const understandingPath = 'src/services/conversationUnderstanding.js';
const sanitizerPath = 'src/services/fieldSanitizer.js';

let understanding = fs.readFileSync(understandingPath, 'utf8');
const unsafeFallback = `  let uniqueSegments = [...new Set(acceptedSegments)];
  if (!uniqueSegments.length) {
    const contextualTail = segments.at(-1) || '';
    const tailParsed = normalizeCandidateFields(parseNaturalData(contextualTail));
    const tailHasOtherCandidateData = Object.entries(tailParsed).some(([field, value]) => (
      hasValue(value)
      && !['experienceInfo', 'experienceTime', 'experienceSummary'].includes(field)
    ));
    const tailLooksLikeName = isHighConfidenceLocalField('fullName', contextualTail);
    const tailLooksTechnical = /^\\s*\\[[A-Z0-9_:-]+\\]\\s*$/.test(contextualTail);
    const tailLooksLikeQuestion = /[¿?]/.test(contextualTail);

    if (
      contextualTail
      && !tailHasOtherCandidateData
      && !tailLooksLikeName
      && !tailLooksTechnical
      && !tailLooksLikeQuestion
    ) {
      uniqueSegments = [contextualTail];
    }
  }
  if (!uniqueSegments.length) return { fields: {}, evidence: {} };`;
const safeFallback = `  const uniqueSegments = [...new Set(acceptedSegments)];
  if (!uniqueSegments.length) return { fields: {}, evidence: {} };`;

if (!understanding.includes(unsafeFallback)) {
  throw new Error('No se encontró el fallback heurístico esperado en conversationUnderstanding.js');
}
understanding = understanding.replace(unsafeFallback, safeFallback);
fs.writeFileSync(understandingPath, understanding);

let sanitizer = fs.readFileSync(sanitizerPath, 'utf8');
const before = `  return /\\b(?:experien|trabaj|labor|coordin|operaci|logistic|despach|empaqu|supervis|lider)\\w*\\b/.test(normalized)
    || /\\b(?:cargo|oficio|turnos?|personal|bodega)\\b/.test(normalized);`;
const after = `  return /\\b(?:experien|trabaj|labor|coordin|operaci|logistic|despach|empaqu|supervis|lider|carg|descarg)\\w*\\b/.test(normalized)
    || /\\b(?:cargo|oficio|turnos?|personal|bodega)\\b/.test(normalized);`;
if (!sanitizer.includes(before)) {
  throw new Error('No se encontró la autoridad de evidencia de experiencia esperada en fieldSanitizer.js');
}
sanitizer = sanitizer.replace(before, after);
fs.writeFileSync(sanitizerPath, sanitizer);
