import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = 'config/candidate-progress-authority.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function walkJavaScriptFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath.replaceAll('\\', '/'));
    }
  }
  return files;
}

function parseConversationSteps(schema) {
  const match = schema.match(/enum\s+ConversationStep\s*\{([\s\S]*?)\}/);
  assert.ok(match, 'No se encontró enum ConversationStep en prisma/schema.prisma');
  return match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0]);
}

function extractFunctionSource(source, functionName) {
  const signature = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = signature.exec(source);
  assert.ok(match, `No se encontró la función ${functionName}`);
  const openingBrace = source.indexOf('{', match.index);
  assert.notEqual(openingBrace, -1, `No se encontró el cuerpo de ${functionName}`);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`Cuerpo incompleto para ${functionName}`);
}

const allowedRoles = new Set([
  'canonical_schema',
  'direct_writer',
  'indirect_writer',
  'decision_producer',
  'decision_policy',
  'decision_schema',
  'read_only_context',
  'read_only_projection',
  'read_only_support'
]);

const trackedLiteralPattern = /\b(?:currentStep|multilineWindowUntil|multilineBatchVersion)\s*:/;

test('el manifiesto de progreso coincide con el enum canónico de Prisma', () => {
  const schemaSteps = parseConversationSteps(readSource('prisma/schema.prisma'));
  assert.deepEqual(manifest.canonicalSteps, schemaSteps);
  assert.deepEqual(manifest.trackedFields, [
    'currentStep',
    'multilineWindowUntil',
    'multilineBatchVersion'
  ]);
  assert.equal(manifest.phase, 'multiline_authority_migrated');
  assert.equal(manifest.rules.runtimeChangesAllowedInThisPhase, true);
  assert.equal(manifest.rules.allowArbitraryCandidatePatch, false);
  assert.equal(manifest.rules.genderLogicInScope, false);
  assert.deepEqual(manifest.completedSlices, ['multiline_window_authority']);
  assert.doesNotMatch(manifest.trackedFields.join('|'), /gender/i);
});

test('cada fuente productiva está clasificada y existe en el repositorio', () => {
  const classifiedPaths = new Set();
  for (const source of manifest.sourceInventory) {
    assert.ok(source.path, 'Toda fuente debe declarar path');
    assert.ok(allowedRoles.has(source.role), `Rol no soportado para ${source.path}: ${source.role}`);
    assert.equal(fs.existsSync(source.path), true, `No existe la fuente clasificada: ${source.path}`);
    assert.equal(classifiedPaths.has(source.path), false, `Fuente duplicada: ${source.path}`);
    classifiedPaths.add(source.path);
    for (const field of source.trackedFields || []) {
      assert.ok(manifest.trackedFields.includes(field), `Campo no rastreado en ${source.path}: ${field}`);
    }
  }

  const observed = walkJavaScriptFiles('src')
    .filter((filePath) => trackedLiteralPattern.test(readSource(filePath)));

  const unclassified = observed.filter((filePath) => !classifiedPaths.has(filePath));
  assert.deepEqual(
    unclassified,
    [],
    `Aparecieron fuentes con literales de progreso sin clasificar: ${unclassified.join(', ')}`
  );
});

test('las familias de transición usan pasos conocidos y contratos estrechos', () => {
  const canonicalSteps = new Set(manifest.canonicalSteps);
  const trackedFields = new Set(manifest.trackedFields);
  const sourcePaths = new Set(manifest.sourceInventory.map((source) => source.path));
  const ids = new Set();

  for (const family of manifest.transitionFamilies) {
    assert.ok(family.id, 'Cada familia debe tener id');
    assert.equal(ids.has(family.id), false, `Familia duplicada: ${family.id}`);
    ids.add(family.id);
    assert.ok(Array.isArray(family.owners) && family.owners.length > 0, `${family.id} no declara owners`);
    assert.ok(Array.isArray(family.writers) && family.writers.length > 0, `${family.id} no declara writers`);
    assert.ok(family.trigger, `${family.id} no declara trigger`);
    assert.ok(family.concurrency, `${family.id} no documenta concurrencia`);
    assert.ok(family.idempotency, `${family.id} no documenta idempotencia`);

    for (const filePath of [...family.owners, ...family.writers]) {
      assert.ok(sourcePaths.has(filePath), `${family.id} referencia una fuente no inventariada: ${filePath}`);
    }
    for (const origin of family.origins) {
      assert.ok(origin === '*' || canonicalSteps.has(origin), `${family.id} usa origen inválido: ${origin}`);
    }
    for (const destination of family.destinations) {
      assert.ok(canonicalSteps.has(destination), `${family.id} usa destino inválido: ${destination}`);
    }
    for (const field of family.allowedFields) {
      assert.ok(trackedFields.has(field), `${family.id} intenta mutar un campo fuera de alcance: ${field}`);
    }
    assert.deepEqual(family.allowedFields, ['currentStep'], `${family.id} debe ser un contrato estrecho de currentStep`);
  }
});

