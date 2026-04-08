import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientDatabaseAvailabilityError, runAutoCvMigration } from '../src/services/cvMigration.js';

test('isTransientDatabaseAvailabilityError detecta reinicio o recovery de postgres', () => {
  assert.equal(isTransientDatabaseAvailabilityError({ code: 'P1001' }), true);
  assert.equal(isTransientDatabaseAvailabilityError(new Error('FATAL: the database system is starting up')), true);
  assert.equal(isTransientDatabaseAvailabilityError(new Error('Consistent recovery state has not been yet reached.')), true);
  assert.equal(isTransientDatabaseAvailabilityError(new Error('otro error cualquiera')), false);
});

test('runAutoCvMigration omite ejecucion si R2 no esta configurado', async () => {
  const previousEnv = {
    R2_ENDPOINT: process.env.R2_ENDPOINT,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: process.env.R2_BUCKET
  };

  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET;

  const prisma = {
    candidate: {
      count() {
        throw new Error('no deberia consultar la base si no hay storage configurado');
      }
    }
  };

  try {
    const result = await runAutoCvMigration(prisma);
    assert.deepEqual(result, { skipped: 'storage_not_configured' });
  } finally {
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});
