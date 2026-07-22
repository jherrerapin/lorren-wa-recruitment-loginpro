import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTENDANCE_EVIDENCE_BYTES,
  buildAttendanceEvidenceStorageKey,
  storeAttendanceArrivalEvidence
} from '../src/services/attendanceEvidenceStorage.js';

const ORIGINAL_ENV = {
  R2_ENDPOINT: process.env.R2_ENDPOINT,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET: process.env.R2_BUCKET
};

test.afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('construye una clave estable y aislada por auxiliar, asignación e intento', () => {
  const key = buildAttendanceEvidenceStorageKey({
    workerId: 'worker-1',
    assignmentId: 'assignment-1',
    idempotencyKey: 'arrival_1234567890',
    extension: 'jpg'
  });
  assert.equal(key, 'attendance/worker-1/assignment-1/arrival/arrival_1234567890.jpg');
});

test('rechaza identificadores que podrían escapar de la ruta de almacenamiento', () => {
  assert.throws(
    () => buildAttendanceEvidenceStorageKey({
      workerId: '../worker',
      assignmentId: 'assignment-1',
      idempotencyKey: 'arrival_1234567890',
      extension: 'jpg'
    }),
    /attendance_evidence_worker_id_invalid/
  );
});

test('sin archivo no exige R2 y devuelve evidencia vacía', async () => {
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET;
  const result = await storeAttendanceArrivalEvidence({ file: null });
  assert.deepEqual(result, { storageKey: null, mimeType: null, created: false });
});

test('con archivo exige almacenamiento configurado y formatos permitidos', async () => {
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET;
  await assert.rejects(
    () => storeAttendanceArrivalEvidence({
      workerId: 'worker-1',
      assignmentId: 'assignment-1',
      idempotencyKey: 'arrival_1234567890',
      file: { buffer: Buffer.from('image'), mimetype: 'image/jpeg' }
    }),
    /attendance_evidence_storage_unavailable/
  );

  await assert.rejects(
    () => storeAttendanceArrivalEvidence({
      workerId: 'worker-1',
      assignmentId: 'assignment-1',
      idempotencyKey: 'arrival_1234567890',
      file: { buffer: Buffer.from('not-image'), mimetype: 'text/plain' }
    }),
    /attendance_evidence_mime_not_allowed/
  );
});

test('documenta el límite de tres megabytes', () => {
  assert.equal(MAX_ATTENDANCE_EVIDENCE_BYTES, 3 * 1024 * 1024);
});
