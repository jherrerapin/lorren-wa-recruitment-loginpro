import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const tempFiles = [
  'scripts/apply-time-management-cleanup.mjs',
  '.github/workflows/time-management-cleanup.yml'
];
const renames = [
  ['docs/architecture/22_nomina_tiempo_trabajado.md', 'docs/architecture/22_gestion-tiempo_tiempo_trabajado.md'],
  ['docs/architecture/23_pruebas_dev_nomina.md', 'docs/architecture/23_pruebas_dev_gestion-tiempo.md'],
  ['src/public/operaciones-nomina.css', 'src/public/operaciones-gestion-tiempo.css'],
  ['src/views/operacionesNomina.ejs', 'src/views/operacionesGestionTiempo.ejs'],
  ['src/views/operacionesNominaExport.ejs', 'src/views/operacionesGestionTiempoExport.ejs'],
  ['src/views/operacionesPruebasNomina.ejs', 'src/views/operacionesPruebasGestionTiempo.ejs'],
  ['src/views/partials/operacionesNominaTabla.ejs', 'src/views/partials/operacionesGestionTiempoTabla.ejs']
];

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

for (const [from, to] of renames) {
  if (fs.existsSync(path.join(root, from))) {
    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    git('mv', from, to);
  }
}

const skipDirs = new Set(['.git', 'node_modules']);
function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function protectProvider(source) {
  const values = [];
  const text = source.replace(/Nominatim/gi, (match) => {
    const marker = `__LORREN_GEOCODER_${values.length}__`;
    values.push([marker, match]);
    return marker;
  });
  return { text, values };
}

function restoreProvider(source, values) {
  let text = source;
  for (const [marker, original] of values) text = text.replaceAll(marker, original);
  return text;
}

function transformText(source) {
  const protectedProvider = protectProvider(source);
  let text = protectedProvider.text
    .replace(/Asistencia y Gestión de Tiempo/g, 'Gestión de Tiempo')
    .replace(/asistencia y gestión de tiempo/g, 'gestión de tiempo')
    .replace(/Nómina y tiempo trabajado/g, 'Gestión de Tiempo')
    .replace(/nómina y tiempo trabajado/g, 'gestión de tiempo')
    .replace(/operacionesNomina/g, 'operacionesGestionTiempo')
    .replace(/operaciones-nomina/g, 'operaciones-gestion-tiempo')
    .replace(/\/nomina(?=\/|\?|$)/g, '/gestion-tiempo')
    .replace(/\bNÓMINA\b/g, 'GESTIÓN DE TIEMPO')
    .replace(/\bNómina\b/g, 'Gestión de Tiempo')
    .replace(/\bnómina\b/g, 'gestión de tiempo')
    .replace(/\bNOMINA\b/g, 'GESTION_TIEMPO')
    .replace(/\bNomina\b/g, 'GestionTiempo')
    .replace(/\bnomina\b/g, 'gestion-tiempo');
  return restoreProvider(text, protectedProvider.values);
}

for (const file of filesUnder(root)) {
  const rel = path.relative(root, file).replaceAll('\\', '/');
  if (tempFiles.includes(rel)) continue;
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (source.includes('\u0000')) continue;
  const next = transformText(source);
  if (next !== source) fs.writeFileSync(file, next, 'utf8');
}

function edit(rel, mutate) {
  const file = path.join(root, rel);
  const source = fs.readFileSync(file, 'utf8');
  const next = mutate(source);
  if (next === source) throw new Error(`No se aplicó la consolidación esperada en ${rel}`);
  fs.writeFileSync(file, next, 'utf8');
}

edit('src/routes/dispatchAttendanceAdmin.js', (source) => source
  .replace(/^const PAYROLL_LEGACY_ROUTE = .*\n/m, '')
  .replace(/^const PAYROLL_CANONICAL_PATH = .*\n/m, '')
  .replace(/\nexport function legacyPayrollRedirectTarget\(req = \{\}\) \{[\s\S]*?\n\}\n\nfunction validAttendanceEvidenceKey/, '\nfunction validAttendanceEvidenceKey')
  .replace(/\n  router\.use\(PAYROLL_LEGACY_ROUTE, \(req, res\) => \{[\s\S]*?\n  \}\);\n  router\.use\(PAYROLL_CANONICAL_ROUTE, dispatchPayrollRouter\(prisma\)\);/, '\n  router.use(PAYROLL_CANONICAL_ROUTE, dispatchPayrollRouter(prisma));'));

edit('src/routes/dispatchBridge.js', (source) => source
  .replace(/^const LEGACY_PAYROLL_PATH = .*\n/m, '')
  .replace(/return path\.startsWith\(PAYROLL_PATH\) \|\| path\.startsWith\(LEGACY_PAYROLL_PATH\);/, 'return path.startsWith(PAYROLL_PATH);'));

edit('src/services/adminNavigation.js', (source) => source
  .replace(/^const LEGACY_PAYROLL_PATH = .*\n/m, '')
  .replace(/if \(path\.startsWith\(PAYROLL_PATH\) \|\| path\.startsWith\(LEGACY_PAYROLL_PATH\)\) return 'payroll';/, "if (path.startsWith(PAYROLL_PATH)) return 'payroll';")
  .replace(/return path\.startsWith\(`\$\{PAYROLL_PATH\}\/api\/`\) \|\| path\.startsWith\(`\$\{LEGACY_PAYROLL_PATH\}\/api\/`\);/, 'return path.startsWith(`${PAYROLL_PATH}/api/`);'));

