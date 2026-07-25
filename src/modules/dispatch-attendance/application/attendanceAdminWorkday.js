import {
  getDispatchAttendanceBreakPolicies
} from '../infrastructure/dispatchAttendanceBreakPolicyRepository.js';
import { formatDispatchMinutes } from '../domain/attendanceWorkdayPolicy.js';

const BOGOTA_TIME_ZONE = 'America/Bogota';

function formatDateTime(value) {
  if (!value) return 'Sin registro';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin registro';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

function latestMark(marks, markType) {
  return (Array.isArray(marks) ? marks : [])
    .filter((mark) => mark.markType === markType)
    .sort((left, right) => new Date(right.serverReceivedAt || 0) - new Date(left.serverReceivedAt || 0))[0] || null;
}

export async function enrichAttendanceBoardWithWorkday(prisma, board) {
  const rows = Array.isArray(board?.rows) ? board.rows : [];
  if (!rows.length) return board;
  if (!prisma?.dispatchAssignment || typeof prisma.dispatchAssignment.findMany !== 'function') {
    throw new Error('attendance_workday_assignment_reader_required');
  }
  const assignments = await prisma.dispatchAssignment.findMany({
    where: { id: { in: rows.map((row) => row.assignmentId) } },
    include: {
      attendanceSession: {
        include: { marks: { orderBy: { serverReceivedAt: 'desc' } } }
      }
    }
  });
  const assignmentMap = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const policies = await getDispatchAttendanceBreakPolicies(
    prisma,
    assignments.map((assignment) => assignment.serviceRequestId)
  );

  return {
    ...board,
    rows: rows.map((row) => {
      const assignment = assignmentMap.get(row.assignmentId);
      const session = assignment?.attendanceSession || null;
      const arrivalMark = latestMark(session?.marks, 'ARRIVAL');
      const departureMark = latestMark(session?.marks, 'DEPARTURE');
      const arrivalAt = session?.arrivalReportedAt ? new Date(session.arrivalReportedAt) : null;
      const departureAt = session?.departureReportedAt ? new Date(session.departureReportedAt) : null;
      const grossWorkedMinutes = arrivalAt && departureAt
        ? Math.max(0, Math.floor((departureAt.getTime() - arrivalAt.getTime()) / 60_000))
        : null;
      const workedMinutes = Number.isInteger(session?.workedMinutes) ? session.workedMinutes : null;
      const deducted = grossWorkedMinutes !== null && workedMinutes !== null
        ? Math.max(0, grossWorkedMinutes - workedMinutes)
        : null;
      const policy = policies.get(assignment?.serviceRequestId) || { policy: 'NONE', unpaidBreakMinutes: 0 };

      return {
        ...row,
        serviceRequestId: assignment?.serviceRequestId || null,
        arrivalMarkId: arrivalMark?.id || row.markId || null,
        departureMarkId: departureMark?.id || null,
        arrivalEvidenceAvailable: Boolean(arrivalMark?.evidenceStorageKey),
        departureEvidenceAvailable: Boolean(departureMark?.evidenceStorageKey),
        departureReportedAt: session?.departureReportedAt?.toISOString?.() || null,
        departureReportedLabel: formatDateTime(session?.departureReportedAt),
        grossWorkedMinutes,
        grossWorkedLabel: grossWorkedMinutes === null ? 'Pendiente de salida' : formatDispatchMinutes(grossWorkedMinutes),
        unpaidBreakMinutesDeducted: deducted,
        unpaidBreakLabel: deducted === null ? 'Pendiente' : formatDispatchMinutes(deducted),
        workedMinutes,
        workedLabel: workedMinutes === null ? 'Pendiente de salida' : formatDispatchMinutes(workedMinutes),
        breakPolicy: policy.policy,
        configuredUnpaidBreakMinutes: policy.unpaidBreakMinutes,
        configuredBreakLabel: policy.unpaidBreakMinutes > 0
          ? `${policy.unpaidBreakMinutes} min no remunerados`
          : 'Sin descanso no remunerado'
      };
    })
  };
}
