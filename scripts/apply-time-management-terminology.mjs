import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

function restoreLegacyRouteCompatibility(repoPath, content) {
  const legacyRoute = `/${oldAscii}`;
  const legacyPath = `/admin/operaciones/asistencia/${oldAscii}`;
  const canonicalPath = '/admin/operaciones/asistencia/gestion-tiempo';
  let next = content;

  if (repoPath === 'src/routes/dispatchAttendanceAdmin.js') {
    if (!next.includes('const PAYROLL_LEGACY_ROUTE =')) {
      next = next.replace(
        "const PAYROLL_CANONICAL_ROUTE = '/gestion-tiempo';\n",
        `const PAYROLL_CANONICAL_ROUTE = '/gestion-tiempo';\nconst PAYROLL_LEGACY_ROUTE = '${legacyRoute}';\n`
      );
    }
    if (!next.includes('export function legacyPayrollRedirectTarget')) {
      const helper = `export function legacyPayrollRedirectTarget(req = {}) {\n  const rawUrl = String(req.url || '/');\n  const queryIndex = rawUrl.indexOf('?');\n  const rawPath = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;\n  const query = queryIndex >= 0 ? rawUrl.slice(queryIndex) : '';\n  const suffix = rawPath === '/' ? '' : rawPath;\n  return \`${canonicalPath}\${suffix}\${query}\`;\n}\n\n`;
      next = next.replace('function validAttendanceEvidenceKey(value) {', `${helper}function validAttendanceEvidenceKey(value) {`);
    }
    if (!next.includes('router.use(PAYROLL_LEGACY_ROUTE')) {
      const redirect = `  // Compatibilidad histórica únicamente: redirige al router canónico; no monta una segunda autoridad.\n  router.use(PAYROLL_LEGACY_ROUTE, (req, res) => {\n    applyNoStore(res);\n    return res.redirect(308, legacyPayrollRedirectTarget(req));\n  });\n`;
      next = next.replace('  router.use(PAYROLL_CANONICAL_ROUTE, dispatchPayrollRouter(prisma));', `${redirect}  router.use(PAYROLL_CANONICAL_ROUTE, dispatchPayrollRouter(prisma));`);
    }
  }

  if (repoPath === 'src/routes/dispatchBridge.js') {
    if (!next.includes('const LEGACY_PAYROLL_PATH =')) {
      next = next.replace(
        `const PAYROLL_PATH = '${canonicalPath}';\n`,
        `const PAYROLL_PATH = '${canonicalPath}';\nconst LEGACY_PAYROLL_PATH = '${legacyPath}';\n`
      );
    }
    next = next.replace(
      'return path.startsWith(PAYROLL_PATH);',
      'return path.startsWith(PAYROLL_PATH) || path.startsWith(LEGACY_PAYROLL_PATH);'
    );
  }

  if (repoPath === 'src/services/dispatchAuditMiddleware.js') {
    next = next.replace(
      `if (path.startsWith('${canonicalPath}')) {`,
      `if (path.startsWith('${canonicalPath}') || path.startsWith('${legacyPath}')) {`
    );
    next = next.replace(
      "if (path.includes('/gestion-tiempo')) return 'DISPATCH_PAYROLL_CHANGE';",
      `if (path.includes('/gestion-tiempo') || path.includes('${legacyRoute}')) return 'DISPATCH_PAYROLL_CHANGE';`
    );
  }

  return next;
}

