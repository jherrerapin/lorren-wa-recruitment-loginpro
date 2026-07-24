import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../prisma/migrations/20260724040000_add_attendance_user_access/migration.sql', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
const locations = fs.readFileSync(new URL('../src/routes/locations.js', import.meta.url), 'utf8');
const audit = fs.readFileSync(new URL('../src/services/dispatchAuditMiddleware.js', import.meta.url), 'utf8');
const users = fs.readFileSync(new URL('../src/views/users.ejs', import.meta.url), 'utf8');

test('el permiso se persiste con denegación por defecto e índice', () => {
  assert.match(schema, /canAccessAttendance\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /@@index\(\[canAccessAttendance\]\)/);
  assert.match(migration, /ADD COLUMN "canAccessAttendance" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(migration, /AppUser_canAccessAttendance_idx/);
});

test('autenticación, sesión y refresco transportan el permiso', () => {
  assert.match(server, /canAccessAttendance: Boolean\(user\.canAccessAttendance\)/);
  assert.match(server, /req\.session\.canAccessAttendance = Boolean\(payload\.canAccessAttendance\)/);
  assert.match(server, /canAccessAttendance: true/);
  assert.match(audit, /canAccessAttendance: true/);
  assert.match(audit, /req\.session\.canAccessAttendance = canAccessAttendance/);
  assert.match(audit, /req\.canAccessAttendance = canAccessAttendance/);
});

test('solo DEV interpreta checkboxes de permisos al crear y editar', () => {
  assert.match(admin, /const canAccessAttendance = req\.userRole === 'dev'/);
  assert.match(admin, /canAccessDispatch = req\.userRole === 'dev'[\s\S]*canAccessAttendance/);
  assert.match(locations, /if \(req\.userRole === 'dev'\) \{[\s\S]*data\.canAccessAttendance = isChecked\(req\.body\.canAccessAttendance\)/);
  assert.match(locations, /data\.canAccessDispatch = isChecked\(req\.body\.canAccessDispatch\) \|\| data\.canAccessAttendance/);
});

test('el panel DEV permite crear y editar Asistencia como permiso individual', () => {
  assert.match(users, /role === 'dev'[\s\S]*name="canAccessAttendance"/);
  assert.match(users, /edit-canAccessAttendance-/);
  assert.match(users, /Asistencia operativa/);
  assert.match(users, /Solo DEV puede conceder o retirar estos permisos/);
  assert.match(users, /user\.canAccessAttendance/);
});
