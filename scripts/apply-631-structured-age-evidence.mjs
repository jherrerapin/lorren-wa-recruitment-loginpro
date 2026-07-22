import { readFileSync, writeFileSync } from 'node:fs';

const ageFile = 'src/services/ageEvidence.js';
let ageSource = readFileSync(ageFile, 'utf8');

const valuePatternBlock = `function valuePattern(value) {
  const age = normalizeAge(value);
  return age === null ? null : String(age);
}`;

const structuredHelpers = `function valuePattern(value) {
  const age = normalizeAge(value);
  return age === null ? null : String(age);
}

function normalizeStructuredSegments(text = '') {
  return String(text || '')
    .split(/[\\n,;]+/)
    .map((segment) => normalizeText(segment))
    .filter(Boolean);
}

function hasStructuredAgeSegment(value, text = '') {
  const number = valuePattern(value);
  if (!number) return false;
  const labeled = new RegExp(\`^edad\\s*(?:es\\s*)?[:\\-]?\\s*\${number}(?:\\s+anos?(?:\\s+de\\s+edad)?)?$\`);
  const yearsOnly = new RegExp(\`^\${number}\\s+anos?(?:\\s+de\\s+edad)?$\`);
  return normalizeStructuredSegments(text).some((segment) => labeled.test(segment) || yearsOnly.test(segment));
}

function isFutureBirthdayNumber(value, text = '') {
  const number = valuePattern(value);
  if (!number) return false;
  const normalized = normalizeText(text);
  return new RegExp(\`\\b(?:cumplo|cumplire|voy\\s+a\\s+cumplir)(?:\\s+los)?\\s+\${number}\\b\`).test(normalized);
}

function hasCurrentAgeBeforeFutureBirthday(value, text = '') {
  const number = valuePattern(value);
  if (!number) return false;
  const normalized = normalizeText(text);
  return new RegExp(\`\\b\${number}\\s+anos?\\b.{0,70}\\b(?:cumplo|cumplire|voy\\s+a\\s+cumplir)(?:\\s+los)?\\s+\\d{1,2}\\b\`).test(normalized);
}`;

if (!ageSource.includes('function normalizeStructuredSegments(')) {
  const count = ageSource.split(valuePatternBlock).length - 1;
  if (count !== 1) throw new Error(`age valuePattern anchor count=${count}`);
  ageSource = ageSource.replace(valuePatternBlock, structuredHelpers);
}

const oldExplicitStart = `function hasExplicitAgeBinding(value, text = '') {
  const number = valuePattern(value);
  if (!number) return false;
  const normalized = normalizeText(text);
  if (!normalized) return false;

  const patterns = [`;
const newExplicitStart = `function hasExplicitAgeBinding(value, text = '') {
  const number = valuePattern(value);
  if (!number) return false;
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (hasCurrentAgeBeforeFutureBirthday(number, text)) return true;
  if (hasStructuredAgeSegment(number, text)) {
    return !isWorkDurationNumber(number, text) && !isWorkMetricNumber(number, text);
  }

  const patterns = [`;

if (!ageSource.includes(newExplicitStart)) {
  const count = ageSource.split(oldExplicitStart).length - 1;
  if (count !== 1) throw new Error(`explicit age anchor count=${count}`);
  ageSource = ageSource.replace(oldExplicitStart, newExplicitStart);
}

const oldClassifyStart = `export function classifyAgeEvidence(value, text = '', options = {}) {
  const age = normalizeAge(value);
  if (age === null) return { valid: false, reason: 'invalid_age_range' };
  if (hasAddressBinding(age, text)) return { valid: false, reason: 'address_number_not_age' };`;
const newClassifyStart = `export function classifyAgeEvidence(value, text = '', options = {}) {
  const age = normalizeAge(value);
  if (age === null) return { valid: false, reason: 'invalid_age_range' };
  if (isFutureBirthdayNumber(age, text)) return { valid: false, reason: 'future_birthday_not_current_age' };
  if (hasAddressBinding(age, text)) return { valid: false, reason: 'address_number_not_age' };`;

if (!ageSource.includes(newClassifyStart)) {
  const count = ageSource.split(oldClassifyStart).length - 1;
  if (count !== 1) throw new Error(`classify age anchor count=${count}`);
  ageSource = ageSource.replace(oldClassifyStart, newClassifyStart);
}

