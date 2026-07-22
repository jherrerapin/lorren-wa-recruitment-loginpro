import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const WEBHOOK_FILE = 'src/routes/webhook.js';

test('replyWithEngine usa el compositor de seguimiento único', () => {
  const source = fs.readFileSync(WEBHOOK_FILE, 'utf8');

  assert.match(
    source,
    /import \{ appendUniqueReplySegment \} from '\.\.\/services\/replyComposition\.js';/
  );
  assert.match(
    source,
    /body = appendUniqueReplySegment\(body, buildVacancyContinuePrompt\(candidateAfterActions, vacancy\)\);/
  );
  assert.doesNotMatch(
    source,
    /body = `\$\{body\} \$\{buildVacancyContinuePrompt\(candidateAfterActions, vacancy\)\}`\.trim\(\);/
  );
});
