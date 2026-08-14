import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CLIENT_ROOTS = ['src/public', 'src/views'];

// Deuda heredada inventariada en #1023. Esta lista es un ratchet: puede reducirse,
// pero ningún archivo nuevo puede usar diálogos nativos del navegador.
const LEGACY_NATIVE_DIALOG_FILES = new Set([
  'src/public/assignment-template-sync.js',
  'src/public/attendance-map-reliability.js',
  'src/public/dispatch-assignment-board.js',
  'src/public/ui-cleanup-2606.js',
  'src/views/botKnowledge.ejs',
  'src/views/detail.ejs',
  'src/views/locations.ejs',
  'src/views/operacionesAsignaciones.ejs',
  'src/views/operacionesAsignacionesConfirmacion.ejs',
  'src/views/operacionesClienteOperaciones.ejs',
  'src/views/operacionesClientes.ejs',
  'src/views/operacionesSolicitudesResumen.ejs',
  'src/views/operacionesWhatsappEstado.ejs',
  'src/views/operacionesWhatsappMonitor.ejs',
  'src/views/outreachApproved.ejs',
  'src/views/vacancies.ejs'
]);

const NATIVE_WINDOW_REFERENCE = /\b(?:window|globalThis)\s*\.\s*(?:alert|confirm|prompt)\b/;
const NATIVE_WINDOW_BRACKET_REFERENCE = /\b(?:window|globalThis)\s*\[\s*['"](?:alert|confirm|prompt)['"]\s*\]/;
const NATIVE_BARE_CALL = /(?<![\w$.])(?:alert|confirm|prompt)\s*\(/;

function sourceFiles(relativeRoot) {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  const files = [];
  for (const entry of readdirSync(absoluteRoot)) {
    const absolute = path.join(absoluteRoot, entry);
    const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
    if (statSync(absolute).isDirectory()) files.push(...sourceFiles(relative));
    else if (/\.(?:js|ejs)$/.test(entry)) files.push(relative);
  }
  return files;
}

function containsNativeBrowserDialog(source) {
  return NATIVE_WINDOW_REFERENCE.test(source)
    || NATIVE_WINDOW_BRACKET_REFERENCE.test(source)
    || NATIVE_BARE_CALL.test(source);
}

test('archivos cliente nuevos no pueden introducir alert, confirm o prompt nativos', () => {
  const violations = [];
  for (const file of CLIENT_ROOTS.flatMap(sourceFiles)) {
    if (LEGACY_NATIVE_DIALOG_FILES.has(file)) continue;
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    if (containsNativeBrowserDialog(source)) violations.push(file);
  }

  assert.deepEqual(
    violations,
    [],
    `Diálogos nativos prohibidos. Usa /public/lorren-dialog.js o un toast diseñado. Archivos: ${violations.join(', ')}`
  );
});

test('Asistencia y eliminación de solicitudes usan la autoridad visual común', () => {
  const dialog = readFileSync(path.join(ROOT, 'src/public/lorren-dialog.js'), 'utf8');
  const attendance = readFileSync(path.join(ROOT, 'src/public/attendance-admin-clear-marks.js'), 'utf8');
  const serviceDelete = readFileSync(path.join(ROOT, 'src/public/service-request-delete-confirm.js'), 'utf8');

  assert.match(dialog, /window\.LorrenDialog = Object\.freeze/);
  assert.match(dialog, /role', 'alertdialog'/);
  assert.match(dialog, /aria-modal/);
  assert.match(attendance, /window\.LorrenDialog/);
  assert.match(serviceDelete, /LorrenDialog\?\.confirm/);

  for (const [name, source] of [['Asistencia', attendance], ['eliminación de solicitudes', serviceDelete]]) {
    assert.equal(containsNativeBrowserDialog(source), false, `${name} no puede usar diálogos nativos`);
  }
});
