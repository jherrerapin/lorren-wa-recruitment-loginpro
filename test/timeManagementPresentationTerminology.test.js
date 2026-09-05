import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'coverage',
  '.ci-baseline',
  '.ci-baseline-results'
]);
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.ejs', '.env', '.html', '.js', '.json', '.md', '.mjs', '.prisma', '.sh', '.sql', '.svg', '.txt', '.yaml', '.yml'
]);
const ROOT_TEXT_FILES = new Set(['.env.example', '.gitignore', 'AGENTS.md', 'README.md', 'package.json']);
const LEGACY_ACCENTED_WORD = `${String.fromCharCode(0x6e)}${String.fromCharCode(0xf3)}mina`;
const LEGACY_ASCII_TOKEN = String.fromCharCode(0x6e, 0x6f, 0x6d, 0x69, 0x6e, 0x61);
const LEGACY_CAMEL_TOKEN = `${LEGACY_ASCII_TOKEN[0].toUpperCase()}${LEGACY_ASCII_TOKEN.slice(1)}`;
const LEGACY_UPPER_TOKEN = LEGACY_ASCII_TOKEN.toUpperCase();
const PRODUCT_NAME = 'Gestión de Tiempo';
const LEGACY_COMPOUND_PRODUCT_NAME = ['Asistencia y', PRODUCT_NAME].join(' ');
const LEGACY_ROUTE_COMPATIBILITY_FILES = new Set([
  'src/routes/dispatchAttendanceAdmin.js',
  'src/routes/dispatchBridge.js',
  'src/services/dispatchAuditMiddleware.js',
  'test/payrollNavigationLabelRegression.test.js'
]);

function collectTextFiles(directory = REPO_ROOT) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    const absolute = join(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...collectTextFiles(absolute));
      continue;
    }
    const repoPath = relative(REPO_ROOT, absolute).replaceAll('\\', '/');
    if (TEXT_EXTENSIONS.has(extname(entry)) || ROOT_TEXT_FILES.has(repoPath)) files.push({ absolute, repoPath });
  }
  return files;
}

function contentForTerminologyScan(repoPath, content) {
  if (!LEGACY_ROUTE_COMPATIBILITY_FILES.has(repoPath)) return content;
  return content.split(LEGACY_ASCII_TOKEN).join('legacy-time-route');
}

function contentViolations(content) {
  const violations = [];
  if (content.toLocaleLowerCase('es').includes(LEGACY_ACCENTED_WORD)) violations.push('término visible heredado');
  if (content.includes(LEGACY_COMPOUND_PRODUCT_NAME)) violations.push('nombre compuesto anterior del módulo');

  const asciiPatterns = [
    new RegExp(`/${LEGACY_ASCII_TOKEN}(?=[/?#'\\"\\s]|$)`),
    new RegExp(`['\\"]${LEGACY_ASCII_TOKEN}['\\"]`),
    new RegExp(`${LEGACY_CAMEL_TOKEN}(?!tim)`),
    new RegExp(`${LEGACY_UPPER_TOKEN}(?!TIM)`),
    new RegExp(`(?:^|[_-])${LEGACY_ASCII_TOKEN}(?:$|[_\\-.])`, 'm')
  ];
  if (asciiPatterns.some((pattern) => pattern.test(content))) violations.push('identificador o ruta heredada');
  return violations;
}

function pathViolations(repoPath) {
  const normalized = repoPath.replaceAll('\\', '/');
  const patterns = [
    new RegExp(`(?:^|[/_-])${LEGACY_ASCII_TOKEN}(?:$|[._/-])`, 'i'),
    new RegExp(`${LEGACY_CAMEL_TOKEN}(?!tim)`),
    new RegExp(`${LEGACY_UPPER_TOKEN}(?!TIM)`)
  ];
  return patterns.some((pattern) => pattern.test(normalized)) ? ['nombre de archivo heredado'] : [];
}

test('todo el repositorio usa Gestión de Tiempo como nomenclatura canónica', () => {
  const violations = [];
  for (const file of collectTextFiles()) {
    const content = readFileSync(file.absolute, 'utf8');
    const scanContent = contentForTerminologyScan(file.repoPath, content);
    const reasons = [...pathViolations(file.repoPath), ...contentViolations(scanContent)];
    if (reasons.length > 0) violations.push(`${file.repoPath}: ${[...new Set(reasons)].join(', ')}`);
  }

  assert.deepEqual(
    violations,
    [],
    `Se encontraron referencias funcionales anteriores a ${PRODUCT_NAME}:\n${violations.join('\n')}`
  );
});

test('las superficies principales nombran el módulo exactamente como Gestión de Tiempo', () => {
  const navigation = readFileSync(join(REPO_ROOT, 'src/services/adminNavigation.js'), 'utf8');
  const route = readFileSync(join(REPO_ROOT, 'src/routes/dispatchAttendanceAdmin.js'), 'utf8');
  assert.match(navigation, new RegExp(PRODUCT_NAME));
  assert.match(route, /gestion-tiempo/);
  assert.doesNotMatch(navigation, new RegExp(LEGACY_COMPOUND_PRODUCT_NAME));
});


test('la excepción técnica histórica queda cerrada al redirect, acceso y auditoría', () => {
  const legacySegment = LEGACY_ASCII_TOKEN;
  const legacyPath = `/admin/operaciones/asistencia/${legacySegment}`;
  const attendance = readFileSync(join(REPO_ROOT, 'src/routes/dispatchAttendanceAdmin.js'), 'utf8');
  const bridge = readFileSync(join(REPO_ROOT, 'src/routes/dispatchBridge.js'), 'utf8');
  const audit = readFileSync(join(REPO_ROOT, 'src/services/dispatchAuditMiddleware.js'), 'utf8');
  const navigation = readFileSync(join(REPO_ROOT, 'src/services/adminNavigation.js'), 'utf8');

  assert.ok(attendance.includes(`PAYROLL_LEGACY_ROUTE = '/${legacySegment}'`));
  assert.match(attendance, /res\.redirect\(308, legacyPayrollRedirectTarget\(req\)\)/);
  assert.ok(bridge.includes(`LEGACY_PAYROLL_PATH = '${legacyPath}'`));
  assert.match(bridge, /path\.startsWith\(PAYROLL_PATH\) \|\| path\.startsWith\(LEGACY_PAYROLL_PATH\)/);
  assert.ok(audit.includes(legacyPath));
  assert.doesNotMatch(navigation, /LEGACY_PAYROLL_PATH|normalizePayrollPaths/);
});
