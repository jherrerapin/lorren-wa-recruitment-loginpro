import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const root = process.cwd();
const canonicalName = 'Gestión de Tiempo';
const oldAccentedLower = `${String.fromCharCode(0x6e)}${String.fromCharCode(0xf3)}mina`;
const oldAccentedTitle = `${oldAccentedLower[0].toUpperCase()}${oldAccentedLower.slice(1)}`;
const oldAccentedUpper = oldAccentedLower.toUpperCase();
const oldAscii = String.fromCharCode(0x6e, 0x6f, 0x6d, 0x69, 0x6e, 0x61);
const oldCamel = `${oldAscii[0].toUpperCase()}${oldAscii.slice(1)}`;
const oldUpper = oldAscii.toUpperCase();
const textExtensions = new Set([
  '.cjs', '.css', '.ejs', '.env', '.html', '.js', '.json', '.md', '.mjs', '.prisma', '.sh', '.sql', '.svg', '.txt', '.yaml', '.yml'
]);
const rootTextFiles = new Set(['.env.example', '.gitignore', 'AGENTS.md', 'README.md', 'package.json']);

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function isTextFile(repoPath) {
  return textExtensions.has(extname(repoPath)) || rootTextFiles.has(repoPath);
}

function renamedPath(repoPath) {
  return repoPath
    .replace(new RegExp(`${oldCamel}(?!tim)`, 'g'), 'GestionTiempo')
    .replace(new RegExp(`${oldUpper}(?!TIM)`, 'g'), 'GESTION_TIEMPO')
    .replace(new RegExp(`(^|[/_.-])${oldAscii}(?=$|[/_.-])`, 'g'), '$1gestion-tiempo');
}

function replaceProductTerminology(content) {
  let next = content
    .split(oldAccentedUpper).join('GESTIÓN DE TIEMPO')
    .split(oldAccentedTitle).join(canonicalName)
    .split(oldAccentedLower).join(canonicalName)
    .split(`Asistencia y ${canonicalName}`).join(canonicalName)
    .replace(new RegExp(`${oldCamel}(?!tim)`, 'g'), 'GestionTiempo')
    .replace(new RegExp(`${oldUpper}(?!TIM)`, 'g'), 'GESTION_TIEMPO');

  next = next.replace(new RegExp(`(^|[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ])${oldAscii}(?=$|[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ])`, 'gm'), (match, prefix) => `${prefix}gestion-tiempo`);
  return next;
}

function removeLegacyRouteAuthority(repoPath, content) {
  let next = content;

  if (repoPath === 'src/routes/dispatchAttendanceAdmin.js') {
    next = next
      .replace(/^const PAYROLL_LEGACY_ROUTE = .*\n/m, '')
      .replace(/\nexport function legacyPayrollRedirectTarget\(req = \{\}\) \{[\s\S]*?\n\}\n\nfunction validAttendanceEvidenceKey/, '\nfunction validAttendanceEvidenceKey')
      .replace(/\n\s*router\.use\(PAYROLL_LEGACY_ROUTE, \(req, res\) => \{[\s\S]*?\n\s*\}\);/m, '');
  }

  if (repoPath === 'src/services/adminNavigation.js') {
    next = next
      .replace(/^const LEGACY_PAYROLL_PATH = .*\n/m, '')
      .replace(/\s*\|\|\s*path\.startsWith\(LEGACY_PAYROLL_PATH\)/g, '')
      .replace(/\nfunction normalizePayrollPresentation\(html\) \{[\s\S]*?\n\}\n\nfunction normalizePayrollPaths\(html\) \{[\s\S]*?\n\}\n/, '\n')
      .replace('  const normalizedHtml = normalizePayrollPaths(html);', '  const normalizedHtml = html;');
  }

  if (repoPath === 'src/routes/dispatchBridge.js') {
    next = next
      .replace(/^const LEGACY_PAYROLL_PATH = .*\n/m, '')
      .replace(/\s*\|\|\s*path\.startsWith\(LEGACY_PAYROLL_PATH\)/g, '');
  }

  if (repoPath === 'src/services/dispatchAuditMiddleware.js') {
    const canonical = '/admin/operaciones/asistencia/gestion-tiempo';
    next = next.replace(
      `path.startsWith('${canonical}') || path.startsWith('${canonical}')`,
      `path.startsWith('${canonical}')`
    );
  }

  return next;
}

function replaceNavigationRegression(repoPath, content) {
  if (repoPath !== 'test/payrollNavigationLabelRegression.test.js') return content;
  return `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n\nfunction source(path) {\n  return readFileSync(new URL(\`../\${path}\`, import.meta.url), 'utf8');\n}\n\ntest('Gestión de Tiempo conserva una sola ruta canónica sin redirect heredado', () => {\n  const attendanceRoute = source('src/routes/dispatchAttendanceAdmin.js');\n  const navigation = source('src/services/adminNavigation.js');\n  const bridge = source('src/routes/dispatchBridge.js');\n  const audit = source('src/services/dispatchAuditMiddleware.js');\n\n  assert.match(attendanceRoute, /PAYROLL_CANONICAL_ROUTE = '\\/gestion-tiempo'/);\n  assert.doesNotMatch(attendanceRoute, /legacyPayrollRedirectTarget|PAYROLL_LEGACY_ROUTE/);\n  assert.doesNotMatch(navigation, /LEGACY_PAYROLL_PATH|normalizePayrollPaths/);\n  assert.doesNotMatch(bridge, /LEGACY_PAYROLL_PATH/);\n  assert.match(audit, /asistencia\\/gestion-tiempo/);\n});\n\ntest('las vistas y exportaciones usan el nombre canónico del módulo', () => {\n  const mainView = source('src/views/operacionesGestionTiempo.ejs');\n  const exportView = source('src/views/operacionesGestionTiempoExport.ejs');\n  const testView = source('src/views/operacionesPruebasGestionTiempo.ejs');\n\n  for (const content of [mainView, exportView, testView]) {\n    assert.match(content, /Gestión de Tiempo|gestion-tiempo/);\n  }\n});\n`;
}

const originalFiles = trackedFiles();
const renames = originalFiles
  .map((repoPath) => [repoPath, renamedPath(repoPath)])
  .filter(([from, to]) => from !== to)
  .sort((a, b) => b[0].length - a[0].length);

for (const [from, to] of renames) {
  const fromAbs = resolve(root, from);
  const toAbs = resolve(root, to);
  if (!existsSync(fromAbs)) continue;
  execFileSync('git', ['mv', '--', from, to], { cwd: root, stdio: 'inherit' });
  console.log(`renamed ${from} -> ${to}`);
}

for (const repoPath of trackedFiles()) {
  if (!isTextFile(repoPath)) continue;
  const absolute = resolve(root, repoPath);
  if (!existsSync(absolute)) continue;
  const original = readFileSync(absolute, 'utf8');
  let next = replaceProductTerminology(original);
  next = removeLegacyRouteAuthority(repoPath, next);
  next = replaceNavigationRegression(repoPath, next);
  if (next !== original) {
    writeFileSync(absolute, next, 'utf8');
    console.log(`updated ${repoPath}`);
  }
}

console.log('time-management terminology codemod complete');
