import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCandidateCvBuffer,
  storeCandidateCv
} from '../src/services/cvStorage.js';

const STORAGE_ENV_KEYS = [
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET'
];

function withoutStorage() {
  const previous = Object.fromEntries(STORAGE_ENV_KEYS.map((key) => [key, process.env[key]]));
  STORAGE_ENV_KEYS.forEach((key) => delete process.env[key]);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('al guardar prevalece la firma PDF sobre MIME Word', async () => {
  const restore = withoutStorage();
  const updates = [];
  const prisma = {
    candidate: {
      update: async (input) => {
        updates.push(input);
        return { id: input.where.id, ...input.data };
      }
    }
  };

  try {
    await storeCandidateCv(prisma, 'candidate-pdf', Buffer.from('%PDF-1.7\ncontenido'), {
      mimeType: 'application/msword',
      originalName: 'HV JUAN SEBASTIA\u0301N MURCIA 2026 WORD.pdf'
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.cvMimeType, 'application/pdf');
    assert.equal(updates[0].data.cvOriginalName, 'HV JUAN SEBASTIÁN MURCIA 2026 WORD.pdf');
  } finally {
    restore();
  }
});

test('al leer un archivo histórico normaliza MIME y nombre para la descarga', async () => {
  const restore = withoutStorage();
  const candidate = {
    id: 'candidate-historical',
    cvData: Buffer.from('%PDF-1.7\ncontenido'),
    cvMimeType: 'application/msword',
    cvOriginalName: 'HV JUAN SEBASTIA\u0301N MURCIA 2026 WORD.pdf'
  };

  try {
    const buffer = await resolveCandidateCvBuffer(candidate);

    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(candidate.cvMimeType, 'application/pdf');
    assert.equal(candidate.cvOriginalName, 'HV JUAN SEBASTIAN MURCIA 2026 WORD.pdf');
    assert.equal(candidate.cvResolvedMetadata.kind, 'pdf');
    assert.equal(candidate.cvResolvedMetadata.metadataMismatch, true);
  } finally {
    restore();
  }
});