test('CandidateStateService es la autoridad exclusiva de persistencia multilinea', () => {
  assert.deepEqual(
    manifest.multilineContracts.map((contract) => contract.id),
    ['schedule_multiline_window', 'acquire_multiline_batch']
  );

  for (const contract of manifest.multilineContracts) {
    assert.equal(contract.owner, 'src/services/candidateStateService.js');
    assert.equal(contract.consumer, 'src/routes/webhook.js');
    assert.equal(contract.status, 'canonical');
    assert.deepEqual(contract.allowedFields, ['multilineWindowUntil', 'multilineBatchVersion']);
    assert.ok(contract.concurrency);
    assert.ok(contract.idempotency);
  }

  const authority = readSource('src/services/candidateStateService.js');
  const scheduleAuthority = extractFunctionSource(authority, 'scheduleCandidateMultilineWindow');
  const acquireAuthority = extractFunctionSource(authority, 'acquireCandidateMultilineBatch');

  assert.match(scheduleAuthority, /candidate\.update\s*\(/);
  assert.match(scheduleAuthority, /multilineWindowUntil\s*:\s*windowUntil/);
  assert.match(scheduleAuthority, /multilineBatchVersion\s*:\s*\{\s*increment\s*:\s*1\s*,?\s*\}/);
  assert.match(acquireAuthority, /candidate\.updateMany\s*\(/);
  assert.match(acquireAuthority, /multilineBatchVersion\s*:\s*batchVersion/);
  assert.match(acquireAuthority, /multilineWindowUntil\s*:\s*\{\s*lte\s*:\s*now\s*\}/);
  assert.match(acquireAuthority, /multilineWindowUntil\s*:\s*null/);
  assert.match(acquireAuthority, /return\s+\{\s*count\s*:/);

  const webhook = readSource('src/routes/webhook.js');
  const scheduleConsumer = extractFunctionSource(webhook, 'scheduleMultilineWindow');
  const acquireConsumer = extractFunctionSource(webhook, 'tryAcquireMultilineProcessing');

  assert.match(webhook, /scheduleCandidateMultilineWindow/);
  assert.match(webhook, /acquireCandidateMultilineBatch/);
  assert.match(scheduleConsumer, /return\s+scheduleCandidateMultilineWindow\s*\(/);
  assert.doesNotMatch(scheduleConsumer, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
  assert.match(acquireConsumer, /await\s+acquireCandidateMultilineBatch\s*\(/);
  assert.match(acquireConsumer, /return\s+acquired\.count\s*===\s*1/);
  assert.doesNotMatch(acquireConsumer, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
  assert.match(webhook, /tryAcquireMultilineProcessing\(prisma,\s*candidate\.id,\s*scheduling\)/);
});

test('la reducción del engine y el consentimiento permanecen caracterizados sin una API genérica', () => {
  const engine = readSource('src/services/conversationEngine.js');
  const consent = readSource('src/services/consentStateService.js');
  const vacancyGate = readSource('src/services/vacancyFirstGate.js');
  const silentCapture = readSource('src/services/silentProfileCapture.js');

  assert.match(engine, /Object\.values\(ConversationStep\)\.includes\(nextStep\)/);
  assert.match(engine, /pendingUpdate\.currentStep = finalStep/);
  assert.match(consent, /ALLOWED_CANDIDATE_PATCH_FIELDS/);
  assert.match(consent, /'currentStep'/);
  assert.match(consent, /candidate_patch_field_not_allowed/);
  assert.doesNotMatch(vacancyGate, /prisma\.candidate\.(?:create|upsert|update|updateMany)\s*\(/);
  assert.doesNotMatch(silentCapture, /prisma\.candidate\.(?:create|upsert|update|updateMany)\s*\(/);
  assert.equal(manifest.rules.allowArbitraryCandidatePatch, false);
  assert.doesNotMatch(manifest.transitionFamilies.map((family) => family.id).join('|'), /generic|arbitrary|patch/i);
});

test('la documentación registra la fase multilinea y mantiene el siguiente slice acotado', () => {
  const documentation = readSource('docs/architecture/candidate-state-transition-inventory.md');
  assert.match(documentation, /config\/candidate-progress-authority\.json/);
  assert.match(documentation, /Fase 1: caracterización del progreso conversacional/);
  assert.match(documentation, /Fase 2: autoridad multilinea migrada/);
  assert.match(documentation, /scheduleCandidateMultilineWindow/);
  assert.match(documentation, /acquireCandidateMultilineBatch/);
  assert.match(documentation, /conversationEngine\.act\(\)/);
  assert.match(documentation, /productor de decisión/i);
  assert.match(documentation, /escritor efectivo/i);
});