function replaceNavigationRegression(repoPath, content) {
  if (repoPath !== 'test/payrollNavigationLabelRegression.test.js') return content;
  const legacyPath = `/admin/operaciones/asistencia/${oldAscii}`;
  return `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport express from 'express';\nimport { readFile } from 'node:fs/promises';\nimport { ADMIN_MODULE_PATHS } from '../src/services/adminNavigation.js';\nimport { dispatchAttendanceAdminRouter, legacyPayrollRedirectTarget } from '../src/routes/dispatchAttendanceAdmin.js';\n\nconst TIME_MANAGEMENT_PATH = '/admin/operaciones/asistencia/gestion-tiempo';\nconst LEGACY_TIME_MANAGEMENT_PATH = '${legacyPath}';\n\nasync function source(path) {\n  return readFile(new URL(\`../\${path}\`, import.meta.url), 'utf8');\n}\n\nasync function withServer(app, run) {\n  const server = app.listen(0, '127.0.0.1');\n  await new Promise((resolve, reject) => {\n    server.once('listening', resolve);\n    server.once('error', reject);\n  });\n  const address = server.address();\n  const origin = \`http://127.0.0.1:\${address.port}\`;\n  try {\n    await run(origin);\n  } finally {\n    await new Promise((resolve) => server.close(resolve));\n  }\n}\n\ntest('Gestión de Tiempo usa una sola ruta pública canónica en vistas y navegación', async () => {\n  const [mainView, exportView, testWorkspaceView] = await Promise.all([\n    source('src/views/operacionesGestionTiempo.ejs'),\n    source('src/views/operacionesGestionTiempoExport.ejs'),\n    source('src/views/operacionesPruebasGestionTiempo.ejs')\n  ]);\n\n  assert.equal(ADMIN_MODULE_PATHS.payroll, TIME_MANAGEMENT_PATH);\n  for (const rawView of [mainView, exportView, testWorkspaceView]) {\n    assert.match(rawView, new RegExp(TIME_MANAGEMENT_PATH.replaceAll('/', '\\\\/')));\n    assert.doesNotMatch(rawView, new RegExp(LEGACY_TIME_MANAGEMENT_PATH.replaceAll('/', '\\\\/')));\n  }\n});\n\ntest('el alias histórico redirige 308 a Gestión de Tiempo sin crear otra autoridad', async () => {\n  assert.equal(legacyPayrollRedirectTarget({ url: '/' }), TIME_MANAGEMENT_PATH);\n  assert.equal(\n    legacyPayrollRedirectTarget({ url: '/?periodType=CUSTOM&from=2026-08-01' }),\n    \`\${TIME_MANAGEMENT_PATH}?periodType=CUSTOM&from=2026-08-01\`\n  );\n  assert.equal(\n    legacyPayrollRedirectTarget({ url: '/export.xlsx?download=1' }),\n    \`\${TIME_MANAGEMENT_PATH}/export.xlsx?download=1\`\n  );\n\n  const app = express();\n  app.use('/admin/operaciones/asistencia', dispatchAttendanceAdminRouter({}));\n  await withServer(app, async (origin) => {\n    const response = await fetch(\`\${origin}\${LEGACY_TIME_MANAGEMENT_PATH}/export.xlsx?download=1\`, { redirect: 'manual' });\n    assert.equal(response.status, 308);\n    assert.equal(response.headers.get('location'), \`\${TIME_MANAGEMENT_PATH}/export.xlsx?download=1\`);\n  });\n});\n\ntest('la compatibilidad histórica queda limitada a routing, permisos y auditoría', async () => {\n  const [attendance, bridge, audit, navigation] = await Promise.all([\n    source('src/routes/dispatchAttendanceAdmin.js'),\n    source('src/routes/dispatchBridge.js'),\n    source('src/services/dispatchAuditMiddleware.js'),\n    source('src/services/adminNavigation.js')\n  ]);\n\n  assert.match(attendance, /PAYROLL_LEGACY_ROUTE/);\n  assert.match(bridge, /LEGACY_PAYROLL_PATH/);\n  assert.match(audit, /gestion-tiempo/);\n  assert.doesNotMatch(navigation, /LEGACY_PAYROLL_PATH|normalizePayrollPaths/);\n});\n`;
}

