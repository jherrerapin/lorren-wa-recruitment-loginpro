-- Repair only historical assignment states that were demonstrably degraded by the
-- worker-deactivation flow that existed before #1464.
--
-- The old writer mapped CONFIRMED -> NO_CONFIRMO and wrote a deactivation note.
-- It also mapped ASSIGNED / CONFIRMATION_PENDING -> CANCELLED. Because those two
-- source states cannot be distinguished afterwards, CANCELLED is restored only
-- when a persisted attendance session proves that the worker actually attended.
--
-- Colombia has no DST. Dispatch service clock values are stored as local HH:mm,
-- while Prisma timestamps are stored as UTC-like TIMESTAMP values. Adding 5 hours
-- converts the configured Bogotá service start into the same timeline used by
-- DispatchAssignment.updatedAt.

UPDATE "DispatchAssignment" assignment
SET "status" = 'CONFIRMED'
FROM "DispatchServiceRequest" request
LEFT JOIN "DispatchOperationPoint" point
  ON point."id" = request."operationPointId"
LEFT JOIN "DispatchAttendanceSession" attendance
  ON attendance."assignmentId" = assignment."id"
WHERE request."id" = assignment."serviceRequestId"
  AND assignment."status" IN ('NO_CONFIRMO', 'CANCELLED')
  AND (
    assignment."notes" ILIKE 'Auxiliar desactivado desde el modulo de personal.%'
    OR assignment."notes" ILIKE 'Auxiliar desactivado desde el módulo de personal.%'
    OR assignment."notes" ILIKE 'Auxiliar retirado del flujo. Causal:%'
  )
  AND (
    attendance."id" IS NOT NULL
    OR (
      assignment."status" = 'NO_CONFIRMO'
      AND (
        (
          (request."startTime" IS NULL OR request."startTime" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
          AND request."serviceDate"::date < (assignment."updatedAt" - INTERVAL '5 hours')::date
        )
        OR (
          request."startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          AND assignment."updatedAt" > (
            request."serviceDate"::date
            + CASE
                WHEN request."startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                  THEN request."startTime"::time
                ELSE TIME '00:00'
              END
            + INTERVAL '5 hours'
            + make_interval(mins => COALESCE(point."absenceGraceMinutes", 15))
          )
        )
      )
    )
  );

-- Recalculate only requests carrying a repaired/deactivation-marked confirmed
-- assignment. The CASE mirrors src/services/dispatchOperationalCoverage.js and
-- deliberately excludes test profiles from operational coverage.
WITH "AffectedRequests" AS (
  SELECT DISTINCT assignment."serviceRequestId"
  FROM "DispatchAssignment" assignment
  JOIN "DispatchServiceRequest" request
    ON request."id" = assignment."serviceRequestId"
  LEFT JOIN "DispatchOperationPoint" point
    ON point."id" = request."operationPointId"
  LEFT JOIN "DispatchAttendanceSession" attendance
    ON attendance."assignmentId" = assignment."id"
  WHERE assignment."status" = 'CONFIRMED'
    AND (
      assignment."notes" ILIKE 'Auxiliar desactivado desde el modulo de personal.%'
      OR assignment."notes" ILIKE 'Auxiliar desactivado desde el módulo de personal.%'
      OR assignment."notes" ILIKE 'Auxiliar retirado del flujo. Causal:%'
    )
    AND (
      attendance."id" IS NOT NULL
      OR (
        (request."startTime" IS NULL OR request."startTime" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
        AND request."serviceDate"::date < (assignment."updatedAt" - INTERVAL '5 hours')::date
      )
      OR (
        request."startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND assignment."updatedAt" > (
          request."serviceDate"::date
          + CASE
              WHEN request."startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                THEN request."startTime"::time
              ELSE TIME '00:00'
            END
          + INTERVAL '5 hours'
          + make_interval(mins => COALESCE(point."absenceGraceMinutes", 15))
        )
      )
    )
),
"OperationalCoverage" AS (
  SELECT
    request."id" AS "serviceRequestId",
    request."requiredWorkers" AS "requiredWorkers",
    COUNT(assignment."id") FILTER (
      WHERE assignment."status" IN ('ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED')
        AND COALESCE(worker."isTestProfile", false) = false
    )::int AS "activeCount",
    COUNT(assignment."id") FILTER (
      WHERE assignment."status" = 'CONFIRMED'
        AND COALESCE(worker."isTestProfile", false) = false
    )::int AS "confirmedCount"
  FROM "DispatchServiceRequest" request
  JOIN "AffectedRequests" affected
    ON affected."serviceRequestId" = request."id"
  LEFT JOIN "DispatchAssignment" assignment
    ON assignment."serviceRequestId" = request."id"
  LEFT JOIN "DispatchWorker" worker
    ON worker."id" = assignment."workerId"
  GROUP BY request."id", request."requiredWorkers"
)
UPDATE "DispatchServiceRequest" request
SET "status" = CASE
  WHEN coverage."confirmedCount" >= coverage."requiredWorkers" AND coverage."requiredWorkers" > 0
    THEN 'ASSIGNMENT_COMPLETE'
  WHEN coverage."activeCount" >= coverage."requiredWorkers" AND coverage."requiredWorkers" > 0
    THEN 'PENDING_CONFIRMATION'
  WHEN coverage."activeCount" > 0
    THEN 'ASSIGNMENT_PARTIAL'
  ELSE 'PENDING_ASSIGNMENT'
END
FROM "OperationalCoverage" coverage
WHERE request."id" = coverage."serviceRequestId";
