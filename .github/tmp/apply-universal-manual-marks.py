from pathlib import Path

# --- Frontend Android native-presence.js ---
path = Path('mobile/android/app/src/main/assets/native-presence.js')
s = path.read_text()
s = s.replace("const MANUAL_ARRIVAL_PATH = '/operaciones/portal/cuadrillas/presencia/entrada-manual';", "const MANUAL_MARK_PATH = '/operaciones/portal/cuadrillas/presencia/marca-manual';")
s = s.replace('pendingManualArrival', 'pendingManualMark')

old_render = '''      if (\n        memberMarkType === 'ARRIVAL'\n        && (bluetoothFallbackActive || normalizedMark !== 'ARRIVAL')\n        && !member.isLeader\n        && status === 'PENDING'\n      ) {\n        const manualArrival = element(\n          'button',\n          'native-presence-member-action',\n          bluetoothFallbackActive ? 'Marcación Manual' : 'Marcar entrada'\n        );\n        manualArrival.type = 'button';\n        manualArrival.dataset.nativePresenceManualArrival = member.workerId;\n        manualArrival.disabled = !navigator.onLine || Boolean(pendingManualMark);\n        manualArrival.addEventListener('click', () => {\n          if (bluetoothFallbackActive) markMemberManually(member);\n          else startManualArrival(member);\n        });\n        side.appendChild(manualArrival);\n      }\n'''
new_render = '''      if (\n        memberMarkType\n        && !member.isLeader\n        && status === 'PENDING'\n        && (bluetoothFallbackActive || hasCompletedLeaderScan || normalizedMark !== memberMarkType)\n      ) {\n        const manualAction = element(\n          'button',\n          'native-presence-member-action',\n          bluetoothFallbackActive\n            ? 'Marcación Manual'\n            : `Marcar ${markInfo(memberMarkType).noun}`\n        );\n        manualAction.type = 'button';\n        manualAction.dataset.nativePresenceManualMark = member.workerId;\n        manualAction.dataset.nativePresenceManualMarkType = memberMarkType;\n        manualAction.disabled = !navigator.onLine || Boolean(pendingManualMark);\n        manualAction.addEventListener('click', () => {\n          if (bluetoothFallbackActive) markMemberManually(member, memberMarkType);\n          else startManualMark(member, memberMarkType);\n        });\n        side.appendChild(manualAction);\n      }\n'''
if old_render not in s:
    raise SystemExit('render manual ARRIVAL block not found')
s = s.replace(old_render, new_render)

start = s.index('  function markMemberManually(member) {')
end = s.index('  function publicNativeError(code) {', start)
new_manual = '''  function markMemberManually(member, markType) {\n    // El fallback entra por la ruta manual existente y nunca espera el escaneo Bluetooth.\n    startManualMark(member, markType).catch(() => {\n      setStatus('No fue posible iniciar la marcación manual.', 'error');\n    });\n  }\n\n  async function startManualMark(member, markType) {\n    const context = currentContext();\n    const normalizedMark = normalizeMarkType(markType);\n    if (\n      !context?.isCrewLeader\n      || !member\n      || member.isLeader\n      || !normalizedMark\n      || memberHasPersistedMark(member, normalizedMark)\n      || pendingManualMark\n    ) return;\n    if (!navigator.onLine) {\n      setStatus(`Conéctate para registrar ${markInfo(normalizedMark).noun}.`, 'warning');\n      return;\n    }\n    if (!credentialPrepared()) await provisionCredential();\n    const idempotencyKey = newAttemptId();\n    pendingManualMark = {\n      assignmentId: context.assignmentId,\n      serviceRequestId: context.serviceRequestId,\n      targetAssignmentId: member.assignmentId,\n      workerId: member.workerId,\n      markType: normalizedMark,\n      idempotencyKey\n    };\n    renderPanel();\n    const result = bridgeCall('requestAttendanceLocation', JSON.stringify({\n      assignmentId: context.assignmentId,\n      markType: normalizedMark,\n      idempotencyKey\n    }));\n    if (!result?.ok) {\n      pendingManualMark = null;\n      renderPanel();\n      setStatus(publicNativeError(result?.error), 'error');\n      return;\n    }\n    setStatus(`Validando ubicación para registrar ${markInfo(normalizedMark).noun}…`, 'warning');\n  }\n\n  async function submitManualMark(nativeLocationProof) {\n    const pending = pendingManualMark;\n    if (!pending) return;\n    try {\n      const response = await fetch(MANUAL_MARK_PATH, {\n        method: 'POST',\n        credentials: 'same-origin',\n        cache: 'no-store',\n        headers: {\n          Accept: 'application/json',\n          'Content-Type': 'application/json',\n          'X-Requested-With': 'worker-portal'\n        },\n        body: JSON.stringify({\n          assignmentId: pending.assignmentId,\n          serviceRequestId: pending.serviceRequestId,\n          targetAssignmentId: pending.targetAssignmentId,\n          markType: pending.markType,\n          idempotencyKey: pending.idempotencyKey,\n          nativeLocationProof\n        })\n      });\n      const payload = await response.json().catch(() => ({}));\n      if (!response.ok || payload?.ok !== true) {\n        throw new Error(String(\n          payload?.message\n          || `No fue posible registrar ${markInfo(pending.markType).noun} pendiente.`\n        ));\n      }\n      if (pending.markType === 'ARRIVAL') {\n        phoneExceptionSet(pending.serviceRequestId).delete(pending.workerId);\n      }\n      manualMarkSet(pending.serviceRequestId, pending.markType).add(pending.workerId);\n      serverStatusMap(pending.serviceRequestId, pending.markType).set(pending.workerId, 'REGISTERED');\n      contexts = await loadContexts();\n      pendingManualMark = null;\n      renderPanel();\n      setStatus(`Auxiliar marcado manualmente: ${markInfo(pending.markType).title}.`, '');\n    } catch (error) {\n      const markType = pending.markType;\n      pendingManualMark = null;\n      renderPanel();\n      setStatus(\n        error?.message || `No fue posible registrar ${markInfo(markType).noun} pendiente.`,\n        'error'\n      );\n    }\n  }\n\n'''
s = s[:start] + new_manual + s[end:]

