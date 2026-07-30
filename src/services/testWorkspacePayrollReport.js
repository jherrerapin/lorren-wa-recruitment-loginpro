import { loadPayrollPolicies } from '../modules/dispatch-payroll/application/payrollReport.js';
import {
  PAYROLL_CONCEPT_CODES,
  calculatePayrollConceptReport
} from '../modules/dispatch-payroll/domain/payrollConceptEngine.js';
import { formatBogotaDateTimeLocal } from './dispatchDevPayrollTest.js';

function dateKey(value) {
  const formatted = formatBogotaDateTimeLocal(value);
  return /^\d{4}-\d{2}-\d{2}/.test(formatted) ? formatted.slice(0, 10) : null;
}

function reportRange(request, sessions = []) {
  if (sessions.length) {
    const dates = sessions.flatMap((session) => [
      dateKey(session.arrivalReportedAt),
      dateKey(session.departureReportedAt)
    ]).filter(Boolean).sort();
    if (dates.length) return { from: dates[0], to: dates[dates.length - 1] };
  }
  const serviceDate = dateKey(request?.serviceDate);
  return serviceDate ? { from: serviceDate, to: serviceDate } : null;
}

export async function loadTestWorkspacePayrollReport(prisma, request) {
  if (!request) return null;

  const sessions = (request.assignments || [])
    .filter((assignment) => assignment.attendanceSession?.source === 'DEV_TEST_MANUAL')
    .map((assignment) => ({
      ...assignment.attendanceSession,
      assignment: {
        ...assignment,
        worker: assignment.worker,
        serviceRequest: request
      }
    }));
  const range = reportRange(request, sessions);
  if (!range) return null;

  if (!sessions.length) {
    return {
      range,
      rows: [],
      totals: {
        workers: 0,
        totalMinutes: 0,
        ordinaryMinutes: 0,
        overtimeMinutes: 0,
        unrecognizedOvertimeMinutes: 0,
        totalHours: 0,
        ordinaryHours: 0,
        overtimeHours: 0,
        unrecognizedOvertimeHours: 0,
        workersWithNovelties: 0,
        conceptMinutes: Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, 0])),
        conceptHours: Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, 0]))
      },
      conceptCodes: PAYROLL_CONCEPT_CODES
    };
  }

  const clientId = request.operationPoint?.clientId || request.operationPoint?.client?.id || null;
  const policiesByClientId = await loadPayrollPolicies(prisma, clientId ? [clientId] : []);
  return calculatePayrollConceptReport({
    sessions,
    policiesByClientId,
    compensationByWorkerDate: new Map(),
    range
  });
}