const oldExtractStart = `export function extractExplicitAge(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const patterns = [`;
const newExtractStart = `export function extractExplicitAge(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const birthdayMatch = normalized.match(/\\b(\\d{1,2})\\s+anos?\\b.{0,70}\\b(?:cumplo|cumplire|voy\\s+a\\s+cumplir)(?:\\s+los)?\\s+\\d{1,2}\\b/);
  if (birthdayMatch?.[1]) {
    const currentAge = normalizeAge(birthdayMatch[1]);
    if (currentAge !== null && classifyAgeEvidence(currentAge, text, { allowStandalone: false }).valid) return currentAge;
  }

  for (const segment of normalizeStructuredSegments(text)) {
    const match = segment.match(/^(?:edad\\s*(?:es\\s*)?[:\\-]?\\s*)?(\\d{1,2})\\s+anos?(?:\\s+de\\s+edad)?$/);
    if (!match?.[1]) continue;
    const age = normalizeAge(match[1]);
    if (age !== null && classifyAgeEvidence(age, text, { allowStandalone: false }).valid) return age;
  }

  const patterns = [`;

if (!ageSource.includes(newExtractStart)) {
  const count = ageSource.split(oldExtractStart).length - 1;
  if (count !== 1) throw new Error(`extract age anchor count=${count}`);
  ageSource = ageSource.replace(oldExtractStart, newExtractStart);
}

writeFileSync(ageFile, ageSource, 'utf8');

const candidateFile = 'src/services/candidateData.js';
let candidateSource = readFileSync(candidateFile, 'utf8');
const oldContextual = `function detectContextualAge(text = '') {
  return extractExplicitAge(text);
}`;
const newContextual = `function detectContextualAge(text = '') {
  return extractExplicitAge(text);
}

export function shouldPreserveStructuredLocalField(field, localValue, proposedValue) {
  if (field !== 'age') return false;
  const localAge = Number.parseInt(String(localValue ?? '').trim(), 10);
  const proposedAge = Number.parseInt(String(proposedValue ?? '').trim(), 10);
  if (!Number.isInteger(localAge) || localAge < 14 || localAge > 80) return false;
  if (!Number.isInteger(proposedAge) || proposedAge < 14 || proposedAge > 80) return false;
  return localAge !== proposedAge;
}`;

if (!candidateSource.includes('export function shouldPreserveStructuredLocalField(')) {
  const count = candidateSource.split(oldContextual).length - 1;
  if (count !== 1) throw new Error(`candidate contextual age anchor count=${count}`);
  candidateSource = candidateSource.replace(oldContextual, newContextual);
}

const oldContextCall = `  const detectedAge = detectContextualAge(compact);`;
const newContextCall = `  const detectedAge = detectContextualAge(text);`;
if (!candidateSource.includes(newContextCall)) {
  const count = candidateSource.split(oldContextCall).length - 1;
  if (count !== 1) throw new Error(`candidate age call anchor count=${count}`);
  candidateSource = candidateSource.replace(oldContextCall, newContextCall);
}

writeFileSync(candidateFile, candidateSource, 'utf8');

const webhookFile = 'src/routes/webhook.js';
let webhookSource = readFileSync(webhookFile, 'utf8');
const oldImport = `  normalizeCandidateFields,
  parseNaturalData
} from '../services/candidateData.js';`;
const newImport = `  normalizeCandidateFields,
  parseNaturalData,
  shouldPreserveStructuredLocalField
} from '../services/candidateData.js';`;
if (!webhookSource.includes(newImport)) {
  const count = webhookSource.split(oldImport).length - 1;
  if (count !== 1) throw new Error(`webhook candidate import anchor count=${count}`);
  webhookSource = webhookSource.replace(oldImport, newImport);
}

const oldAiLoop = `  for (const [field, value] of Object.entries(aiFields)) {
    if (value === undefined || value === null || value === '') continue;
    mergedData[field] = value;`;
const newAiLoop = `  for (const [field, value] of Object.entries(aiFields)) {
    if (value === undefined || value === null || value === '') continue;
    if (shouldPreserveStructuredLocalField(field, localParsedData[field], value)) continue;
    mergedData[field] = value;`;
if (!webhookSource.includes(newAiLoop)) {
  const count = webhookSource.split(oldAiLoop).length - 1;
  if (count !== 1) throw new Error(`webhook AI merge anchor count=${count}`);
  webhookSource = webhookSource.replace(oldAiLoop, newAiLoop);
}

const oldEngineLoop = `  for (const [field, value] of Object.entries(engineFields)) {
    if (value === undefined || value === null || value === '') continue;
    mergedData[field] = value;`;
const newEngineLoop = `  for (const [field, value] of Object.entries(engineFields)) {
    if (value === undefined || value === null || value === '') continue;
    if (shouldPreserveStructuredLocalField(field, localParsedData[field], value)) continue;
    mergedData[field] = value;`;
if (!webhookSource.includes(newEngineLoop)) {
  const count = webhookSource.split(oldEngineLoop).length - 1;
  if (count !== 1) throw new Error(`webhook engine merge anchor count=${count}`);
  webhookSource = webhookSource.replace(oldEngineLoop, newEngineLoop);
}

writeFileSync(webhookFile, webhookSource, 'utf8');
console.log('Structured age evidence patch applied for #631.');
