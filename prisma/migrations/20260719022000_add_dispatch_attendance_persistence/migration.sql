-- Expand operation points with attendance configuration.
-- Attendance remains disabled for every existing and future point unless enabled explicitly.
ALTER TABLE "DispatchOperationPoint"
  ADD COLUMN "attendanceEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "attendanceLatitude" DECIMAL(10,7),
  ADD COLUMN "attendanceLongitude" DECIMAL(10,7),
  ADD COLUMN "geofenceRadiusMeters" INTEGER,
  ADD COLUMN "maxLocationAccuracyMeters" INTEGER,
  ADD COLUMN "earlyArrivalWindowMinutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "lateToleranceMinutes" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "absenceGraceMinutes" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "attendanceTimezone" TEXT NOT NULL DEFAULT 'America/Bogota',
  ADD COLUMN "attendancePhotoPolicy" TEXT NOT NULL DEFAULT 'RISK_ONLY',
  ADD COLUMN "manualAttendanceAllowed" BOOLEAN NOT NULL DEFAULT true;

-- Devices are associated with workers, but the same installation hash may appear
-- for more than one worker so shared-device risk can be detected instead of hidden.
CREATE TABLE "DispatchWorkerDevice" (
  "id" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "installationIdHash" TEXT NOT NULL,
  "authorizationType" TEXT NOT NULL DEFAULT 'PRIMARY',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "authorizedFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "authorizedUntil" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revokedByUsername" TEXT,
  "revocationReason" TEXT,
  "userAgent" TEXT,
  "platform" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DispatchWorkerDevice_pkey" PRIMARY KEY ("id")
);

-- One attendance session belongs to exactly one dispatch assignment.
CREATE TABLE "DispatchAttendanceSession" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "expectedStartAt" TIMESTAMP(3) NOT NULL,
  "expectedEndAt" TIMESTAMP(3),
  "attendanceStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "validationStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "punctualityStatus" TEXT,
  "riskScore" INTEGER NOT NULL DEFAULT 0,
  "riskFlags" JSONB,
  "arrivalReportedAt" TIMESTAMP(3),
  "arrivalValidatedAt" TIMESTAMP(3),
  "departureReportedAt" TIMESTAMP(3),
  "departureValidatedAt" TIMESTAMP(3),
  "workedMinutes" INTEGER,
  "source" TEXT NOT NULL DEFAULT 'SYSTEM',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DispatchAttendanceSession_pkey" PRIMARY KEY ("id")
);

-- Every received attempt is kept as a separate mark. The idempotency key prevents
-- network retries from creating duplicate records for the same client request.
CREATE TABLE "DispatchAttendanceMark" (
  "id" TEXT NOT NULL,
  "attendanceSessionId" TEXT NOT NULL,
  "workerDeviceId" TEXT,
  "markType" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "serverReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "clientCapturedAt" TIMESTAMP(3),
  "latitude" DECIMAL(10,7),
  "longitude" DECIMAL(10,7),
  "accuracyMeters" DECIMAL(10,2),
  "distanceToPointMeters" DECIMAL(12,2),
  "insideGeofence" BOOLEAN,
  "installationIdHash" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "evidenceStorageKey" TEXT,
  "evidenceMimeType" TEXT,
  "decision" TEXT NOT NULL DEFAULT 'PENDING',
  "riskScore" INTEGER NOT NULL DEFAULT 0,
  "riskFlags" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DispatchAttendanceMark_pkey" PRIMARY KEY ("id")
);

-- Manual decisions are append-only audit records. They never overwrite history.
CREATE TABLE "DispatchAttendanceReview" (
  "id" TEXT NOT NULL,
  "attendanceSessionId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "previousAttendanceStatus" TEXT,
  "newAttendanceStatus" TEXT,
  "previousValidationStatus" TEXT,
  "newValidationStatus" TEXT,
  "reason" TEXT NOT NULL,
  "notes" TEXT,
  "actorUsername" TEXT NOT NULL,
  "actorRole" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DispatchAttendanceReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DispatchWorkerDevice_workerId_installationIdHash_key"
  ON "DispatchWorkerDevice"("workerId", "installationIdHash");
CREATE INDEX "DispatchWorkerDevice_installationIdHash_status_idx"
  ON "DispatchWorkerDevice"("installationIdHash", "status");
CREATE INDEX "DispatchWorkerDevice_workerId_status_idx"
  ON "DispatchWorkerDevice"("workerId", "status");
CREATE INDEX "DispatchWorkerDevice_authorizedUntil_idx"
  ON "DispatchWorkerDevice"("authorizedUntil");

CREATE UNIQUE INDEX "DispatchAttendanceSession_assignmentId_key"
  ON "DispatchAttendanceSession"("assignmentId");
CREATE INDEX "DispatchAttendanceSession_expectedStartAt_idx"
  ON "DispatchAttendanceSession"("expectedStartAt");
CREATE INDEX "DispatchAttendanceSession_attendanceStatus_expectedStartAt_idx"
  ON "DispatchAttendanceSession"("attendanceStatus", "expectedStartAt");
CREATE INDEX "DispatchAttendanceSession_validationStatus_expectedStartAt_idx"
  ON "DispatchAttendanceSession"("validationStatus", "expectedStartAt");

CREATE UNIQUE INDEX "DispatchAttendanceMark_idempotencyKey_key"
  ON "DispatchAttendanceMark"("idempotencyKey");
CREATE INDEX "DispatchAttendanceMark_attendanceSessionId_markType_serverReceivedAt_idx"
  ON "DispatchAttendanceMark"("attendanceSessionId", "markType", "serverReceivedAt");
CREATE INDEX "DispatchAttendanceMark_workerDeviceId_serverReceivedAt_idx"
  ON "DispatchAttendanceMark"("workerDeviceId", "serverReceivedAt");
CREATE INDEX "DispatchAttendanceMark_decision_serverReceivedAt_idx"
  ON "DispatchAttendanceMark"("decision", "serverReceivedAt");

CREATE INDEX "DispatchAttendanceReview_attendanceSessionId_createdAt_idx"
  ON "DispatchAttendanceReview"("attendanceSessionId", "createdAt");
CREATE INDEX "DispatchAttendanceReview_actorUsername_createdAt_idx"
  ON "DispatchAttendanceReview"("actorUsername", "createdAt");
CREATE INDEX "DispatchAttendanceReview_action_createdAt_idx"
  ON "DispatchAttendanceReview"("action", "createdAt");

CREATE INDEX "DispatchOperationPoint_attendanceEnabled_idx"
  ON "DispatchOperationPoint"("attendanceEnabled");

ALTER TABLE "DispatchWorkerDevice"
  ADD CONSTRAINT "DispatchWorkerDevice_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "DispatchWorker"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DispatchAttendanceSession"
  ADD CONSTRAINT "DispatchAttendanceSession_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "DispatchAssignment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DispatchAttendanceMark"
  ADD CONSTRAINT "DispatchAttendanceMark_attendanceSessionId_fkey"
  FOREIGN KEY ("attendanceSessionId") REFERENCES "DispatchAttendanceSession"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DispatchAttendanceMark"
  ADD CONSTRAINT "DispatchAttendanceMark_workerDeviceId_fkey"
  FOREIGN KEY ("workerDeviceId") REFERENCES "DispatchWorkerDevice"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DispatchAttendanceReview"
  ADD CONSTRAINT "DispatchAttendanceReview_attendanceSessionId_fkey"
  FOREIGN KEY ("attendanceSessionId") REFERENCES "DispatchAttendanceSession"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
