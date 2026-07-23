import fs from 'node:fs';
import crypto from 'node:crypto';

const filePath = 'src/routes/webhook.js';
const expectedBlobSha = 'b81fafea6ebdd7edf0390da74052fb4f5a10c004';
let source = fs.readFileSync(filePath, 'utf8');

function gitBlobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex');
}

function replaceExact(oldText, newText, expectedCount = 1) {
  const count = source.split(oldText).length - 1;
  if (count !== expectedCount) {
    throw new Error(`Reemplazo inseguro: se esperaban ${expectedCount} ocurrencias y se encontraron ${count}`);
  }
  source = source.replaceAll(oldText, newText);
}

if (gitBlobSha(source) !== expectedBlobSha) {
  throw new Error(`webhook.js cambió antes de aplicar #642. SHA observado: ${gitBlobSha(source)}`);
}

replaceExact(
  "import { buildCandidateDataCollectionMessage, getCandidateReadiness, getFieldLabel as getReadinessFieldLabel, getMissingFieldLabels, getRequiredCandidateFieldKeys, hasValidCv } from '../services/readinessGuard.js';",
  "import { buildCandidateDataCollectionMessage, evaluateCandidateEligibility, getCandidateReadiness, getFieldLabel as getReadinessFieldLabel, getMissingFieldLabels, getRequiredCandidateFieldKeys, hasValidCv } from '../services/readinessGuard.js';"
);

replaceExact(
`function shouldRejectByRequirements(text, parsed = {}, evidenceByField = {}) {
  const n = normalizeComparableText(text);
  if (parsed.age && (parsed.age < 18 || parsed.age > 50) && hasStrongAgeEvidence(text, parsed, evidenceByField)) {
    return { reject: true, reason: 'Edad fuera del rango permitido', details: \`Edad detectada: \${parsed.age}\` };
  }
  if (explicitlyLacksValidDocument(n)) return { reject: true, reason: 'Documento no vigente', details: 'El candidato indicó no tener documento vigente.' };
  if (mentionsForeigner(text) && hasValidForeignDocumentMention(text, parsed)) return { reject: false };
  return { reject: false };
}`,
`function shouldRejectByRequirements(text, parsed = {}, evidenceByField = {}, vacancy = null) {
  const n = normalizeComparableText(text);
  if (hasStrongAgeEvidence(text, parsed, evidenceByField)) {
    const ageFailure = evaluateCandidateEligibility({ age: parsed.age }, vacancy)
      .failures.find((failure) => failure.field === 'age');
    if (ageFailure) {
      return {
        reject: true,
        reason: ageFailure.message,
        details: ageFailure.details,
        code: ageFailure.code,
        candidateAge: ageFailure.candidateAge,
        minAge: ageFailure.minAge,
        maxAge: ageFailure.maxAge
      };
    }
  }
  if (explicitlyLacksValidDocument(n)) return { reject: true, reason: 'Documento no vigente', details: 'El candidato indicó no tener documento vigente.' };
  if (mentionsForeigner(text) && hasValidForeignDocumentMention(text, parsed)) return { reject: false };
  return { reject: false };
}`
);

replaceExact(
  'shouldRejectByRequirements(cleanText, normalizedData, evidenceByField);',
  'shouldRejectByRequirements(cleanText, normalizedData, evidenceByField, vacancyState);'
);

replaceExact(
  'shouldRejectByRequirements(cleanText, normalizedData)',
  'shouldRejectByRequirements(cleanText, normalizedData, evidenceByField, currentVacancy)',
  3
);

replaceExact(
`async function rejectCandidate(prisma, candidateId, from, rejection = {}) {
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      status: CandidateStatus.RECHAZADO,
      currentStep: ConversationStep.DONE,
      rejectionReason: rejection.reason || 'No cumple requisitos',
      rejectionDetails: rejection.details || null,
      reminderScheduledFor: null,
      reminderState: 'SKIPPED'
    }
  });`,
`async function rejectCandidate(prisma, candidateId, from, rejection = {}) {
  const rejectionDetails = [
    rejection.details || null,
    rejection.code ? \`Código: \${rejection.code}.\` : null
  ].filter(Boolean).join(' ');
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      status: CandidateStatus.RECHAZADO,
      currentStep: ConversationStep.DONE,
      rejectionReason: rejection.reason || 'No cumple requisitos',
      rejectionDetails: rejectionDetails || null,
      reminderScheduledFor: null,
      reminderState: 'SKIPPED'
    }
  });`
);

fs.writeFileSync(filePath, source, 'utf8');
console.log(`Patch #642 aplicado. Nuevo blob SHA: ${gitBlobSha(source)}`);
