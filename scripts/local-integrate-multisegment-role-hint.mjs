import fs from 'node:fs';

const file = 'src/services/vacancyResolver.js';
const source = fs.readFileSync(file, 'utf8');

function mustReplace(input, from, to, label) {
  if (!input.includes(from)) {
    throw new Error(`No encontré el bloque esperado: ${label}`);
  }
  return input.replace(from, to);
}

const oldBlock = `  const segments = splitMeaningfulSegments(text);
  const preferredSegments = segments.filter((segment) => ROLE_SIGNAL_REGEX.test(segment));
  for (const preferredSegment of preferredSegments) {
    const preferredTokens = cleanRoleTokens(tokenize(preferredSegment), cityTokens);
    const preferredRoleHint = preferredTokens.length ? normalizeRoleHint(preferredTokens.join(' '), options.city || '') : null;
    if (preferredRoleHint) return preferredRoleHint;
  }`;

const newBlock = `  const segments = splitMeaningfulSegments(text);
  const preferredSegments = segments.filter((segment) => ROLE_SIGNAL_REGEX.test(segment));
  if (preferredSegments.length) {
    const preferredTokens = preferredSegments.flatMap((segment) => cleanRoleTokens(tokenize(segment), cityTokens));
    const preferredRoleHint = preferredTokens.length
      ? normalizeRoleHint(preferredTokens.join(' '), options.city || '')
      : null;
    if (preferredRoleHint) return preferredRoleHint;
  }`;

const updated = mustReplace(source, oldBlock, newBlock, 'acumular segmentos de rol en detectRoleHintFromText');

fs.writeFileSync(file, updated);
console.log('OK: vacancyResolver ahora acumula todos los segmentos con señal de cargo.');
