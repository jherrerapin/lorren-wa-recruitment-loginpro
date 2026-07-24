import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repositoryRoot, 'src');
const manifestPath = path.join(repositoryRoot, 'docs', 'architecture', 'state-authority-manifest.json');
const reportPath = path.join(repositoryRoot, 'state-authority-observed.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const VALID_MIGRATION_STAGES = new Set(['fragmented', 'consolidating', 'canonical']);
const VALID_ROLES = new Set(['admin', 'boundary', 'canonical', 'integration', 'legacy', 'operational']);
const RAW_OPERATION_BY_VERB = Object.freeze({
  DELETE: 'rawDelete',
  INSERT: 'rawInsert',
  UPDATE: 'rawUpdate'
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePath(value) {
  return String(value || '').split(path.sep).join('/');
}

function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) files.push(...collectJavaScriptFiles(absolutePath));
    else if (stats.isFile() && entry.endsWith('.js')) files.push(absolutePath);
  }
  return files;
}

function removeComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function collectDelegateWrites(source, relativePath) {
  const trackedModels = Object.keys(manifest.models);
  const modelPattern = trackedModels.map(escapeRegex).join('|');
  const operationPattern = manifest.trackedOperations.map(escapeRegex).join('|');
  const writePattern = new RegExp(
    `\\b[A-Za-z_$][\\w$]*\\s*(?:\\?\\.|\\.)\\s*(${modelPattern})\\s*(?:\\?\\.|\\.)\\s*(${operationPattern})\\s*\\(`,
    'g'
  );
  const writes = [];

  for (const match of source.matchAll(writePattern)) {
    writes.push({
      path: relativePath,
      model: match[1],
      operation: match[2],
      line: lineNumberAt(source, match.index),
      access: 'delegate'
    });
  }
  return writes;
}

function collectRawSqlWrites(source, relativePath) {
  const modelByTableName = new Map(
    Object.entries(manifest.models).map(([model, contract]) => [contract.tableName.toLowerCase(), model])
  );
  const tablePattern = [...modelByTableName.keys()].map(escapeRegex).join('|');
  const rawMutationPattern = new RegExp(
    `\\b(UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+["'\\x60]?(${tablePattern})["'\\x60]?`,
    'gi'
  );
  const writes = [];

  for (const match of source.matchAll(rawMutationPattern)) {
    const verb = match[1].split(/\s+/)[0].toUpperCase();
    writes.push({
      path: relativePath,
      model: modelByTableName.get(match[2].toLowerCase()),
      operation: RAW_OPERATION_BY_VERB[verb],
      line: lineNumberAt(source, match.index),
      access: 'rawSql'
    });
  }
  return writes;
}

function collectStateWrites() {
  const writes = [];

  for (const absolutePath of collectJavaScriptFiles(sourceRoot)) {
    const relativePath = normalizePath(path.relative(repositoryRoot, absolutePath));
    const source = removeComments(readFileSync(absolutePath, 'utf8'));
    writes.push(...collectDelegateWrites(source, relativePath));
    writes.push(...collectRawSqlWrites(source, relativePath));
  }

  return writes;
}

function writersByModel(writes) {
  const result = new Map();
  for (const write of writes) {
    if (!result.has(write.model)) result.set(write.model, new Map());
    const paths = result.get(write.model);
    if (!paths.has(write.path)) paths.set(write.path, new Set());
    paths.get(write.path).add(write.operation);
  }
  return result;
}

function serializableObservedWriters(observed) {
  return Object.fromEntries(
    [...observed.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([model, paths]) => [
        model,
        Object.fromEntries(
          [...paths.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([writerPath, operations]) => [writerPath, [...operations].sort()])
        )
      ])
  );
}

function writeDiagnosticReport(writes, observed) {
  const declared = Object.fromEntries(
    Object.entries(manifest.models).map(([model, contract]) => [
      model,
      contract.writers.map((writer) => writer.path).sort()
    ])
  );
  writeFileSync(reportPath, `${JSON.stringify({ declared, observed: serializableObservedWriters(observed), writes }, null, 2)}\n`);
}

function formatObservedWriters(paths = new Map()) {
  return [...paths.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([writerPath, operations]) => `${writerPath} [${[...operations].sort().join(', ')}]`)
    .join('\n');
}

