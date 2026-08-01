from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'Missing expected block: {label}')
    return text.replace(old, new, 1)


service_path = Path('src/services/cvIntelligence.js')
service = service_path.read_text(encoding='utf-8')

service = replace_once(
    service,
    """function buildComparisonProfile(vacancy, desiredProfile, interpretedProfile) {
  return {
    vacancy: {
      title: vacancy.title || null,""",
    """function buildComparisonProfile(vacancy, desiredProfile, interpretedProfile) {
  return {
    vacancy: {
      id: vacancy.id || null,
      title: vacancy.title || null,""",
    'vacancy id in comparison profile'
)

service = replace_once(
    service,
    """function ensureMatchResults(response) {
  if (!Array.isArray(response?.results)) {
    throw new Error('match_batch_without_results');
  }
  return response;
}""",
    """function ensureMatchResults(response, candidateIds = []) {
  if (!completeMatchResponse(response, candidateIds)) {
    throw new Error('match_batch_invalid_results');
  }
  return response;
}""",
    'strict match response validation'
)

service = service.replace(
    """ensureMatchResults(
        await matchCandidateBatch(prisma, comparisonProfile, candidates, {
          ...options,
          usageVacancyId: batch[0]?.candidate?.vacancyId
        })
      )""",
    """ensureMatchResults(
        await matchCandidateBatch(prisma, comparisonProfile, candidates, {
          ...options,
          usageVacancyId: batch[0]?.candidate?.vacancyId
        }),
        candidateIds
      )""",
    1
)
service = service.replace(
    """ensureMatchResults(
        await matchCandidateBatch(prisma, comparisonProfile, missingCandidates, {
          ...options,
          usageVacancyId: batch[0]?.candidate?.vacancyId
        })
      )""",
    """ensureMatchResults(
        await matchCandidateBatch(prisma, comparisonProfile, missingCandidates, {
          ...options,
          usageVacancyId: batch[0]?.candidate?.vacancyId
        }),
        missingCandidates.map((candidate) => candidate.candidateId)
      )""",
    1
)
service = service.replace(
    """ensureMatchResults(
        await matchCandidateBatch(prisma, comparisonProfile, [candidate], {
          ...options,
          usageVacancyId: batch[0]?.candidate?.vacancyId
        })
      )""",
    """ensureMatchResults(
        await matchCandidateBatch(prisma, comparisonProfile, [candidate], {
          ...options,
          usageVacancyId: batch[0]?.candidate?.vacancyId
        }),
        [candidate.candidateId]
      )""",
    1
)

service = replace_once(
    service,
    """  const comparisonEntries = readable.map((item) => {
    const candidatePayload = candidateForMatching(item.candidate, item.analysis);
    return {
      item,
      candidatePayload,
      modelUsed,
      fingerprint: reviewCacheKey('candidate-match', {
        model: modelUsed,
        comparisonProfile,
        candidate: candidatePayload
      })
    };
  });""",
    """  const comparisonEntries = readable.map((item) => {
    const candidatePayload = candidateForMatching(item.candidate, item.analysis);
    const analysisEvidence = parseCvAnalysisEvidence(item.analysis);
    const analysisVersion = {
      id: item.analysis?.id || null,
      analysedAt: item.analysis?.analysedAt || null,
      documentReference: analysisEvidence?.documentReference
        || candidateCvReference(item.candidate)
    };
    return {
      item,
      candidatePayload,
      modelUsed,
      fingerprint: reviewCacheKey('candidate-match', {
        model: modelUsed,
        vacancyId: item.candidate.vacancyId || vacancy.id || null,
        comparisonProfile,
        analysisVersion,
        candidate: candidatePayload
      })
    };
  });""",
    'vacancy and current analysis in candidate fingerprint'
)

service_path.write_text(service, encoding='utf-8')

schema_path = Path('prisma/schema.prisma')
schema = schema_path.read_text(encoding='utf-8')

schema = replace_once(
    schema,
    """  dispatchWorkers        DispatchWorkerVacancy[]
}""",
    """  dispatchWorkers        DispatchWorkerVacancy[]
  cvReviewProfiles       CvReviewProfile[]
  cvCandidateComparisons CvCandidateComparison[]
  cvAnalysisUsages       CvAnalysisUsage[]
}""",
    'vacancy cache relations'
)

schema = replace_once(
    schema,
    """  dispatchWorker         DispatchWorker?

  @@index([campaignId])""",
    """  dispatchWorker         DispatchWorker?
  cvCandidateComparisons CvCandidateComparison[]

  @@index([campaignId])""",
    'candidate comparison relation'
)

