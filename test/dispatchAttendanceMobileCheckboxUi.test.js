import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sourceView = fs.readFileSync('src/views/operacionesClienteOperaciones.ejs', 'utf8');
const sharedCss = fs.readFileSync('src/public/operaciones-ui.css', 'utf8');

test('los checkboxes de asistencia conservan ancho propio y permiten envolver el texto en móvil', () => {
  assert.match(sharedCss, /input,\s*\nselect,\s*\ntextarea\s*\{[\s\S]*?width:\s*100%/);
  assert.match(
    sourceView,
    /\.attendance-map-form \.field label\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;[^}]*\}/
  );
  assert.match(
    sourceView,
    /\.attendance-map-form \.field label > input\[type="checkbox"\]\s*\{[^}]*width:\s*18px;[^}]*min-width:\s*18px;[^}]*height:\s*18px;[^}]*padding:\s*0;[^}]*\}/
  );

  for (const field of ['attendanceEnabled', 'crossOperationAttendanceAllowed', 'manualAttendanceAllowed']) {
    assert.match(sourceView, new RegExp(`type="checkbox"\\s+name="${field}"`));
  }

  assert.match(
    sourceView,
    /Permitir que los auxiliares asignados a esta operación marquen desde otras operaciones registradas/
  );
});
