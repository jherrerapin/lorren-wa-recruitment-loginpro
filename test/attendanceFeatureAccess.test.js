import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENDANCE_ACCESS_DISABLED_ACTION,
  ATTENDANCE_ACCESS_ENABLED_ACTION,
  ATTENDANCE_ACCESS_ENTITY_LABEL,
  ATTENDANCE_ACCESS_ENTITY_TYPE,
  getRecruiterGeneralAttendanceEnabled,
  resolveAttendanceFeatureAccess,
  setRecruiterGeneralAttendanceEnabled
} from '../src/services/attendanceFeatureAccess.js';

function accessEventPrisma(event = null) {
  return {
    devAuditEvent: {
      async findFirst() {
        return event;
      }
    }
  };
}

test('missing temporary access event denies recruiter-general by default', async () => {
  const prisma = {
    ...accessEventPrisma(null),
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

test('dev always has access while seeing the current recruiter-general state', async () => {
  const access = await resolveAttendanceFeatureAccess(
    accessEventPrisma({ action: ATTENDANCE_ACCESS_ENABLED_ACTION }),
    { userRole: 'dev', username: 'devloginpro' }
  );

  assert.deepEqual(access, {
    allowed: true,
    recruiterGeneralEnabled: true,
    reason: 'dev'
  });
});

test('only exact active recruiter-general can use an enabled event', async () => {
  const prisma = {
    ...accessEventPrisma({ action: ATTENDANCE_ACCESS_ENABLED_ACTION }),
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

test('another recruiter stays denied even when the feature is enabled', async () => {
  let userLookupCalled = false;
  let eventLookupCalled = false;
  const prisma = {
    devAuditEvent: {
      async findFirst() {
        eventLookupCalled = true;
        return { action: ATTENDANCE_ACCESS_ENABLED_ACTION };
      }
    },
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
  assert.equal(eventLookupCalled, false);
});

test('inactive recruiter-general stays denied', async () => {
  const prisma = {
    ...accessEventPrisma({ action: ATTENDANCE_ACCESS_ENABLED_ACTION }),
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

test('latest enable and disable events resolve deterministically', async () => {
  assert.equal(
    await getRecruiterGeneralAttendanceEnabled(
      accessEventPrisma({ action: ATTENDANCE_ACCESS_ENABLED_ACTION })
    ),
    true
  );
  assert.equal(
    await getRecruiterGeneralAttendanceEnabled(
      accessEventPrisma({ action: ATTENDANCE_ACCESS_DISABLED_ACTION })
    ),
    false
  );
  assert.equal(await getRecruiterGeneralAttendanceEnabled(accessEventPrisma(null)), false);
});

test('access query uses only the dedicated audited feature event family', async () => {
  const prisma = {
    devAuditEvent: {
      async findFirst(query) {
        assert.deepEqual(query.where, {
          entityType: ATTENDANCE_ACCESS_ENTITY_TYPE,
          entityLabel: ATTENDANCE_ACCESS_ENTITY_LABEL,
          action: {
            in: [ATTENDANCE_ACCESS_ENABLED_ACTION, ATTENDANCE_ACCESS_DISABLED_ACTION]
          }
        });
        assert.deepEqual(query.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
        return null;
      }
    }
  };

  assert.equal(await getRecruiterGeneralAttendanceEnabled(prisma), false);
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

test('dev toggle appends a new audit event atomically', async () => {
  const calls = [];
  const tx = {
    appUser: {
      async findUnique() {
        return { id: 'user-1', username: 'reclutador-general', role: 'ADMIN', isActive: true };
      }
    },
    devAuditEvent: {
      async findFirst() {
        return { action: ATTENDANCE_ACCESS_DISABLED_ACTION };
      },
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
  assert.equal(calls[1][0], 'audit');
  assert.equal(calls[1][1].data.action, ATTENDANCE_ACCESS_ENABLED_ACTION);
  assert.deepEqual(calls[1][1].data.fromValue, { enabled: false });
  assert.deepEqual(calls[1][1].data.toValue, { enabled: true });
  assert.equal(calls[1][1].data.metadata.targetUsername, 'reclutador-general');
  assert.equal(calls[1][1].data.metadata.temporaryFeatureGate, true);
});
