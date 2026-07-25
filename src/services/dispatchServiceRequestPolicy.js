import { dispatchServiceDateKey } from './dispatchDate.js';
import { deleteObjectFromR2 } from './storage.js';

export const DISPATCH_SERVICE_REQUEST_EDIT_GRACE_HOURS = 2;
export const DISPATCH_SERVICE_REQUEST_EDIT_GRACE_MS = DISPATCH_SERVICE_REQUEST_EDIT_GRACE_HOURS * 60 * 60 * 1000;

export const DISPATCH_SERVICE_REQUEST_POLICY_INCLUDE = Object.freeze({
  operationPoint: {
    include: {
      client: {
        select: {
          id: true,
          name: true,
          isTestClient: true
        }
      }
    }
  }
});

function normalizeTime(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  if (!match) return '00:00';
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

export function dispatchServiceRequestStartAt(request = {}) {
  const date = dispatchServiceDateKey(request.serviceDate);
  if (!date) return null;
  const start = new Date(`${date}T${normalizeTime(request.startTime)}:00-05:00`);
  return Number.isNaN(start.getTime()) ? null : start;
}

export function resolveDispatchServiceRequestPolicy(request = {}, now = new Date()) {
  const startAt = dispatchServiceRequestStartAt(request);
  const lockAt = startAt ? new Date(startAt.getTime() + DISPATCH_SERVICE_REQUEST_EDIT_GRACE_MS) : null;
  const isTimeLocked = Boolean(lockAt && now.getTime() > lockAt.getTime());
  const isTestClient = request.operationPoint?.client?.isTestClient === true;

  return {
    isTestClient,
    startAt: startAt?.toISOString() || null,
    editLockAt: lockAt?.toISOString() || null,
    isTimeLocked,
    canEdit: !isTimeLocked,
    canDelete: isTestClient || !isTimeLocked,
    editBlockedReason: isTimeLocked
      ? `Esta solicitud superó las ${DISPATCH_SERVICE_REQUEST_EDIT_GRACE_HOURS} horas posteriores a la hora de inicio del servicio y quedó solo para consulta.`
      : null,
    deleteBlockedReason: isTimeLocked && !isTestClient
      ? `Esta solicitud superó las ${DISPATCH_SERVICE_REQUEST_EDIT_GRACE_HOURS} horas posteriores a la hora de inicio del servicio y ya no puede eliminarse.`
      : null
  };
}

function uniqueEvidenceKeys(sessions = []) {
  return [...new Set(
    sessions.flatMap((session) => session.marks || [])
      .map((mark) => mark.evidenceStorageKey)
      .filter(Boolean)
  )];
}

async function discardEvidenceKeys(keys, deleteEvidence) {
  if (!keys.length) return { attempted: 0, failed: 0 };
  const results = await Promise.allSettled(keys.map((key) => deleteEvidence(key)));
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed) {
    console.warn('[Dispatch request delete] No fue posible retirar todas las evidencias almacenadas.', {
      attempted: keys.length,
      failed
    });
  }
  return { attempted: keys.length, failed };
}

export async function deleteDispatchServiceRequestWithPolicy(prisma, serviceRequestId, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const deleteEvidence = typeof options.deleteEvidence === 'function' ? options.deleteEvidence : deleteObjectFromR2;

  const transactionResult = await prisma.$transaction(async (tx) => {
    const request = await tx.dispatchServiceRequest.findUnique({
      where: { id: serviceRequestId },
      include: DISPATCH_SERVICE_REQUEST_POLICY_INCLUDE
    });
    if (!request) return { status: 'NOT_FOUND', policy: null, evidenceKeys: [] };

    const policy = resolveDispatchServiceRequestPolicy(request, now);
    if (!policy.canDelete) return { status: 'BLOCKED', policy, evidenceKeys: [] };

    const attendanceSessions = await tx.dispatchAttendanceSession.findMany({
      where: { assignment: { serviceRequestId } },
      select: {
        id: true,
        marks: { select: { evidenceStorageKey: true } }
      }
    });
    const sessionIds = attendanceSessions.map((session) => session.id);
    const evidenceKeys = uniqueEvidenceKeys(attendanceSessions);

    if (sessionIds.length) {
      await tx.dispatchAttendanceReview.deleteMany({ where: { attendanceSessionId: { in: sessionIds } } });
      await tx.dispatchAttendanceMark.deleteMany({ where: { attendanceSessionId: { in: sessionIds } } });
      await tx.dispatchAttendanceSession.deleteMany({ where: { id: { in: sessionIds } } });
    }

    await tx.dispatchServiceRequest.delete({ where: { id: request.id } });
    return { status: 'DELETED', policy, evidenceKeys };
  });

  if (transactionResult.status === 'DELETED') {
    const evidenceCleanup = await discardEvidenceKeys(transactionResult.evidenceKeys, deleteEvidence);
    return { ...transactionResult, evidenceCleanup };
  }
  return transactionResult;
}