old_ready = '''    if (type === 'attendance_location_ready') {\n      const pending = pendingManualMark;\n      if (\n        !pending\n        || String(detail.assignmentId || '') !== pending.assignmentId\n        || normalizeMarkType(detail.markType) !== 'ARRIVAL'\n        || String(detail.idempotencyKey || '') !== pending.idempotencyKey\n      ) return;\n      submitManualArrival(detail.proof).catch(() => {});\n      return;\n    }\n'''
new_ready = '''    if (type === 'attendance_location_ready') {\n      const pending = pendingManualMark;\n      if (\n        !pending\n        || String(detail.assignmentId || '') !== pending.assignmentId\n        || normalizeMarkType(detail.markType) !== pending.markType\n        || String(detail.idempotencyKey || '') !== pending.idempotencyKey\n      ) return;\n      submitManualMark(detail.proof).catch(() => {});\n      return;\n    }\n'''
if old_ready not in s:
    raise SystemExit('attendance_location_ready block not found')
s = s.replace(old_ready, new_ready)

old_err = '''        || normalizeMarkType(detail.markType) !== 'ARRIVAL'\n        || String(detail.idempotencyKey || '') !== pending.idempotencyKey\n'''
new_err = '''        || normalizeMarkType(detail.markType) !== pending.markType\n        || String(detail.idempotencyKey || '') !== pending.idempotencyKey\n'''
if old_err not in s:
    raise SystemExit('attendance_location_error mark block not found')
s = s.replace(old_err, new_err, 1)

for forbidden in ['startManualArrival(', 'submitManualArrival(', 'nativePresenceManualArrival', 'MANUAL_ARRIVAL_PATH']:
    if forbidden in s:
        raise SystemExit(f'legacy manual arrival reference remains: {forbidden}')
for required in ['startManualMark(member, memberMarkType)', 'markMemberManually(member, memberMarkType)', 'markType: pending.markType', "normalizeMarkType(detail.markType) !== pending.markType"]:
    if required not in s:
        raise SystemExit(f'universal manual mark invariant missing: {required}')
path.write_text(s)

# --- Domain: allow one explicitly targeted delegated mark without pretending BLE proof ---
path = Path('src/modules/dispatch-attendance/application/registerCrewArrival.js')
s = path.read_text()
needle = "  const presenceValidated = input.presenceValidated === true;\n  const validatedWorkerIds = presenceValidated\n"
replacement = "  const presenceValidated = input.presenceValidated === true;\n  const manualTargetAssignmentId = typeof input.manualTargetAssignmentId === 'string' && input.manualTargetAssignmentId.trim()\n    ? input.manualTargetAssignmentId.trim().slice(0, 160)\n    : null;\n  const targetedManualMark = Boolean(manualTargetAssignmentId);\n  const validatedWorkerIds = presenceValidated\n"
if needle not in s:
    raise SystemExit('registerCrewMark presence block not found')
s = s.replace(needle, replacement, 1)
needle = "  if (presenceValidated && !validatedWorkerIds.includes(leaderWorkerId)) {\n    throw new Error('crew_group_mark_leader_presence_required');\n  }\n"
replacement = "  if (presenceValidated && targetedManualMark) {\n    throw new Error('crew_group_mark_manual_target_conflict');\n  }\n  if (presenceValidated && !validatedWorkerIds.includes(leaderWorkerId)) {\n    throw new Error('crew_group_mark_leader_presence_required');\n  }\n"
s = s.replace(needle, replacement, 1)
needle = '''  const selectedWorkerSet = presenceValidated ? new Set(validatedWorkerIds) : null;\n  const selectedMembers = presenceValidated\n    ? members.filter((member) => selectedWorkerSet.has(member.workerId))\n    : members;\n'''
replacement = '''  const selectedWorkerSet = presenceValidated ? new Set(validatedWorkerIds) : null;\n  let selectedMembers = presenceValidated\n    ? members.filter((member) => selectedWorkerSet.has(member.workerId))\n    : members;\n  if (targetedManualMark) {\n    if (manualTargetAssignmentId === leaderAssignmentId) {\n      throw new Error('crew_group_mark_manual_target_invalid');\n    }\n    const targetMember = members.find((member) => member.id === manualTargetAssignmentId);\n    if (!targetMember || targetMember.workerId === leaderWorkerId) {\n      throw new Error('crew_group_mark_manual_target_not_assigned');\n    }\n    selectedMembers = [targetMember];\n  }\n'''
if needle not in s:
    raise SystemExit('selectedMembers block not found')
