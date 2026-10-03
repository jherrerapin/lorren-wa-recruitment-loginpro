import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const migrationUrl = new URL(
  '../prisma/migrations/20261003035000_add_dispatch_client_service_billing_rates/migration.sql',
  import.meta.url
);

test('DispatchClientService expone billingRates como Json en el esquema', async () => {
  const schema = await fs.readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  assert.match(schema, /model DispatchClientService[\s\S]*billingRates\s+Json\?/);
});

test('billingRates tiene una migración aditiva y compatible con bases ya reparadas', async () => {
  const migration = await fs.readFile(migrationUrl, 'utf8');
  assert.match(
    migration,
    /ALTER TABLE "DispatchClientService"[\s\S]*ADD COLUMN IF NOT EXISTS "billingRates" JSONB\s*;/i
  );
  assert.doesNotMatch(migration, /DROP\s+(?:COLUMN|TABLE)|DELETE\s+FROM|TRUNCATE/i);
});
