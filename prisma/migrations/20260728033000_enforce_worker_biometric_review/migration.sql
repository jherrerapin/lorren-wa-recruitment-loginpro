-- Refuerza en base de datos la evaluación biométrica opcional del Portal del Auxiliar.
-- Una falla biométrica no bloquea la marcación: la conserva y exige revisión humana.

CREATE OR REPLACE FUNCTION "lorrenMergeJsonbTextArrays"(left_value JSONB, right_value JSONB)
RETURNS JSONB
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg(DISTINCT item ORDER BY item), '[]'::jsonb)
  FROM (
    SELECT value AS item
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(left_value) = 'array' THEN left_value ELSE '[]'::jsonb END
    )
    UNION ALL
    SELECT value AS item
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(right_value) = 'array' THEN right_value ELSE '[]'::jsonb END
    )
  ) AS merged;
$$;

CREATE OR REPLACE FUNCTION "lorrenEnforceAttendanceBiometricMarkReview"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  worker_id TEXT;
  latest_enrollment_action TEXT;
  assessment JSONB;
  biometric_flags JSONB;
  biometric_risk INTEGER;
BEGIN
  IF NEW."markType" NOT IN ('ARRIVAL', 'DEPARTURE') THEN
    RETURN NEW;
  END IF;

  SELECT assignment."workerId"
  INTO worker_id
  FROM "DispatchAttendanceSession" session
  JOIN "DispatchAssignment" assignment ON assignment."id" = session."assignmentId"
  WHERE session."id" = NEW."attendanceSessionId";

  IF worker_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT event."action"
  INTO latest_enrollment_action
  FROM "DevAuditEvent" event
  WHERE event."entityType" = 'DISPATCH_WORKER_BIOMETRIC'
    AND event."entityId" = worker_id
    AND event."action" IN ('BIOMETRIC_ENROLLED', 'BIOMETRIC_REVOKED')
  ORDER BY event."createdAt" DESC
  LIMIT 1;

  IF latest_enrollment_action IS DISTINCT FROM 'BIOMETRIC_ENROLLED' THEN
    RETURN NEW;
  END IF;

  SELECT event."metadata"
  INTO assessment
  FROM "DevAuditEvent" event
  WHERE event."entityType" = 'DISPATCH_ATTENDANCE_BIOMETRIC'
    AND event."entityId" = NEW."idempotencyKey"
    AND event."action" = 'BIOMETRIC_ASSESSED'
  ORDER BY event."createdAt" DESC
  LIMIT 1;

  IF assessment ->> 'decision' = 'VERIFIED' THEN
    RETURN NEW;
  END IF;

  biometric_flags := CASE
    WHEN jsonb_typeof(assessment -> 'riskFlags') = 'array' THEN assessment -> 'riskFlags'
    WHEN assessment IS NULL THEN '["BIOMETRIC_ASSESSMENT_MISSING"]'::jsonb
    ELSE '["BIOMETRIC_REVIEW_REQUIRED"]'::jsonb
  END;

  IF jsonb_array_length(biometric_flags) = 0 THEN
    biometric_flags := '["BIOMETRIC_REVIEW_REQUIRED"]'::jsonb;
  END IF;

  biometric_risk := GREATEST(
    60,
    CASE
      WHEN assessment ->> 'riskScore' ~ '^[0-9]+$' THEN (assessment ->> 'riskScore')::INTEGER
      ELSE 60
    END
  );

  UPDATE "DispatchAttendanceMark"
  SET "decision" = 'REVIEW_REQUIRED',
      "riskScore" = GREATEST("riskScore", biometric_risk),
      "riskFlags" = "lorrenMergeJsonbTextArrays"("riskFlags", biometric_flags)
  WHERE "id" = NEW."id";

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "DispatchAttendanceMark_enforce_biometric_review" ON "DispatchAttendanceMark";
CREATE TRIGGER "DispatchAttendanceMark_enforce_biometric_review"
AFTER INSERT ON "DispatchAttendanceMark"
FOR EACH ROW
EXECUTE FUNCTION "lorrenEnforceAttendanceBiometricMarkReview"();

CREATE OR REPLACE FUNCTION "lorrenPreserveAttendanceBiometricSessionReview"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  biometric_mark RECORD;
BEGIN
  SELECT mark."markType", mark."riskScore", mark."riskFlags"
  INTO biometric_mark
  FROM "DispatchAttendanceMark" mark
  WHERE mark."attendanceSessionId" = NEW."id"
    AND mark."decision" = 'REVIEW_REQUIRED'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(mark."riskFlags") = 'array' THEN mark."riskFlags" ELSE '[]'::jsonb END
      ) AS flag(value)
      WHERE flag.value LIKE 'BIOMETRIC_%'
    )
  ORDER BY mark."serverReceivedAt" DESC
  LIMIT 1;

  IF biometric_mark."markType" IS NULL THEN
    RETURN NEW;
  END IF;

  NEW."validationStatus" := 'REVIEW_REQUIRED';
  NEW."riskScore" := GREATEST(NEW."riskScore", biometric_mark."riskScore");
  NEW."riskFlags" := "lorrenMergeJsonbTextArrays"(NEW."riskFlags", biometric_mark."riskFlags");

  IF biometric_mark."markType" = 'ARRIVAL' THEN
    NEW."arrivalValidatedAt" := NULL;
  ELSIF biometric_mark."markType" = 'DEPARTURE' THEN
    NEW."departureValidatedAt" := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "DispatchAttendanceSession_preserve_biometric_review" ON "DispatchAttendanceSession";
CREATE TRIGGER "DispatchAttendanceSession_preserve_biometric_review"
BEFORE UPDATE ON "DispatchAttendanceSession"
FOR EACH ROW
EXECUTE FUNCTION "lorrenPreserveAttendanceBiometricSessionReview"();
