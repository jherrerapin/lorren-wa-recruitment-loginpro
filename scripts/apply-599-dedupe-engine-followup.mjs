import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/routes/webhook.js';
let source = readFileSync(file, 'utf8');

const importLine = "import { appendUniqueReplySegment } from '../services/replyComposition.js';";
if (!source.includes(importLine)) {
  const importAnchor = "import { sanitizeOutboundReply, buildSafeFallbackReply } from '../services/replySafety.js';";
  const importCount = source.split(importAnchor).length - 1;
  if (importCount !== 1) throw new Error(`webhook import anchor count: ${importCount}`);
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

const oldComposition = "    body = `${body} ${buildVacancyContinuePrompt(candidateAfterActions, vacancy)}`.trim();";
const newComposition = "    body = appendUniqueReplySegment(body, buildVacancyContinuePrompt(candidateAfterActions, vacancy));";
if (!source.includes(newComposition)) {
  const compositionCount = source.split(oldComposition).length - 1;
  if (compositionCount !== 1) throw new Error(`webhook follow-up composition count: ${compositionCount}`);
  source = source.replace(oldComposition, newComposition);
}

writeFileSync(file, source, 'utf8');
console.log('Patch #599 applied.');
