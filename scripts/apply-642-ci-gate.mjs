import fs from 'node:fs';
import crypto from 'node:crypto';

const filePath = '.github/workflows/ci.yml';
const expectedBlobSha = '2c47caff11bcbea8d9458704dcefdd80727ce26b';
let source = fs.readFileSync(filePath, 'utf8');

function gitBlobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex');
}

if (gitBlobSha(source) !== expectedBlobSha) {
  throw new Error(`ci.yml cambió antes de aplicar el gate #642. SHA observado: ${gitBlobSha(source)}`);
}

const oldText = `      - name: Validate transitional code inventory
        run: node --test test/transitionalCodeInventory.test.js

      - name: Run conversation turn arbitration regressions`;
const newText = `      - name: Validate transitional code inventory
        run: node --test test/transitionalCodeInventory.test.js

      - name: Run vacancy age authority regressions
        run: node --test test/readinessGuard.test.js test/candidateAgeHarnessIntegration.test.js test/structuredAgeHarnessIntegration.test.js test/vacancyAgeAuthorityIntegration.test.js

      - name: Run conversation turn arbitration regressions`;

const occurrences = source.split(oldText).length - 1;
if (occurrences !== 1) throw new Error(`Se esperaba un único punto de inserción y se encontraron ${occurrences}`);

source = source.replace(oldText, newText);
fs.writeFileSync(filePath, source, 'utf8');
console.log(`Gate #642 añadido. Nuevo blob SHA: ${gitBlobSha(source)}`);
