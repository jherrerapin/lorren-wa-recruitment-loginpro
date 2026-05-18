import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('dispatch personnel foundation exists', () => {
  const schema = readSource('prisma/schema.prisma');
  assert.match(schema, /model\s+DispatchWorker\s+{/);
  assert.match(schema, /model\s+DispatchWorkerCity\s+{/);
  assert.match(schema, /model\s+DispatchWorkerVacancy\s+{/);

  const migrationsDir = new URL('../prisma/migrations', import.meta.url);
  const migrationFiles = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes('add_dispatch_worker_foundation'))
    .map((entry) => readFileSync(join(migrationsDir.pathname, entry.name, 'migration.sql'), 'utf8'));
  assert.ok(migrationFiles.length > 0, 'Debe existir migración de personal operativo.');
  assert.ok(migrationFiles.some((m) => /CREATE TABLE "DispatchWorker"/.test(m)));
  assert.ok(migrationFiles.some((m) => /CREATE TABLE "DispatchWorkerCity"/.test(m)));
  assert.ok(migrationFiles.some((m) => /CREATE TABLE "DispatchWorkerVacancy"/.test(m)));
});

test('contracted status sync and operations routes exist without webhook/fsm changes', () => {
  const syncService = readSource('src/services/dispatchWorkerSync.js');
  assert.match(syncService, /export\s+async\s+function\s+upsertDispatchWorkerFromCandidate/);

  const adminSource = readSource('src/routes/admin.js');
  assert.match(adminSource, /status\s*===\s*['"]CONTRATADO['"]\)\s*await\s+upsertDispatchWorkerFromCandidate\(prisma,\s*id\)/);

  const bridgeSource = readSource('src/routes/dispatchBridge.js');
  assert.match(bridgeSource, /router\.get\(\s*['"]\/personal['"]/);
  assert.match(bridgeSource, /router\.post\(\s*['"]\/sync-contratados['"]/);

  const webhookSource = readSource('src/routes/webhook.js');
  assert.doesNotMatch(webhookSource, /upsertDispatchWorkerFromCandidate|\/sync-contratados|\/operaciones\/personal/);

  const fsmSource = readSource('src/services/conversationEngine.js');
  assert.doesNotMatch(fsmSource, /upsertDispatchWorkerFromCandidate|DispatchWorker/);
});
