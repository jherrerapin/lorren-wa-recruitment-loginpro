import { readFileSync, writeFileSync } from 'node:fs';

const resolverFile = 'src/services/vacancyResolver.js';
let resolverSource = readFileSync(resolverFile, 'utf8');

const helperAnchor = `function baseVacancyResolution(overrides = {}) {
  return { vacancy: null, requiresRelocation: false, ambiguous: false, options: [], source: 'text_inference_fallback', fallback: true, ...overrides };
}`;

const helperReplacement = `function shouldPreferSpecificInactiveMatch(activeMatch, inactiveMatch, context = {}) {
  if (!canUseInactiveMatch(inactiveMatch, context)) return false;
  const activeRoleScore = Number(activeMatch?.best?.roleScore || 0);
  const inactiveRoleScore = Number(inactiveMatch?.best?.roleScore || 0);
  return inactiveRoleScore >= activeRoleScore + 0.75;
}

${helperAnchor}`;

if (!resolverSource.includes('function shouldPreferSpecificInactiveMatch(')) {
  const count = resolverSource.split(helperAnchor).length - 1;
  if (count !== 1) throw new Error(`helper anchor count=${count}`);
  resolverSource = resolverSource.replace(helperAnchor, helperReplacement);
}

const oldResolutionBlock = `  const { best, runnerUp, margin } = pickBestVacancyMatch(matchingCityVacancies, { text, city, roleHint, operationZones });
  const effectiveThreshold = roleHint ? threshold : 6;
  const activeHasRoleEvidence = hasEnoughRoleEvidence({ best }, roleHint);
  if (!best || best.score < effectiveThreshold || !activeHasRoleEvidence) {`;

const newResolutionBlock = `  const activeMatch = pickBestVacancyMatch(matchingCityVacancies, { text, city, roleHint, operationZones });
  const { best, runnerUp, margin } = activeMatch;
  const effectiveThreshold = roleHint ? threshold : 6;
  const activeHasRoleEvidence = hasEnoughRoleEvidence({ best }, roleHint);
  if (shouldPreferSpecificInactiveMatch(activeMatch, inactiveMatch, inactiveContext)) {
    return { resolved: true, vacancy: inactiveMatch.best.vacancy, city: city || canonicalVacancyCity(inactiveMatch.best.vacancy), roleHint, reason: 'matched_inactive_vacancy', source: 'text_inference_fallback', fallback: true };
  }
  if (!best || best.score < effectiveThreshold || !activeHasRoleEvidence) {`;

if (!resolverSource.includes(newResolutionBlock)) {
  const count = resolverSource.split(oldResolutionBlock).length - 1;
  if (count !== 1) throw new Error(`resolution block count=${count}`);
  resolverSource = resolverSource.replace(oldResolutionBlock, newResolutionBlock);
}

writeFileSync(resolverFile, resolverSource, 'utf8');

const gateFile = 'src/services/vacancyFirstGate.js';
let gateSource = readFileSync(gateFile, 'utf8');
const oldGateUpdate = `      candidateUpdates: { currentStep: GREETING_SENT, botResumeMode: PAUSED_VACANCY_OFFER_MODE, reminderScheduledFor: null, reminderState: 'SKIPPED' },
      reply: buildInactiveVacancyReply(resolution.vacancy, resolution.city, inboundText),`;
const newGateUpdate = `      candidateUpdates: { vacancyId: resolution.vacancy.id, currentStep: GREETING_SENT, botResumeMode: PAUSED_VACANCY_OFFER_MODE, reminderScheduledFor: null, reminderState: 'SKIPPED' },
      reply: buildInactiveVacancyReply(resolution.vacancy, resolution.city, inboundText),`;

if (!gateSource.includes(newGateUpdate)) {
  const count = gateSource.split(oldGateUpdate).length - 1;
  if (count !== 1) throw new Error(`inactive gate update count=${count}`);
  gateSource = gateSource.replace(oldGateUpdate, newGateUpdate);
}

writeFileSync(gateFile, gateSource, 'utf8');
console.log('Inactive vacancy specificity and gate persistence patch applied for #624.');
