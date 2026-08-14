import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateAttendanceTimelineAgainstAssignment } from '../src/modules/dispatch-attendance/application/adminAttendance.js';

test('el navegador no impone un max duplicado sobre almuerzo y salida manual', () => {
  const runtime = readFileSync(
    new URL('../src/public/attendance-admin-manual-workday.js', import.meta.url),
    'utf8'
  );
  const loader = readFileSync(
    new URL('../src/public/attendance-admin-runtime.js', import.meta.url),
    'utf8'
  );

  assert.match(loader, /attendance-admin-manual-workday\.js/);
  assert.match(runtime, /BACKEND_DATE_AUTHORITY_FIELDS/);
  assert.match(runtime, /'breakStartAt'/);
  assert.match(runtime, /'breakEndAt'/);
  assert.match(runtime, /'departureReportedAt'/);
  assert.doesNotMatch(
    runtime.match(/BACKEND_DATE_AUTHORITY_FIELDS = Object\.freeze\(\[[\s\S]*?\]\)/)?.[0] || '',
    /arrivalReportedAt/
  );
  assert.match(runtime, /removeAttribute\('max'\)/);
  assert.match(runtime, /form\[data-manual-attendance-form\]/);
});

test('el backend acepta el día siguiente únicamente cuando el turno programado cruza medianoche', () => {
  const overnightRequest = {
    serviceDate: new Date('2026-08-13T00:00:00.000Z'),
    startTime: '22:00',
    endTime: '06:00'
  };

  const overnight = validateAttendanceTimelineAgainstAssignment(overnightRequest, {
    arrivalAt: new Date('2026-08-14T03:00:00.000Z'),
    breakStartAt: new Date('2026-08-14T07:00:00.000Z'),
    breakEndAt: new Date('2026-08-14T08:30:00.000Z'),
    departureAt: new Date('2026-08-14T11:00:00.000Z')
  });

  assert.equal(overnight.serviceDateKey, '2026-08-13');
  assert.equal(overnight.latestDateKey, '2026-08-14');
  assert.equal(overnight.overnight, true);

  const daytimeRequest = {
    serviceDate: new Date('2026-08-13T00:00:00.000Z'),
    startTime: '08:00',
    endTime: '17:00'
  };

  assert.throws(
    () => validateAttendanceTimelineAgainstAssignment(daytimeRequest, {
      arrivalAt: new Date('2026-08-13T13:00:00.000Z'),
      breakStartAt: new Date('2026-08-14T07:00:00.000Z')
    }),
    /attendance_manual_mark_date_outside_assignment/
  );
});