edit('src/services/dispatchAuditMiddleware.js', (source) => source
  .replace("path.startsWith('/admin/operaciones/asistencia/gestion-tiempo') || path.startsWith('/admin/operaciones/asistencia/gestion-tiempo')", "path.startsWith('/admin/operaciones/asistencia/gestion-tiempo')"));

const terminologyTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenAccent = String.fromCharCode(110, 243, 109, 105, 110, 97);
const forbiddenAscii = String.fromCharCode(110, 111, 109, 105, 110, 97);
const canonicalName = 'Gestión de Tiempo';
const canonicalRoute = '/admin/operaciones/asistencia/gestion-tiempo';
const skipDirs = new Set(['.git', 'node_modules']);

function repoFiles(dir = root) {
  return readdirSync(dir).flatMap((name) => {
    if (skipDirs.has(name)) return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? repoFiles(full) : [full];
  });
}

function searchableText(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return text.includes('\\u0000') ? null : text;
  } catch {
    return null;
  }
}

function hasRemovedTerm(value) {
  const clean = String(value).replace(/Nominatim/gi, '');
  return new RegExp('\\\\b' + forbiddenAccent + '\\\\b', 'i').test(clean)
    || new RegExp('\\\\b' + forbiddenAscii + '\\\\b', 'i').test(clean)
    || clean.includes('Nomina')
    || clean.includes('NOMINA');
}

test('el repositorio versionado no conserva la terminología española retirada', () => {
  const offenders = [];
  for (const file of repoFiles()) {
    const rel = path.relative(root, file).replaceAll('\\\\', '/');
    const text = searchableText(file);
    if (hasRemovedTerm(rel) || (text != null && hasRemovedTerm(text))) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('las superficies canónicas usan únicamente Gestión de Tiempo', () => {
  const navigation = readFileSync(path.join(root, 'src/services/adminNavigation.js'), 'utf8');
  const attendance = readFileSync(path.join(root, 'src/routes/dispatchAttendanceAdmin.js'), 'utf8');
  const payroll = readFileSync(path.join(root, 'src/routes/dispatchPayroll.js'), 'utf8');
  assert.ok(navigation.includes(canonicalName));
  assert.ok(navigation.includes(canonicalRoute));
  assert.match(attendance, /PAYROLL_CANONICAL_ROUTE = '\\/gestion-tiempo'/);
  assert.doesNotMatch(attendance, /PAYROLL_LEGACY_ROUTE|legacyPayrollRedirectTarget/);
  assert.match(payroll, /operacionesGestionTiempo/);
  assert.doesNotMatch(payroll, /Asistencia y Gestión de Tiempo/);
});
`;
fs.writeFileSync(path.join(root, 'test/timeManagementPresentationTerminology.test.js'), terminologyTest, 'utf8');

const navRegression = `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const attendanceSource = readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
const navigationSource = readFileSync(new URL('../src/services/adminNavigation.js', import.meta.url), 'utf8');
const payrollSource = readFileSync(new URL('../src/routes/dispatchPayroll.js', import.meta.url), 'utf8');

test('Gestión de Tiempo tiene una sola ruta y autoridad de navegación', () => {
  assert.match(attendanceSource, /PAYROLL_CANONICAL_ROUTE = '\\/gestion-tiempo'/);
  assert.doesNotMatch(attendanceSource, /PAYROLL_LEGACY_ROUTE|legacyPayrollRedirectTarget|redirect\\(308/);
  assert.match(navigationSource, /PAYROLL_PATH = '\\/admin\\/operaciones\\/asistencia\\/gestion-tiempo'/);
  assert.doesNotMatch(navigationSource, /LEGACY_PAYROLL_PATH/);
  assert.match(navigationSource, /menuLink\\(PAYROLL_PATH, 'Gestión de Tiempo'\\)/);
  assert.match(payrollSource, /operacionesGestionTiempo/);
});
`;
fs.writeFileSync(path.join(root, 'test/payrollNavigationLabelRegression.test.js'), navRegression, 'utf8');

const ciPath = path.join(root, '.github/workflows/ci.yml');
let ci = fs.readFileSync(ciPath, 'utf8');
if (!ci.includes('test/timeManagementPresentationTerminology.test.js')) {
  const before = 'node --test test/adminSession.test.js test/liveSearchTypeaheadContracts.test.js';
  const after = before + ' test/timeManagementPresentationTerminology.test.js';
  if (!ci.includes(before)) throw new Error('No se encontró el quick job esperado de CI');
  ci = ci.replace(before, after);
  fs.writeFileSync(ciPath, ci, 'utf8');
}

for (const rel of tempFiles) {
  const file = path.join(root, rel);
  if (fs.existsSync(file)) fs.rmSync(file);
}

const forbiddenAccent = String.fromCharCode(110, 243, 109, 105, 110, 97);
const forbiddenAscii = String.fromCharCode(110, 111, 109, 105, 110, 97);
function hasRemovedTerm(value) {
  const clean = String(value).replace(/Nominatim/gi, '');
  return new RegExp(`\\b${forbiddenAccent}\\b`, 'i').test(clean)
    || new RegExp(`\\b${forbiddenAscii}\\b`, 'i').test(clean)
    || clean.includes('Nomina')
    || clean.includes('NOMINA');
}
const leftovers = [];
for (const file of filesUnder(root)) {
  const rel = path.relative(root, file).replaceAll('\\', '/');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;
  if (hasRemovedTerm(rel) || hasRemovedTerm(text)) leftovers.push(rel);
}
if (leftovers.length) {
  console.error('Terminología heredada restante:', [...new Set(leftovers)].sort());
  process.exit(2);
}

console.log('Consolidación terminológica aplicada.');
