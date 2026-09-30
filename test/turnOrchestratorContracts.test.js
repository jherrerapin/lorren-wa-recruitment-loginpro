import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const adminSource = fs.readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');

test('envío manual de información de vacante queda etiquetado como intervención humana y valida vacante activa', () => {
  assert.match(adminSource, /actor:\s*rawPayload\?\.actor === 'ADMIN' \? 'ADMIN' : 'RECRUITER'/);
  assert.match(adminSource, /manualIntervention:\s*true/);
  assert.match(adminSource, /source:\s*'admin_manual_vacancy_info'/);
  assert.match(adminSource, /!candidate\.vacancy\.isActive \|\| !candidate\.vacancy\.acceptingApplications/);
});
