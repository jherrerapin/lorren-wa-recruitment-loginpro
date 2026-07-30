import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { saveDevTestAttendance } from '../src/services/dispatchDevPayrollTest.js';
import { setTestWorkspaceFeatureAccess } from '../src/services/testWorkspaceFeatureAccess.js';

test('un usuario inactivo no puede recibir el permiso del entorno de pruebas', async () => {
  const prisma = {
    appUser: {
      findUnique: async () => ({
        id: 'user-inactive',
        username: 'usuario-inactivo',
        role: 'ADMIN',
        isActive: false
      })
    },
    devAuditEvent: {
      findFirst: async () => null,
      create: async () => {
        throw new Error('no_debe_auditar_permiso_inactivo');
      }
    }
  };

  await assert.rejects(() => setTestWorkspaceFeatureAccess(prisma, {
    actorRole: 'dev',
    actorUsername: 'devloginpro',
    targetUserId: 'user-inactive',
    enabled: true
  }), /test_workspace_access_user_not_found/);
});

test('una asignación con estado operativo no puede recibir jornada manual de prueba', async () => {
  let transactionCalled = false;
  const prisma = {
    dispatchAssignment: {
      findUnique: async () => ({
        id: 'assignment-operational',
        status: 'CONFIRMED',
        worker: {
          id: 'worker-real',
          operationalStatus: 'DISPONIBLE',
          isTestProfile: false
        },
        serviceRequest: {
          id: 'request-test',
          source: 'DEV_TEST',
          serviceDate: new Date('2026-07-29T05:00:00.000Z'),
          startTime: '08:00',
          endTime: '16:00',
          operationPoint: {
            clientId: 'client-real',
            client: { id: 'client-real' }
          }
        }
      })
    },
    $transaction: async () => {
      transactionCalled = true;
    }
  };

  await assert.rejects(() => saveDevTestAttendance(prisma, {
    assignmentId: 'assignment-operational',
    arrivalAt: '2026-07-29T08:00',
    breakStartAt: '',
    breakEndAt: '',
    departureAt: '2026-07-29T16:00'
  }), /dev_test_assignment_not_found/);
  assert.equal(transactionCalled, false);
});

test('la Nómina completa y el WhatsApp secundario permanecen exclusivamente para DEV', async () => {
  const route = await readFile('src/routes/dispatchDevPayrollTest.js', 'utf8');
  assert.match(route, /canOpenOperationalPayroll: role === 'dev'/);
  assert.match(route, /canUseTestWhatsapp: role === 'dev'/);
  assert.match(route, /router\.get\('\/whatsapp', requireDev/);
  assert.match(route, /router\.post\('\/whatsapp\/enviar', requireDev/);
  assert.doesNotMatch(route, /canOpenOperationalPayroll: role === 'dev' \|\|/);
});

test('retirar una asignación exige solicitud y estado DEV_TEST válidos', async () => {
  const route = await readFile('src/routes/dispatchDevPayrollTest.js', 'utf8');
  assert.match(route, /assignment\.serviceRequest\?\.source !== DEV_TEST_REQUEST_SOURCE/);
  assert.match(route, /!ACTIVE_DEV_TEST_ASSIGNMENT_STATUSES\.includes\(assignment\.status\)/);
});