function fixTransformedRegressions(repoPath, content) {
  let next = content;
  if (repoPath === 'test/adminModuleNavigation.test.js') {
    next = next
      .replace('  assert.doesNotMatch(payroll, /\\/admin\\/operaciones\\/asistencia\\/gestion-tiempo/);\n', '')
      .replace('  assert.doesNotMatch(payroll, />Gestión de Tiempo<|>Gestión de Tiempo y tiempo trabajado</);\n', '');
  }
  if (repoPath === 'docs/product/plan_tecnico_asistencia_operativa.md') {
    next = next.replace('- preGestión de Tiempo;', '- preliquidación de tiempos;');
  }
  return next;
}

function allowDocumentedLegacyCompatibilityInScanner(repoPath, content) {
  if (repoPath !== 'test/timeManagementPresentationTerminology.test.js') return content;
  let next = content;
  if (!next.includes('LEGACY_ROUTE_COMPATIBILITY_COUNTS')) {
    next = next.replace(
      "const LEGACY_COMPOUND_PRODUCT_NAME = ['Asistencia y', PRODUCT_NAME].join(' ');\n",
      "const LEGACY_COMPOUND_PRODUCT_NAME = ['Asistencia y', PRODUCT_NAME].join(' ');\nconst LEGACY_ROUTE_COMPATIBILITY_COUNTS = new Map([\n  ['src/routes/dispatchAttendanceAdmin.js', 1],\n  ['src/routes/dispatchBridge.js', 1],\n  ['src/services/dispatchAuditMiddleware.js', 2],\n  ['test/payrollNavigationLabelRegression.test.js', 1]\n]);\n"
    );
    next = next.replace(
      'function contentViolations(content) {',
      "function contentForTerminologyScan(repoPath, content) {\n  const expectedLegacyRouteReferences = LEGACY_ROUTE_COMPATIBILITY_COUNTS.get(repoPath) || 0;\n  const actualLegacyRouteReferences = content.split(LEGACY_ASCII_TOKEN).length - 1;\n  assert.equal(\n    actualLegacyRouteReferences,\n    expectedLegacyRouteReferences,\n    `${repoPath}: cambió la cantidad documentada de referencias a la ruta histórica`\n  );\n  return expectedLegacyRouteReferences > 0\n    ? content.split(LEGACY_ASCII_TOKEN).join('legacy-time-route')\n    : content;\n}\n\nfunction contentViolations(content) {"
    );
    next = next.replace(
      "    const content = readFileSync(file.absolute, 'utf8');\n    const reasons = [...pathViolations(file.repoPath), ...contentViolations(content)];",
      "    const content = readFileSync(file.absolute, 'utf8');\n    const scanContent = contentForTerminologyScan(file.repoPath, content);\n    const reasons = [...pathViolations(file.repoPath), ...contentViolations(scanContent)];"
    );
  }
  return next;
}

function wireTerminologyRegressionIntoCi(repoPath, content) {
  if (repoPath !== '.github/workflows/ci.yml') return content;
  const current = 'node --test test/adminSession.test.js test/liveSearchTypeaheadContracts.test.js';
  const desired = `${current} test/timeManagementPresentationTerminology.test.js`;
  return content.includes(desired) ? content : content.replace(current, desired);
}

const originalFiles = trackedFiles();
const renames = originalFiles
  .map((repoPath) => [repoPath, renamedPath(repoPath)])
  .filter(([from, to]) => from !== to)
  .sort((a, b) => b[0].length - a[0].length);

for (const [from, to] of renames) {
  const fromAbs = resolve(root, from);
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
  next = replaceNavigationRegression(repoPath, next);
  next = fixTransformedRegressions(repoPath, next);
  next = restoreLegacyRouteCompatibility(repoPath, next);
  next = allowDocumentedLegacyCompatibilityInScanner(repoPath, next);
  next = wireTerminologyRegressionIntoCi(repoPath, next);
  if (next !== original) {
    writeFileSync(absolute, next, 'utf8');
    console.log(`updated ${repoPath}`);
  }
}

console.log('time-management terminology codemod complete');