function isExistingFile(absolutePath) {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

const observedWrites = collectStateWrites();
const observedByModel = writersByModel(observedWrites);
writeDiagnosticReport(observedWrites, observedByModel);

test('el manifiesto de autoridades declara contratos completos y válidos', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.trackedOperations) && manifest.trackedOperations.length > 0);
  assert.ok(manifest.models && typeof manifest.models === 'object');

  const tableNames = new Set();
  for (const [model, contract] of Object.entries(manifest.models)) {
    assert.ok(contract.domain, `${model}: falta domain`);
    assert.ok(contract.targetAuthority, `${model}: falta targetAuthority`);
    assert.ok(contract.tableName?.trim(), `${model}: falta tableName para detectar SQL directo`);
    assert.ok(!tableNames.has(contract.tableName.toLowerCase()), `${model}: tableName duplicado ${contract.tableName}`);
    tableNames.add(contract.tableName.toLowerCase());
    assert.ok(VALID_MIGRATION_STAGES.has(contract.migrationStage), `${model}: migrationStage inválido`);
    assert.ok(Array.isArray(contract.writers) && contract.writers.length > 0, `${model}: falta writers`);

    const paths = new Set();
    for (const writer of contract.writers) {
      assert.ok(writer.path?.startsWith('src/'), `${model}: writer.path debe estar dentro de src`);
      assert.ok(VALID_ROLES.has(writer.role), `${model}:${writer.path}: role inválido`);
      assert.ok(writer.reason?.trim(), `${model}:${writer.path}: falta reason`);
      assert.ok(!paths.has(writer.path), `${model}: writer duplicado ${writer.path}`);
      paths.add(writer.path);
    }

    const canonicalWriters = contract.writers.filter((writer) => writer.role === 'canonical');
    assert.ok(canonicalWriters.length <= 1, `${model}: no puede declarar más de una autoridad canónica`);
    if (contract.migrationStage === 'canonical') {
      assert.equal(canonicalWriters.length, 1, `${model}: un modelo canónico debe declarar exactamente una autoridad`);
    }
  }
});

test('el scanner detecta alias arbitrarios, optional chaining y formato multilínea', () => {
  const source = `
    await prismaClient
      ?.candidate
      ?.update({ where: { id: 'TEST-ID' }, data: {} });

    await customDatabase
      .interviewBooking
      .create({ data: {} });
  `;
  const writes = collectDelegateWrites(source, 'src/synthetic.js');

  assert.deepEqual(
    writes.map(({ model, operation, access }) => ({ model, operation, access })),
    [
      { model: 'candidate', operation: 'update', access: 'delegate' },
      { model: 'interviewBooking', operation: 'create', access: 'delegate' }
    ]
  );
});

test('el scanner detecta mutaciones SQL directas y omite consultas de lectura', () => {
  const source = `
    await prisma.$executeRaw\`UPDATE "Candidate" SET "status" = 'NUEVO'\`;
    await prisma.$queryRaw\`INSERT INTO "Message" ("id") VALUES ('TEST-ID') RETURNING *\`;
    await tx.$executeRaw\`DELETE FROM "InterviewSlot" WHERE "id" = 'TEST-ID'\`;
    await prisma.$queryRaw\`SELECT * FROM "Candidate"\`;
  `;
  const writes = collectRawSqlWrites(source, 'src/synthetic-raw.js');

  assert.deepEqual(
    writes.map(({ model, operation, access }) => ({ model, operation, access })),
    [
      { model: 'candidate', operation: 'rawUpdate', access: 'rawSql' },
      { model: 'message', operation: 'rawInsert', access: 'rawSql' },
      { model: 'interviewSlot', operation: 'rawDelete', access: 'rawSql' }
    ]
  );
});

test('ningún archivo escribe estado de alto riesgo fuera del manifiesto', () => {
  for (const [model, contract] of Object.entries(manifest.models)) {
    const declaredPaths = new Set(contract.writers.map((writer) => writer.path));
    const observedPaths = observedByModel.get(model) || new Map();
    const undeclared = [...observedPaths.keys()].filter((writerPath) => !declaredPaths.has(writerPath));

    assert.deepEqual(
      undeclared,
      [],
      `${model}: escritores no declarados:\n${formatObservedWriters(new Map(undeclared.map((writerPath) => [writerPath, observedPaths.get(writerPath)])))}`
    );
  }
});

test('el manifiesto no conserva escritores obsoletos o inexistentes', () => {
  for (const [model, contract] of Object.entries(manifest.models)) {
    const observedPaths = observedByModel.get(model) || new Map();
    for (const writer of contract.writers) {
      const absolutePath = path.join(repositoryRoot, writer.path);
      assert.ok(isExistingFile(absolutePath), `${model}: archivo declarado inexistente ${writer.path}`);
      assert.ok(
        observedPaths.has(writer.path),
        `${model}: ${writer.path} está declarado pero no contiene una escritura Prisma o SQL rastreable`
      );
    }
  }
});
