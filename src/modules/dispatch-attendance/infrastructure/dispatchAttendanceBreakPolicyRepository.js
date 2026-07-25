import { randomUUID } from 'node:crypto';

export const DISPATCH_BREAK_POLICY = Object.freeze({ NONE: 'NONE', FLEXIBLE: 'FLEXIBLE' });
const VALID_POLICIES = new Set(Object.values(DISPATCH_BREAK_POLICY));
const MAX_UNPAID_BREAK_MINUTES = 240;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

function requireServiceRequestId(value) {
  const normalized = normalizeString(value);
  if (!normalized || !/^[A-Za-z0-9_-]{1,120}$/.test(normalized)) throw new Error('attendance_break_service_request_id_invalid');
  return normalized;
}

export function normalizeDispatchBreakPolicy(input = {}) {
  const requestedPolicy = normalizeString(input.policy)?.toUpperCase() || DISPATCH_BREAK_POLICY.NONE;
  if (!VALID_POLICIES.has(requestedPolicy)) throw new Error('attendance_break_policy_invalid');
  if (requestedPolicy === DISPATCH_BREAK_POLICY.NONE) return { policy: DISPATCH_BREAK_POLICY.NONE, unpaidBreakMinutes: 0 };
  const minutes = Number(input.unpaidBreakMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_UNPAID_BREAK_MINUTES) throw new Error('attendance_break_minutes_invalid');
  return { policy: DISPATCH_BREAK_POLICY.FLEXIBLE, unpaidBreakMinutes: minutes };
}

function requireRawPrisma(prisma) {
  if (!prisma || typeof prisma.$queryRaw !== 'function' || typeof prisma.$executeRaw !== 'function') throw new Error('attendance_break_repository_prisma_required');
  return prisma;
}

export async function getDispatchAttendanceBreakPolicy(prisma, serviceRequestId) {
  requireRawPrisma(prisma);
  const id = requireServiceRequestId(serviceRequestId);
  const rows = await prisma.$queryRaw`
    SELECT "policy", "unpaidBreakMinutes"
    FROM "DispatchAttendanceBreakPolicy"
    WHERE "serviceRequestId" = ${id}
    LIMIT 1
  `;
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { policy: DISPATCH_BREAK_POLICY.NONE, unpaidBreakMinutes: 0 };
  return normalizeDispatchBreakPolicy({ policy: row.policy, unpaidBreakMinutes: Number(row.unpaidBreakMinutes) });
}

export async function getDispatchAttendanceBreakPolicies(prisma, serviceRequestIds = []) {
  requireRawPrisma(prisma);
  const ids = [...new Set(serviceRequestIds.map(requireServiceRequestId))];
  const entries = await Promise.all(ids.map(async (id) => [id, await getDispatchAttendanceBreakPolicy(prisma, id)]));
  return new Map(entries);
}

export async function upsertDispatchAttendanceBreakPolicy(prisma, input = {}) {
  requireRawPrisma(prisma);
  const serviceRequestId = requireServiceRequestId(input.serviceRequestId);
  const policy = normalizeDispatchBreakPolicy(input);
  const actorUsername = normalizeString(input.actorUsername)?.slice(0, 120) || null;
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "DispatchAttendanceBreakPolicy" (
      "id", "serviceRequestId", "policy", "unpaidBreakMinutes",
      "createdByUsername", "updatedByUsername", "createdAt", "updatedAt"
    ) VALUES (
      ${id}, ${serviceRequestId}, ${policy.policy}, ${policy.unpaidBreakMinutes},
      ${actorUsername}, ${actorUsername}, NOW(), NOW()
    )
    ON CONFLICT ("serviceRequestId") DO UPDATE SET
      "policy" = EXCLUDED."policy",
      "unpaidBreakMinutes" = EXCLUDED."unpaidBreakMinutes",
      "updatedByUsername" = EXCLUDED."updatedByUsername",
      "updatedAt" = NOW()
  `;
  return { serviceRequestId, ...policy };
}

export { MAX_UNPAID_BREAK_MINUTES };