s = s.replace(needle, replacement, 1)
path.write_text(s)

# --- Route: keep legacy arrival endpoint, add generic manual mark endpoint ---
path = Path('src/routes/workerPortal.js')
s = path.read_text()
anchor = "\n  router.post('/cuadrillas/presencia/sincronizar', biometricJson, async (req, res) => {"
if anchor not in s:
    raise SystemExit('sync route anchor not found')
route = r'''

  router.post('/cuadrillas/presencia/marca-manual', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      if (!isNativeAndroidRequest(req)) {
        return strictError(res, 409, 'native_attendance_required', 'Esta marcación requiere la app de Lórren.');
      }

      const assignmentId = normalizedString(req.body?.assignmentId, 160);
      const serviceRequestId = normalizedString(req.body?.serviceRequestId, 160);
      const targetAssignmentId = normalizedString(req.body?.targetAssignmentId, 160);
      const idempotencyKey = normalizedString(req.body?.idempotencyKey, 100);
      const markType = normalizeBiometricMarkType(req.body?.markType);
      if (
        !assignmentId
        || !serviceRequestId
        || !targetAssignmentId
        || !idempotencyKey
        || targetAssignmentId === assignmentId
      ) {
        return strictError(res, 400, 'crew_manual_mark_invalid', 'La marcación pendiente no es válida.');
      }

      const assignment = await loadBiometricAssignmentFn(portalSession.workerId, assignmentId, now);
      if (
        !assignment
        || assignment.serviceRequest?.id !== serviceRequestId
        || assignment.serviceRequest?.operationPoint?.attendanceEnabled !== true
      ) {
        return strictError(res, 409, 'assignment_not_available', 'La cuadrilla ya no está disponible para esta marcación.');
      }

      const nativeLocation = requireNativeAttendanceLocation(req, res, portalSession, {
        assignmentId,
        markType,
        idempotencyKey,
        captureMode: ONLINE_WEB_CAPTURE_MODE
      }, now);
      if (!nativeLocation) return;
      const location = await requireStrictAttendanceLocation(
        prisma,
        res,
        assignment.serviceRequest.operationPoint,
        nativeLocation,
        { allowCrossOperation: false }
      );
      if (!location) return;

      const commonInput = {
        leaderWorkerId: portalSession.workerId,
        assignmentId,
        manualTargetAssignmentId: targetAssignmentId,
        idempotencyKey,
        now,
        captureMode: ONLINE_WEB_CAPTURE_MODE,
        clientCapturedAt: nativeLocation.clientCapturedAt,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracyMeters,
        installationIdHash: null,
        persistentStorageAvailable: true,
        presenceValidated: false,
        ipAddress: normalizedString(req.ip, 120),
        userAgent: normalizedString(req.get?.('user-agent'), 500)
      };
      const result = markType === 'ARRIVAL'
        ? await registerCrewPresenceArrivalFn({ ...commonInput, forceMajeure: false })
        : await registerCrewPresenceMarkFn({ ...commonInput, markType });
      if (!result?.applied || !result.summary) {
        return strictError(res, 409, 'crew_manual_mark_not_available', 'La marcación pendiente ya no está disponible.');
      }
      const targetResult = (result.summary.results || [])
        .find((item) => item.assignmentId === targetAssignmentId && item.isLeader === false);
      if (!targetResult || !['RECORDED', 'REPLAYED', 'ALREADY_RECORDED'].includes(targetResult.status)) {
        return strictError(res, 409, 'crew_manual_mark_not_recorded', 'No fue posible registrar la marcación pendiente.');
      }

      return res.status(200).json({
        ok: true,
        markType,
        serviceRequestId,
        targetAssignmentId,
        status: targetResult.status,
        requiresReview: targetResult.pendingReview === true
      });
    } catch (error) {
      const [status, code] = crewPresencePublicError(error);
      if (status >= 500) console.error('[WORKER_PORTAL_CREW_MANUAL_MARK_FAILED]', { code });
      return strictError(res, status, code, 'No fue posible registrar la marcación pendiente.');
    }
  });
'''
if "'/cuadrillas/presencia/marca-manual'" not in s:
    s = s.replace(anchor, route + anchor, 1)
path.write_text(s)

# --- Focused regression ---
test = Path('test/workerPortalAndroidCrewUniversalManualMarks.test.js')
test.write_text(r'''import test from 'node:test';
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
''')
