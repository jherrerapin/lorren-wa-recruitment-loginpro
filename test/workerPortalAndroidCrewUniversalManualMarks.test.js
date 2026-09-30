import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(path, 'utf8');

test('UI manual de auxiliar usa su memberMarkType en cualquier etapa', async () => {
  const source = await read('mobile/android/app/src/main/assets/native-presence.js');
  assert.doesNotMatch(source, /memberMarkType === 'ARRIVAL'[\s\S]{0,500}nativePresenceManualArrival/);
  assert.match(source, /memberMarkType[\s\S]{0,220}!member\.isLeader[\s\S]{0,220}status === 'PENDING'/);
  assert.match(source, /normalizedMark !== memberMarkType/);
  assert.match(source, /dataset\.nativePresenceManualMarkType = memberMarkType/);
  assert.match(source, /markMemberManually\(member, memberMarkType\)/);
  assert.match(source, /startManualMark\(member, memberMarkType\)/);
  assert.match(source, /markType: normalizedMark/);
  assert.match(source, /normalizeMarkType\(detail\.markType\) !== pending\.markType/);
  assert.match(source, /markType: pending\.markType/);
});

test('backend expone marca manual genérica sin falsear proof BLE', async () => {
  const [route, domain] = await Promise.all([
    read('src/routes/workerPortal.js'),
    read('src/modules/dispatch-attendance/application/registerCrewArrival.js')
  ]);
  assert.match(route, /router\.post\('\/cuadrillas\/presencia\/marca-manual'/);
  assert.match(route, /markType = normalizeBiometricMarkType\(req\.body\?\.markType\)/);
  assert.match(route, /manualTargetAssignmentId: targetAssignmentId/);
  assert.match(route, /presenceValidated: false/);
  assert.match(route, /markType === 'ARRIVAL'[\s\S]{0,220}registerCrewPresenceMarkFn/);
  assert.match(domain, /const targetedManualMark = Boolean\(manualTargetAssignmentId\)/);
  assert.match(domain, /selectedMembers = \[targetMember\]/);
});
