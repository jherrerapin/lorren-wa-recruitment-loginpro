import { readFileSync, writeFileSync } from 'node:fs';

const webhookFile = 'src/routes/webhook.js';
let webhookSource = readFileSync(webhookFile, 'utf8');

const oldBlock = `  if (vacancyFirstGateDecision.action === VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE) {
    const nextStep = candidate.currentStep === ConversationStep.MENU
      ? ConversationStep.GREETING_SENT
      : candidate.currentStep;
    const applied = await applyVacancyFirstGateUpdates({
      vacancyId: vacancyFirstGateDecision.vacancyId,
      currentStep: nextStep
    });
    if (!applied.applied) return;
    currentVacancy = vacancyFirstGateDecision.vacancy || await loadVacancyContext(prisma, vacancyFirstGateDecision.vacancyId);
    normalizedData = alignCandidateLocationFields(normalizedData, currentVacancy, { clearAlternate: false });
    debugTrace.normalized_fields = normalizedData;
    const body = buildVacancyReplyNatural(currentVacancy, candidate, cleanText);
    return reply(prisma, candidate.id, from, body, cleanText, {
      body,
      source: 'vacancy_first_gate',
      reason: vacancyFirstGateDecision.reason,
      safetyVacancy: currentVacancy
    });
  }`;

const newBlock = `  if (vacancyFirstGateDecision.action === VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE) {
    const shouldAnswerQuestionAndCollect = candidate.currentStep === ConversationStep.MENU
      && isAffirmativeInterest(cleanText)
      && isQuestionLike(cleanText);
    const nextStep = shouldAnswerQuestionAndCollect
      ? ConversationStep.COLLECTING_DATA
      : (candidate.currentStep === ConversationStep.MENU
        ? ConversationStep.GREETING_SENT
        : candidate.currentStep);
    const applied = await applyVacancyFirstGateUpdates({
      vacancyId: vacancyFirstGateDecision.vacancyId,
      currentStep: nextStep
    });
    if (!applied.applied) return;
    currentVacancy = vacancyFirstGateDecision.vacancy || await loadVacancyContext(prisma, vacancyFirstGateDecision.vacancyId);
    normalizedData = alignCandidateLocationFields(normalizedData, currentVacancy, { clearAlternate: false });
    debugTrace.normalized_fields = normalizedData;
    const candidateState = {
      ...candidate,
      vacancyId: vacancyFirstGateDecision.vacancyId,
      currentStep: nextStep
    };
    const body = shouldAnswerQuestionAndCollect
      ? buildQuestionFollowUpReply(
        currentVacancy,
        cleanText,
        buildDataRequestPrompt(candidateState, currentVacancy),
        candidateState
      )
      : buildVacancyReplyNatural(currentVacancy, candidateState, cleanText);
    return reply(prisma, candidate.id, from, body, cleanText, {
      body,
      source: 'vacancy_first_gate',
      reason: vacancyFirstGateDecision.reason,
      safetyVacancy: currentVacancy
    });
  }`;

if (!webhookSource.includes(newBlock)) {
  const count = webhookSource.split(oldBlock).length - 1;
  if (count !== 1) throw new Error(`assign vacancy block count=${count}`);
  webhookSource = webhookSource.replace(oldBlock, newBlock);
}

writeFileSync(webhookFile, webhookSource, 'utf8');

const safetyFile = 'src/services/replySafety.js';
let safetySource = readFileSync(safetyFile, 'utf8');
const oldAliases = `    obra_labor: ['obra labor', 'obra o labor'],`;
const newAliases = `    obra_labor: ['obra labor', 'obra o labor', 'contrato por obra'],`;

if (!safetySource.includes(newAliases)) {
  const count = safetySource.split(oldAliases).length - 1;
  if (count !== 1) throw new Error(`obra_labor alias count=${count}`);
  safetySource = safetySource.replace(oldAliases, newAliases);
}

writeFileSync(safetyFile, safetySource, 'utf8');

const gateFile = 'src/services/vacancyFirstGate.js';
let gateSource = readFileSync(gateFile, 'utf8');
const oldInactiveUpdates = `      candidateUpdates: { vacancyId: resolution.vacancy.id, currentStep: GREETING_SENT, botResumeMode: PAUSED_VACANCY_OFFER_MODE, reminderScheduledFor: null, reminderState: 'SKIPPED' },`;
const newInactiveUpdates = `      candidateUpdates: {
        ...(resolution.reason === 'matched_inactive_vacancy' ? { vacancyId: resolution.vacancy.id } : {}),
        currentStep: GREETING_SENT,
        botResumeMode: PAUSED_VACANCY_OFFER_MODE,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      },`;

if (!gateSource.includes(newInactiveUpdates)) {
  const count = gateSource.split(oldInactiveUpdates).length - 1;
  if (count !== 1) throw new Error(`inactive candidate updates count=${count}`);
  gateSource = gateSource.replace(oldInactiveUpdates, newInactiveUpdates);
}

writeFileSync(gateFile, gateSource, 'utf8');

const gateTestFile = 'test/vacancyFirstGate.test.js';
let gateTestSource = readFileSync(gateTestFile, 'utf8');
const oldExplicitTest = `test('vacante inactiva explícita en Siberia responde oferta futura sin candidateUpdates.vacancyId', async () => {`;
const newExplicitTest = `test('vacante inactiva explícita en Siberia persiste candidateUpdates.vacancyId', async () => {`;
const oldExplicitAssertion = `  assert.equal(decision.candidateUpdates.vacancyId, undefined);\n  assert.equal(decision.vacancyId, undefined);`;
const newExplicitAssertion = `  assert.equal(decision.candidateUpdates.vacancyId, 'vac-siberia-inactive-explicit');\n  assert.equal(decision.vacancyId, undefined);\n  assert.equal(decision.resolution.reason, 'matched_inactive_vacancy');`;

if (!gateTestSource.includes(newExplicitTest)) {
  const titleCount = gateTestSource.split(oldExplicitTest).length - 1;
  if (titleCount !== 1) throw new Error(`explicit inactive test title count=${titleCount}`);
  gateTestSource = gateTestSource.replace(oldExplicitTest, newExplicitTest);
}
if (!gateTestSource.includes(newExplicitAssertion)) {
  const assertionCount = gateTestSource.split(oldExplicitAssertion).length - 1;
  if (assertionCount !== 1) throw new Error(`explicit inactive assertion count=${assertionCount}`);
  gateTestSource = gateTestSource.replace(oldExplicitAssertion, newExplicitAssertion);
}

writeFileSync(gateTestFile, gateTestSource, 'utf8');
console.log('Question-before-data, safety, and inactive metadata boundary patches applied for #628.');
