import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/services/conversationUnderstanding.js';
const source = readFileSync(path, 'utf8');

const before = `function buildContextualExperienceSummaryCandidate(input = '', context = {}) {
  const raw = String(input || '').replace(/\\s+/g, ' ').trim();
  if (!raw) return { fields: {}, evidence: {} };

  const evidence = {
    experienceSummary: {
      snippet: raw.slice(0, 120),
      confidence: 0.95,
      source: 'contextual_answer'
    }
  };
  const probe = sanitizeCandidateFieldsForConversation({
    fields: { experienceSummary: raw },
    evidence,
    text: input,
    context,
    turnType: null
  });
  const experienceSummary = probe.fields.experienceSummary;
  if (!hasValue(experienceSummary)) return { fields: {}, evidence: {} };

  return {
    fields: { experienceSummary },
    evidence
  };
}`;

const after = `function buildContextualExperienceSummaryCandidate(input = '', context = {}) {
  const segments = String(input || '')
    .split(/\\n+/)
    .map((segment) => segment.replace(/\\s+/g, ' ').trim())
    .filter(Boolean);
  if (!segments.length) return { fields: {}, evidence: {} };

  const acceptedSegments = [];
  for (const segment of segments) {
    const segmentEvidence = {
      experienceSummary: {
        snippet: segment.slice(0, 120),
        confidence: 0.95,
        source: 'contextual_answer'
      }
    };
    const probe = sanitizeCandidateFieldsForConversation({
      fields: { experienceSummary: segment },
      evidence: segmentEvidence,
      text: segment,
      context,
      turnType: null
    });
    if (hasValue(probe.fields.experienceSummary)) {
      acceptedSegments.push(probe.fields.experienceSummary);
    }
  }

  const uniqueSegments = [...new Set(acceptedSegments)];
  if (!uniqueSegments.length) return { fields: {}, evidence: {} };

  const experienceSummary = uniqueSegments.join('; ');
  return {
    fields: { experienceSummary },
    evidence: {
      experienceSummary: {
        snippet: experienceSummary.slice(0, 120),
        confidence: 0.95,
        source: 'contextual_answer'
      }
    }
  };
}`;

if (!source.includes(before)) throw new Error('target_function_not_found');
const patched = source.replace(before, after);
if (patched === source) throw new Error('conversation_understanding_not_changed');
writeFileSync(path, patched);
