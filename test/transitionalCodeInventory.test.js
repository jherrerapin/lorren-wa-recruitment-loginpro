import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { FEATURE_FLAG_DEFAULTS } from '../src/services/featureFlags.js';

const inventoryPath = 'config/transitional-code-inventory.json';
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const trackedEnvironmentFlag = /^(?:FF_[A-Z0-9_]+|USE_[A-Z0-9_]*ENGINE[A-Z0-9_]*)$/;

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function walkJavaScriptFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJavaScriptFiles(entryPath));
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      files.push(entryPath.replaceAll('\\', '/'));
    }
  }
  return files;
}

function addMatches(source, pattern, observed) {
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (trackedEnvironmentFlag.test(name)) observed.add(name);
  }
}

function collectObservedFeatureFlags() {
  const observed = new Set(Object.keys(FEATURE_FLAG_DEFAULTS));
  for (const filePath of walkJavaScriptFiles('src')) {
    const source = readSource(filePath);
    addMatches(source, /isFeatureEnabled\(\s*['"]([A-Z0-9_]+)['"]/g, observed);
    addMatches(source, /process\.env\.([A-Z0-9_]+)/g, observed);
    addMatches(source, /process\.env\s*\[\s*['"]([A-Z0-9_]+)['"]\s*\]/g, observed);
  }
  return [...observed].filter((name) => trackedEnvironmentFlag.test(name)).sort();
}

function assertPathExists(filePath, context) {
  assert.equal(fs.existsSync(filePath), true, `${context}: no existe ${filePath}`);
}

function extractFunctionSource(source, functionName) {
  const signature = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = signature.exec(source);
  assert.ok(match, `No se encontró la función inventariada ${functionName}`);

  const openingBrace = source.indexOf('{', source.indexOf(')', match.index) + 1);
  assert.notEqual(openingBrace, -1, `No se encontró el cuerpo de ${functionName}`);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`Cuerpo incompleto para ${functionName}`);
}

function assertCommonEntry(entry, label) {
  assert.ok(entry.status, `${label} no declara status`);
  assert.ok(inventory.rules.allowedStatuses.includes(entry.status), `${label} usa status inválido: ${entry.status}`);
  assert.ok(String(entry.owner || '').trim(), `${label} no declara owner`);
  assert.ok(String(entry.purpose || '').trim(), `${label} no declara purpose`);
  assert.ok(String(entry.retirementCondition || '').trim(), `${label} no declara retirementCondition`);
  assert.ok(Array.isArray(entry.evidenceTests), `${label} no declara evidenceTests`);

  for (const testPath of entry.evidenceTests) {
    assertPathExists(testPath, `${label} referencia evidencia inexistente`);
  }

  if (entry.status === 'RETIRABLE') {
    assert.ok(entry.evidenceTests.length > 0, `${label} no puede ser RETIRABLE sin pruebas`);
    assert.ok(String(entry.retirementEvidence || '').trim(), `${label} no puede ser RETIRABLE sin retirementEvidence`);
  }
}

test('el inventario declara un esquema bloqueante y no habilita cambios de runtime', () => {
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.issue, 578);
  assert.equal(inventory.programIssue, 570);
  assert.equal(inventory.rules.runtimeChangesAllowed, false);
  assert.equal(inventory.rules.genderLogicInScope, false);
  assert.equal(inventory.rules.retirableRequiresEvidence, true);
  assert.deepEqual(inventory.rules.allowedStatuses, ['ACTIVE', 'TRANSITIONAL', 'RETIRABLE', 'BLOCKED']);
});

test('todos los feature flags usados en src están inventariados y no hay entradas fantasma', () => {
  const inventoryNames = inventory.featureFlags.map((entry) => entry.name).sort();
  assert.equal(new Set(inventoryNames).size, inventoryNames.length, 'Hay feature flags duplicados en el inventario');
  assert.deepEqual(
    collectObservedFeatureFlags(),
    inventoryNames,
    'Aparecieron o desaparecieron feature flags sin actualizar config/transitional-code-inventory.json'
  );
});

test('cada feature flag declara definición, consumidores, default, propietario y retiro', () => {
  for (const entry of inventory.featureFlags) {
    const label = `Feature flag ${entry.name}`;
    assertCommonEntry(entry, label);
    assert.ok(trackedEnvironmentFlag.test(entry.name), `${label} no cumple la convención rastreada`);
    assert.equal(typeof entry.runtimeDefault, 'boolean', `${label} no declara runtimeDefault booleano`);
    assert.ok(Array.isArray(entry.definitionPaths) && entry.definitionPaths.length > 0, `${label} no declara definitionPaths`);
    assert.ok(Array.isArray(entry.consumerPaths), `${label} no declara consumerPaths`);
    assert.ok(Array.isArray(entry.configurationPaths), `${label} no declara configurationPaths`);

    for (const definitionPath of entry.definitionPaths) {
      assertPathExists(definitionPath, label);
      assert.match(readSource(definitionPath), new RegExp(`\\b${entry.name}\\b`), `${label} ya no existe en ${definitionPath}`);
    }
    for (const consumerPath of entry.consumerPaths) {
      assertPathExists(consumerPath, label);
      assert.match(readSource(consumerPath), new RegExp(`\\b${entry.name}\\b`), `${label} ya no es consumido en ${consumerPath}`);
    }
    for (const configurationPath of entry.configurationPaths) {
      assertPathExists(configurationPath, label);
      assert.match(readSource(configurationPath), new RegExp(`\\b${entry.name}\\b`), `${label} ya no está configurado en ${configurationPath}`);
    }

    if (entry.kind === 'canonical_feature_flag') {
      assert.equal(Object.hasOwn(FEATURE_FLAG_DEFAULTS, entry.name), true, `${label} no está en FEATURE_FLAG_DEFAULTS`);
      assert.equal(FEATURE_FLAG_DEFAULTS[entry.name], entry.runtimeDefault, `${label} tiene un default distinto al inventario`);
    } else if (entry.name === 'USE_CONVERSATION_ENGINE') {
      const definition = readSource(entry.definitionPaths[0]);
      assert.match(
        definition,
        /const\s+USE_CONVERSATION_ENGINE\s*=\s*process\.env\.USE_CONVERSATION_ENGINE\s*===\s*['"]true['"]/,
        `${label} cambió su definición inline sin actualizar el inventario`
      );
      assert.equal(entry.runtimeDefault, false);
    }
  }
});

test('los aliases transitorios existen, apuntan al símbolo declarado y no adquieren política silenciosa', () => {
  const expectedSymbols = [...inventory.rules.trackedAliasSymbols].sort();
  const inventorySymbols = inventory.aliases.map((entry) => entry.symbol).sort();
  assert.deepEqual(inventorySymbols, expectedSymbols);
  assert.equal(new Set(inventorySymbols).size, inventorySymbols.length, 'Hay aliases duplicados en el inventario');

  for (const entry of inventory.aliases) {
    const label = `Alias ${entry.symbol}`;
    assertCommonEntry(entry, label);
    assert.ok(['pure_alias', 'alias_chain', 'wrapper_with_transformation'].includes(entry.kind), `${label} usa kind inválido`);
    assertPathExists(entry.definitionPath, label);
    assertPathExists(entry.targetPath, label);

    const definitionSource = readSource(entry.definitionPath);
    const targetSource = readSource(entry.targetPath);
    const functionSource = extractFunctionSource(definitionSource, entry.symbol);
    assert.match(targetSource, new RegExp(`\\b${entry.targetSymbol}\\b`), `${label} apunta a un target inexistente`);

    if (entry.kind === 'pure_alias' || entry.kind === 'alias_chain') {
      const escapedTarget = entry.targetSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(
        functionSource,
        new RegExp(`^function\\s+${entry.symbol}\\s*\\([^)]*\\)\\s*\\{\\s*return\\s+${escapedTarget}\\s*\\([\\s\\S]*\\);?\\s*\\}$`),
        `${label} dejó de ser un alias puro; debe reclasificarse antes de añadir política`
      );
    }
  }
});
