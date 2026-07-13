import { MessageDirection, MessageType } from '@prisma/client';
import {
  alignCandidateLocationFields,
  isHighConfidenceLocalField,
  normalizeCandidateFields,
  parseNaturalData
} from './candidateData.js';

const CAPTURABLE_FIELDS = new Set([
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
]);

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function mergeHighConfidenceFields(target, text, vacancy) {
  const parsed = parseNaturalData(text || '');
  let normalized = normalizeCandidateFields(parsed);
  normalized = alignCandidateLocationFields(normalized, vacancy, { clearAlternate: false });

  for (const [field, value] of Object.entries(normalized)) {
    if (!CAPTURABLE_FIELDS.has(field) || !hasValue(value)) continue;
    if (!isHighConfidenceLocalField(field, value)) continue;
    target[field] = value;
  }
}

export async function captureConsentedProfileData({
  prisma,
  candidate,
  vacancy = null,
  currentText = '',
  maxMessages = 12
} = {}) {
  if (!prisma?.candidate?.update || !candidate?.id) {
    return { candidate, capturedFields: [], reason: 'candidate_not_ready' };
  }

  const recentMessages = prisma?.message?.findMany
    ? await prisma.message.findMany({
      where: {
        candidateId: candidate.id,
        direction: MessageDirection.INBOUND,
        messageType: MessageType.TEXT
      },
      orderBy: { createdAt: 'desc' },
      take: maxMessages,
      select: { body: true }
    })
    : [];

  const texts = [...recentMessages]
    .reverse()
    .map((message) => message?.body || '')
    .filter(Boolean);
  const normalizedCurrent = String(currentText || '').trim();
  if (normalizedCurrent && texts.at(-1) !== normalizedCurrent) texts.push(normalizedCurrent);

  const merged = {};
  for (const text of texts) mergeHighConfidenceFields(merged, text, vacancy);

  const normalizedMerged = normalizeCandidateFields(merged);
  const update = {};
  for (const [field, value] of Object.entries(normalizedMerged)) {
    if (!CAPTURABLE_FIELDS.has(field) || !hasValue(value)) continue;
    if (!hasValue(candidate[field])) update[field] = value;
  }

  if (!Object.keys(update).length) {
    return { candidate, capturedFields: [], reason: 'no_new_profile_data' };
  }

  const updatedCandidate = await prisma.candidate.update({
    where: { id: candidate.id },
    data: update
  });

  return {
    candidate: updatedCandidate,
    capturedFields: Object.keys(update),
    reason: 'profile_data_captured_after_consent'
  };
}
