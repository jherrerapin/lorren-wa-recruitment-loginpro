ALTER TABLE "DispatchWorker"
ADD COLUMN "isTestProfile" BOOLEAN NOT NULL DEFAULT false;

UPDATE "DispatchWorker"
SET "isTestProfile" = true
WHERE regexp_replace(lower(trim("fullName")), '\s+', ' ', 'g') = 'jhon herrera';

WITH "OperationalCoverage" AS (
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
  LEFT JOIN "DispatchAssignment" assignment
    ON assignment."serviceRequestId" = request."id"
  LEFT JOIN "DispatchWorker" worker
    ON worker."id" = assignment."workerId"
  WHERE EXISTS (
    SELECT 1
    FROM "DispatchAssignment" test_assignment
    JOIN "DispatchWorker" test_worker
      ON test_worker."id" = test_assignment."workerId"
    WHERE test_assignment."serviceRequestId" = request."id"
      AND test_worker."isTestProfile" = true
  )
  GROUP BY request."id", request."requiredWorkers"
)
UPDATE "DispatchServiceRequest" request
SET "status" = CASE
  WHEN coverage."confirmedCount" >= coverage."requiredWorkers" THEN 'ASSIGNMENT_COMPLETE'
  WHEN coverage."activeCount" >= coverage."requiredWorkers" THEN 'PENDING_CONFIRMATION'
  WHEN coverage."activeCount" > 0 THEN 'ASSIGNMENT_PARTIAL'
  ELSE 'PENDING_ASSIGNMENT'
END
FROM "OperationalCoverage" coverage
WHERE request."id" = coverage."serviceRequestId";
