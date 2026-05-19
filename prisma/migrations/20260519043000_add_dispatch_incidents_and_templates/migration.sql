CREATE TABLE "DispatchIncident" (
  "id" TEXT NOT NULL,
  "serviceRequestId" TEXT NOT NULL,
  "assignmentId" TEXT,
  "workerId" TEXT,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "description" TEXT NOT NULL,
  "reportedBy" TEXT,
  "resolutionNote" TEXT,
  "createdByUsername" TEXT,
  "resolvedByUsername" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DispatchIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DispatchMessageTemplate" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdByUsername" TEXT,
  "updatedByUsername" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DispatchMessageTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DispatchMessageTemplate_key_key" ON "DispatchMessageTemplate"("key");
CREATE INDEX "DispatchMessageTemplate_key_idx" ON "DispatchMessageTemplate"("key");
CREATE INDEX "DispatchIncident_serviceRequestId_idx" ON "DispatchIncident"("serviceRequestId");
CREATE INDEX "DispatchIncident_assignmentId_idx" ON "DispatchIncident"("assignmentId");
CREATE INDEX "DispatchIncident_workerId_idx" ON "DispatchIncident"("workerId");
CREATE INDEX "DispatchIncident_status_idx" ON "DispatchIncident"("status");
CREATE INDEX "DispatchIncident_createdAt_idx" ON "DispatchIncident"("createdAt");

ALTER TABLE "DispatchIncident" ADD CONSTRAINT "DispatchIncident_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "DispatchServiceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DispatchIncident" ADD CONSTRAINT "DispatchIncident_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "DispatchAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DispatchIncident" ADD CONSTRAINT "DispatchIncident_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "DispatchWorker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "DispatchMessageTemplate" ("id", "key", "content", "createdAt", "updatedAt")
VALUES (
  'cm-template-dispatch-assignment-whatsapp',
  'DISPATCH_ASSIGNMENT_WHATSAPP',
  'Hola {{nombre}}, te confirmamos asignacion para {{fecha}} en {{operacion}}. Direccion: {{direccion}}. Horario: {{horaInicio}} - {{horaFin}}. Servicio: {{servicio}}. Cliente: {{cliente}}. Por favor confirma recibido.',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
