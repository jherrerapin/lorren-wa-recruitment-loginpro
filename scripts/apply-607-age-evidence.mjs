import { readFileSync, writeFileSync } from 'node:fs';

function replaceFunction(file, functionName, nextFunctionName, replacement) {
  const source = readFileSync(file, 'utf8');
  const startToken = `function ${functionName}`;
  const endToken = `function ${nextFunctionName}`;
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  if (start < 0 || end < 0) throw new Error(`${file}: no se encontraron límites de ${functionName}`);
  writeFileSync(file, `${source.slice(0, start)}${replacement}\n\n${source.slice(end)}`, 'utf8');
}

const candidateFile = 'src/services/candidateData.js';
{
  let source = readFileSync(candidateFile, 'utf8');
  const importLine = "import { extractExplicitAge, isWorkDurationNumber, isWorkMetricNumber } from './ageEvidence.js';";
  if (!source.includes(importLine)) {
    const anchor = "import { normalizeTransportMode as deterministicNormalizeTransportMode } from './transportMode.js';";
    const count = source.split(anchor).length - 1;
    if (count !== 1) throw new Error(`candidateData import anchor count: ${count}`);
    source = source.replace(anchor, `${anchor}\n${importLine}`);
    writeFileSync(candidateFile, source, 'utf8');
  }
}

replaceFunction(
  candidateFile,
  'detectContextualAge',
  'detectAgeFromSequence',
  `function detectContextualAge(text = '') {
  return extractExplicitAge(text);
}`
);

{
  let source = readFileSync(candidateFile, 'utf8');
  const anchor = `    const age = Number.parseInt(token, 10);
    if (!Number.isFinite(age) || age < 14 || age > 80) continue;

    const previous = normalizeLooseText(tokens[index - 1] || '');`;
  const target = `    const age = Number.parseInt(token, 10);
    if (!Number.isFinite(age) || age < 14 || age > 80) continue;
    if (isWorkDurationNumber(age, text) || isWorkMetricNumber(age, text)) continue;

    const previous = normalizeLooseText(tokens[index - 1] || '');`;
  if (!source.includes(target)) {
    const count = source.split(anchor).length - 1;
    if (count !== 1) throw new Error(`candidateData standalone age anchor count: ${count}`);
    source = source.replace(anchor, target);
    writeFileSync(candidateFile, source, 'utf8');
  }
}

{
  let source = readFileSync(candidateFile, 'utf8');
  const oldGlobal = "  const hasGlobalWorkContext = /\\b(experien|trabaj|labor|cargo|oficio)\\b/.test(compact);";
  const newGlobal = "  const hasGlobalWorkContext = /\\b(experien|trabaj|labor|cargo|oficio|operaci|logistic|personal|coordin|turno)\\b/.test(compact);";
  const oldLocal = "    const hasLocalWorkContext = /\\b(experien|trabaj|labor|cargo|oficio)\\b/.test(nearContext);";
  const newLocal = "    const hasLocalWorkContext = /\\b(experien|trabaj|labor|cargo|oficio|operaci|logistic|personal|coordin|turno)\\b/.test(nearContext);";

  if (!source.includes(newGlobal)) {
    const count = source.split(oldGlobal).length - 1;
    if (count !== 1) throw new Error(`candidateData global work context count: ${count}`);
    source = source.replace(oldGlobal, newGlobal);
  }
  if (!source.includes(newLocal)) {
    const count = source.split(oldLocal).length - 1;
    if (count !== 1) throw new Error(`candidateData local work context count: ${count}`);
    source = source.replace(oldLocal, newLocal);
  }
  writeFileSync(candidateFile, source, 'utf8');
}

const sanitizerFile = 'src/services/fieldSanitizer.js';
{
  let source = readFileSync(sanitizerFile, 'utf8');
  const importLine = "import { classifyAgeEvidence } from './ageEvidence.js';";
  if (!source.includes(importLine)) {
    const anchor = "import { hasAmbiguousGenderEvidence, hasStrongGenderEvidence } from './genderEvidencePolicy.js';";
    const count = source.split(anchor).length - 1;
    if (count !== 1) throw new Error(`fieldSanitizer import anchor count: ${count}`);
    source = source.replace(anchor, `${anchor}\n${importLine}`);
    writeFileSync(sanitizerFile, source, 'utf8');
  }
}

replaceFunction(
  sanitizerFile,
  'sanitizeAge',
  'evaluateField',
  `function sanitizeAge(value, text, context = {}) {
  if (!/^\\d+$/.test(String(value || '').trim())) return { ok: false, reason: 'invalid_numeric_value' };
  const age = Number(value);
  if (!Number.isInteger(age) || age < 14 || age > 80) return { ok: false, reason: 'invalid_age_range' };

  const allowStandalone = fieldWasPending('age', context) || lastQuestionAskedForField('age', context);
  const evidence = classifyAgeEvidence(age, text, { allowStandalone });
  if (!evidence.valid) return { ok: false, reason: evidence.reason };
  return { ok: true, value: age };
}`
);

{
  let source = readFileSync(sanitizerFile, 'utf8');
  const oldCall = "  if (field === 'age') return sanitizeAge(value, text);";
  const newCall = "  if (field === 'age') return sanitizeAge(value, text, context);";
  if (!source.includes(newCall)) {
    const count = source.split(oldCall).length - 1;
    if (count !== 1) throw new Error(`fieldSanitizer age call count: ${count}`);
    source = source.replace(oldCall, newCall);
    writeFileSync(sanitizerFile, source, 'utf8');
  }
}

console.log('Patch #607 applied.');
