import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/services/vacancyResolver.js';
let source = readFileSync(file, 'utf8');

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

if (!source.includes('function shouldPreferSpecificInactiveMatch(')) {
  const count = source.split(helperAnchor).length - 1;
  if (count !== 1) throw new Error(`helper anchor count=${count}`);
  source = source.replace(helperAnchor, helperReplacement);
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

if (!source.includes(newResolutionBlock)) {
  const count = source.split(oldResolutionBlock).length - 1;
  if (count !== 1) throw new Error(`resolution block count=${count}`);
  source = source.replace(oldResolutionBlock, newResolutionBlock);
}

writeFileSync(file, source, 'utf8');
console.log('Inactive vacancy specificity patch applied for #624.');
