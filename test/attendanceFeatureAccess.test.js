import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENDANCE_RECRUITER_GENERAL_FLAG_KEY,
  getRecruiterGeneralAttendanceEnabled,
  resolveAttendanceFeatureAccess,
  setRecruiterGeneralAttendanceEnabled
} from '../src/services/attendanceFeatureAccess.js';

function flagPrisma(value = null) {
  return {
    botKnowledge: {
      async findUnique() {
        return value === null ? null : { value };
      }
    }
  };
}

test('missing temporary flag denies recruiter-general by default', async () => {
  const prisma = {
    ...flagPrisma(null),
    appUser: {
      async findUnique() {
        return { id: 'user-1', role: 'ADMIN', isActive: true };
      }
    }
  };

  const access = await resolveAttendanceFeatureAccess(prisma, {
    userRole: 'admin',
    username: 'reclutador-general'
  });

  assert.equal(access.allowed, false);
  assert.equal(access.recruiterGeneralEnabled, false);
  assert.equal(access.reason, 'recruiter_general_disabled');
});

test('dev always has access while seeing the current recruiter-general flag', async () => {
  const access = await resolveAttendanceFeatureAccess(flagPrisma('true'), {
    userRole: 'dev',
    username: 'devloginpro'
  });

  assert.deepEqual(access, {
    allowed: true,
    recruiterGeneralEnabled: true,
    reason: 'dev'
  });
});

test('only exact active recruiter-general can use an enabled flag', async () => {
  const prisma = {
    ...flagPrisma(' TRUE '),
    appUser: {
      async findUnique({ where }) {
        assert.deepEqual(where, { username: 'reclutador-general' });
        return { id: 'user-1', role: 'ADMIN', isActive: true };
      }
    }
  };

  const access = await resolveAttendanceFeatureAccess(prisma, {
    userRole: 'admin',
    username: 'reclutador-general'
  });

  assert.equal(access.allowed, true);
  assert.equal(access.reason, 'recruiter_general_enabled');
});

test('another recruiter stays denied even when the flag is enabled', async () => {
  let userLookupCalled = false;
  const prisma = {
    ...flagPrisma('true'),
    appUser: {
      async findUnique() {
        userLookupCalled = true;
        return { id: 'user-2', role: 'ADMIN', isActive: true };
      }
    }
  };

  const access = await resolveAttendanceFeatureAccess(prisma, {
    userRole: 'admin',
    username: 'reclutador-bogota'
  });

  assert.equal(access.allowed, false);
  assert.equal(access.reason, 'role_not_allowed');
  assert.equal(userLookupCalled, false);
});

test('inactive recruiter-general stays denied', async () => {
  const prisma = {
    ...flagPrisma('true'),
    appUser: {
      async findUnique() {
        return { id: 'user-1', role: 'ADMIN', isActive: false };
      }
    }
  };

  const access = await resolveAttendanceFeatureAccess(prisma, {
    userRole: 'admin',
    username: 'reclutador-general'
  });

  assert.equal(access.allowed, false);
});

test('stored flag accepts only explicit true text', async () => {
  assert.equal(await getRecruiterGeneralAttendanceEnabled(flagPrisma('true')), true);
  assert.equal(await getRecruiterGeneralAttendanceEnabled(flagPrisma('1')), false);
  assert.equal(await getRecruiterGeneralAttendanceEnabled(flagPrisma('yes')), false);
  assert.equal(await getRecruiterGeneralAttendanceEnabled(flagPrisma('false')), false);
});

test('only a dev actor can change the temporary access', async () => {
  await assert.rejects(
    () => setRecruiterGeneralAttendanceEnabled({ $transaction() {} }, {
      enabled: true,
      actorRole: 'admin'
    }),
    /attendance_access_dev_required/
  );
});

test('setter requires an explicit boolean', async () => {
  await assert.rejects(
    () => setRecruiterGeneralAttendanceEnabled({ $transaction() {} }, {
      enabled: 'true',
      actorRole: 'dev'
    }),
    /attendance_access_enabled_boolean_required/
  );
});

test('dev toggle persists the flag and creates an audit event atomically', async () => {
  const calls = [];
  const tx = {
    appUser: {
      async findUnique() {
        return { id: 'user-1', username: 'reclutador-general', role: 'ADMIN', isActive: true };
      }
    },
    botKnowledge: {
      async findUnique({ where }) {
        assert.deepEqual(where, { key: ATTENDANCE_RECRUITER_GENERAL_FLAG_KEY });
        return { value: 'false' };
      },
      async upsert(input) {
        calls.push(['upsert', input]);
        return input;
      }
    },
    devAuditEvent: {
      async create(input) {
        calls.push(['audit', input]);
        return input;
      }
    }
  };
  const prisma = {
    async $transaction(operation) {
      calls.push(['transaction']);
      return operation(tx);
    }
  };

  const result = await setRecruiterGeneralAttendanceEnabled(prisma, {
    enabled: true,
    actorUsername: 'devloginpro',
    actorRole: 'dev',
    actorSource: 'env',
    ipAddress: '127.0.0.1',
    method: 'POST',
    path: '/admin/operaciones/asistencia-acceso/reclutador-general'
  });

  assert.equal(result.enabled, true);
  assert.equal(result.previousEnabled, false);
  assert.equal(calls[0][0], 'transaction');
  assert.equal(calls[1][0], 'upsert');
  assert.equal(calls[1][1].create.value, 'true');
  assert.equal(calls[2][0], 'audit');
  assert.equal(calls[2][1].data.action, 'ATTENDANCE_RECRUITER_GENERAL_ENABLED');
  assert.deepEqual(calls[2][1].data.fromValue, { enabled: false });
  assert.deepEqual(calls[2][1].data.toValue, { enabled: true });
});
