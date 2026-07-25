CREATE TABLE "DispatchAttendanceBreakPolicy" (
  "id" TEXT NOT NULL,
  "serviceRequestId" TEXT NOT NULL,
  "policy" TEXT NOT NULL DEFAULT 'NONE',
  "unpaidBreakMinutes" INTEGER NOT NULL DEFAULT 0,
  "createdByUsername" TEXT,
  "updatedByUsername" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DispatchAttendanceBreakPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DispatchAttendanceBreakPolicy_serviceRequestId_fkey"
    FOREIGN KEY ("serviceRequestId")
    REFERENCES "DispatchServiceRequest"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT "DispatchAttendanceBreakPolicy_policy_check"
    CHECK ("policy" IN ('NONE', 'FLEXIBLE')),
  CONSTRAINT "DispatchAttendanceBreakPolicy_minutes_check"
    CHECK (
      ("policy" = 'NONE' AND "unpaidBreakMinutes" = 0)
      OR
      ("policy" = 'FLEXIBLE' AND "unpaidBreakMinutes" BETWEEN 1 AND 240)
    )
);

CREATE UNIQUE INDEX "DispatchAttendanceBreakPolicy_serviceRequestId_key"
ON "DispatchAttendanceBreakPolicy"("serviceRequestId");

CREATE INDEX "DispatchAttendanceBreakPolicy_policy_idx"
ON "DispatchAttendanceBreakPolicy"("policy");
