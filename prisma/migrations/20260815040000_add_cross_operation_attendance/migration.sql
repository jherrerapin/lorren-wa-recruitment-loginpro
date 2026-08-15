ALTER TABLE "DispatchOperationPoint"
ADD COLUMN "crossOperationAttendanceAllowed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "DispatchAttendanceMark"
ADD COLUMN "capturedOperationPointId" TEXT;

CREATE INDEX "DispatchAttendanceMark_capturedOperationPointId_serverReceivedAt_idx"
ON "DispatchAttendanceMark"("capturedOperationPointId", "serverReceivedAt");
