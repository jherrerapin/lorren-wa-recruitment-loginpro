import fs from 'node:fs';

const schemaPath = 'prisma/schema.prisma';
let schema = fs.readFileSync(schemaPath, 'utf8');

function replaceOnce(source, expected, replacement, label) {
  const first = source.indexOf(expected);
  if (first < 0) throw new Error(`patch_583_missing_${label}`);
  if (source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`patch_583_duplicate_${label}`);
  }
  return source.replace(expected, replacement);
}

schema = replaceOnce(
  schema,
  '  activations       DispatchWorkerActivation[]\n',
  '  activations       DispatchWorkerActivation[]\n  portalSessions    DispatchWorkerPortalSession[]\n',
  'worker_relation'
);

schema = replaceOnce(
  schema,
  '  consumedActivations  DispatchWorkerActivation[]\n',
  '  consumedActivations  DispatchWorkerActivation[]\n  portalSessions       DispatchWorkerPortalSession[]\n',
  'device_relation'
);

schema = replaceOnce(
  schema,
  '  updatedAt            DateTime              @updatedAt\n\n  @@index([workerId, purpose, status])',
  '  updatedAt            DateTime              @updatedAt\n  portalSession         DispatchWorkerPortalSession?\n\n  @@index([workerId, purpose, status])',
  'activation_relation'
);

const modelAnchor = `model DispatchAttendanceSession {`;
const sessionModel = `model DispatchWorkerPortalSession {
  id                  String                   @id @default(cuid())
  workerId            String
  worker              DispatchWorker           @relation(fields: [workerId], references: [id], onDelete: Restrict)
  workerDeviceId      String
  workerDevice        DispatchWorkerDevice      @relation(fields: [workerDeviceId], references: [id], onDelete: Restrict)
  activationId        String                   @unique
  activation          DispatchWorkerActivation @relation(fields: [activationId], references: [id], onDelete: Restrict)
  sessionTokenHash    String                   @unique
  status              String                   @default("ACTIVE")
  issuedAt            DateTime                 @default(now())
  expiresAt           DateTime
  lastSeenAt          DateTime?
  revokedAt           DateTime?
  revokedByUsername   String?
  revocationReason    String?
  ipAddress           String?
  userAgent           String?
  platform            String?
  createdAt           DateTime                 @default(now())
  updatedAt           DateTime                 @updatedAt

  @@index([workerId, status, expiresAt])
  @@index([workerDeviceId, status, expiresAt])
  @@index([status, expiresAt])
  @@index([lastSeenAt])
}

`;

schema = replaceOnce(schema, modelAnchor, `${sessionModel}${modelAnchor}`, 'session_model');

if ((schema.match(/model DispatchWorkerPortalSession \{/g) || []).length !== 1) {
  throw new Error('patch_583_session_model_count_invalid');
}
if (schema.includes('rawSessionToken') || schema.includes('plainSessionToken')) {
  throw new Error('patch_583_raw_session_token_detected');
}

fs.writeFileSync(schemaPath, schema);
