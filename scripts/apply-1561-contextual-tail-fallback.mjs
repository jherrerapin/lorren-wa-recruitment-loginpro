import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/services/conversationUnderstanding.js';
const source = readFileSync(path, 'utf8');

const before = `  const uniqueSegments = [...new Set(acceptedSegments)];
  if (!uniqueSegments.length) return { fields: {}, evidence: {} };

  const experienceSummary = uniqueSegments.join('; ');`;

const after = `  let uniqueSegments = [...new Set(acceptedSegments)];
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
  if (!uniqueSegments.length) return { fields: {}, evidence: {} };

  const experienceSummary = uniqueSegments.join('; ');`;

if (!source.includes(before)) throw new Error('contextual_experience_segment_block_not_found');
const patched = source.replace(before, after);
if (patched === source) throw new Error('conversation_understanding_not_changed');
writeFileSync(path, patched);