models = """model CvReviewProfile {
  id                 String   @id @default(cuid())
  fingerprint        String   @unique
  vacancyId          String
  vacancy            Vacancy  @relation(fields: [vacancyId], references: [id], onDelete: Cascade)
  modelUsed          String
  interpretedProfile Json
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@index([vacancyId])
}

model CvCandidateComparison {
  id          String    @id @default(cuid())
  fingerprint String    @unique
  candidateId String
  candidate   Candidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)
  vacancyId   String?
  vacancy     Vacancy?  @relation(fields: [vacancyId], references: [id], onDelete: SetNull)
  modelUsed   String
  level       String
  score       Float
  reasons     Json
  evidence    Json
  gaps        Json
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@index([candidateId])
  @@index([vacancyId])
}

model CvAnalysisUsage {
  id                String   @id @default(cuid())
  stage             String
  vacancyId         String?
  vacancy           Vacancy? @relation(fields: [vacancyId], references: [id], onDelete: SetNull)
  candidateCount    Int      @default(0)
  modelUsed         String
  inputTokens       Int      @default(0)
  cachedInputTokens Int      @default(0)
  cacheWriteTokens  Int      @default(0)
  outputTokens      Int      @default(0)
  reasoningTokens   Int      @default(0)
  totalTokens       Int      @default(0)
  createdAt         DateTime @default(now())

  @@index([createdAt])
  @@index([stage, createdAt])
  @@index([vacancyId, createdAt])
}

"""
schema = replace_once(schema, 'model AppUser {', models + 'model AppUser {', 'cache models')
schema_path.write_text(schema, encoding='utf-8')

test_path = Path('test/cvTokenSavings.test.js')
test_text = test_path.read_text(encoding='utf-8')
test_text = test_text.replace(
    "return structuredResponse({      results:",
    "return structuredResponse({\n      results:",
    1
)

test_text = replace_once(
    test_text,
    """  clearCvIntelligenceCachesForTest();
  requests.length = 0;
  prisma.setCandidates([{ ...firstCandidate, transportMode: 'Bicicleta' }, newCandidate]);
  await reviewVacancyCandidates(prisma, { vacancyId: targetVacancy.id, desiredProfile }, { openAiPost });
  assert.equal(requests.length, 1);
  const changedInput = JSON.parse(requests[0].input[1].content[0].text);
  assert.deepEqual(changedInput.candidates.map((item) => item.candidateId), ['existing']);
});""",
    """  clearCvIntelligenceCachesForTest();
  requests.length = 0;
  prisma.setCandidates([{ ...firstCandidate, transportMode: 'Bicicleta' }, newCandidate]);
  await reviewVacancyCandidates(prisma, { vacancyId: targetVacancy.id, desiredProfile }, { openAiPost });
  assert.equal(requests.length, 1);
  const changedInput = JSON.parse(requests[0].input[1].content[0].text);
  assert.deepEqual(changedInput.candidates.map((item) => item.candidateId), ['existing']);

  clearCvIntelligenceCachesForTest();
  requests.length = 0;
  const replacedAnalysis = {
    ...firstCandidate.attachmentAnalyses[0],
    id: 'analysis-existing-replaced',
    analysedAt: new Date('2026-08-01T01:00:00.000Z'),
    rawResponse: {
      ...firstCandidate.attachmentAnalyses[0].rawResponse,
      documentReference: 'storage:candidates/existing/hv-replaced.pdf'
    }
  };
  prisma.setCandidates([{
    ...firstCandidate,
    cvStorageKey: 'candidates/existing/hv-replaced.pdf',
    attachmentAnalyses: [replacedAnalysis]
  }, newCandidate]);
  await reviewVacancyCandidates(prisma, { vacancyId: targetVacancy.id, desiredProfile }, { openAiPost });
  assert.equal(requests.length, 1);
  const replacedInput = JSON.parse(requests[0].input[1].content[0].text);
  assert.deepEqual(replacedInput.candidates.map((item) => item.candidateId), ['existing']);
});""",
    'document replacement invalidation test'
)

test_text = replace_once(
    test_text,
    """    const input = JSON.parse(payload.input[1].content[0].text);
    if (input.candidates.length === 1) return structuredResponse({ results: [] }, usage);
    return structuredResponse({ results: [matchResult(input.candidates[0].candidateId)] }, usage);""",
    """    const input = JSON.parse(payload.input[1].content[0].text);
    if (input.candidates.length === 1) return structuredResponse({ results: [] }, usage);
    return structuredResponse({
      results: [
        matchResult(input.candidates[0].candidateId),
        matchResult(input.candidates[0].candidateId),
        matchResult('unknown-candidate')
      ]
    }, usage);""",
    'malformed response persistence test'
)

test_path.write_text(test_text, encoding='utf-8')
