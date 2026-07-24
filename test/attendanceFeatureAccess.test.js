import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAttendanceFeatureAccess } from '../src/services/attendanceFeatureAccess.js';

test('DEV siempre conserva acceso sin consultar usuarios', async () => {
  const access = await resolveAttendanceFeatureAccess({}, { userRole: 'dev', username: 'devloginpro' });
  assert.deepEqual(access, { allowed: true, reason: 'dev' });
});

test('un rol distinto de ADMIN o DEV queda denegado', async () => {
  let queried = false;
  const prisma = { appUser: { async findUnique() { queried = true; } } };
  const access = await resolveAttendanceFeatureAccess(prisma, { userRole: 'viewer', username: 'consulta' });
  assert.deepEqual(access, { allowed: false, reason: 'role_not_allowed' });
  assert.equal(queried, false);
});

test('ADMIN sin identidad queda denegado por defecto', async () => {
  const access = await resolveAttendanceFeatureAccess({}, { userRole: 'admin' });
  assert.deepEqual(access, { allowed: false, reason: 'user_not_identified' });
});

test('ADMIN activo con permiso individual puede entrar', async () => {
  const prisma = {
    appUser: {
      async findUnique(query) {
        assert.deepEqual(query, {
          where: { username: 'reclutador-bogota' },
          select: { id: true, role: true, isActive: true, canAccessAttendance: true }
        });
        return { id: 'u1', role: 'ADMIN', isActive: true, canAccessAttendance: true };
      }
    }
  };
  const access = await resolveAttendanceFeatureAccess(prisma, {
    userRole: 'admin',
    username: 'reclutador-bogota'
  });
  assert.deepEqual(access, { allowed: true, reason: 'user_permission_enabled' });
});

test('ADMIN activo sin permiso individual queda denegado', async () => {
  const prisma = {
    appUser: { async findUnique() { return { id: 'u1', role: 'ADMIN', isActive: true, canAccessAttendance: false }; } }
  };
  const access = await resolveAttendanceFeatureAccess(prisma, { userRole: 'admin', username: 'reclutador-general' });
  assert.deepEqual(access, { allowed: false, reason: 'user_permission_disabled' });
});

test('un usuario inactivo queda denegado aunque conserve el permiso', async () => {
  const prisma = {
    appUser: { async findUnique() { return { id: 'u1', role: 'ADMIN', isActive: false, canAccessAttendance: true }; } }
  };
  const access = await resolveAttendanceFeatureAccess(prisma, { userRole: 'admin', username: 'reclutador-general' });
  assert.deepEqual(access, { allowed: false, reason: 'user_not_active' });
});

test('un ADMIN inexistente queda denegado', async () => {
  const prisma = { appUser: { async findUnique() { return null; } } };
  const access = await resolveAttendanceFeatureAccess(prisma, { userRole: 'admin', username: 'desconocido' });
  assert.deepEqual(access, { allowed: false, reason: 'user_not_found' });
});

test('la autoridad falla cerrada si falta el repositorio de usuarios', async () => {
  await assert.rejects(
    () => resolveAttendanceFeatureAccess({}, { userRole: 'admin', username: 'reclutador-general' }),
    /attendance_access_appUser_findUnique_required/
  );
});
