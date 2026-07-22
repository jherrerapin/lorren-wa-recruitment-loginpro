import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/routes/webhook.js';
let source = readFileSync(file, 'utf8');

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

if (!source.includes(newBlock)) {
  const count = source.split(oldBlock).length - 1;
  if (count !== 1) throw new Error(`assign vacancy block count=${count}`);
  source = source.replace(oldBlock, newBlock);
}

writeFileSync(file, source, 'utf8');
console.log('Question-before-data transition patch applied for #628.');
