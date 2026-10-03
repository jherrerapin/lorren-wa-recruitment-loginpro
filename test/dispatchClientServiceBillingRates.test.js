import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const billingRatesMigrationUrl = new URL(
  '../prisma/migrations/20261003035000_add_dispatch_client_service_billing_rates/migration.sql',
  import.meta.url
);
const billingModeMigrationUrl = new URL(
  '../prisma/migrations/20261003153500_add_dispatch_service_billing_mode/migration.sql',
  import.meta.url
);

test('DispatchClientService conserva billingRates y declara modalidad de cobro explícita', async () => {
  const schema = await fs.readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  assert.match(schema, /enum DispatchBillingMode\s*{[\s\S]*PERSON[\s\S]*PRODUCTION[\s\S]*}/);
  assert.match(schema, /model DispatchClientService[\s\S]*billingMode\s+DispatchBillingMode\?[\s\S]*billingRates\s+Json\?/);
});

test('billingRates mantiene su migración aditiva original', async () => {
  const migration = await fs.readFile(billingRatesMigrationUrl, 'utf8');
  assert.match(migration, /ALTER TABLE "DispatchClientService"[\s\S]*ADD COLUMN IF NOT EXISTS "billingRates" JSONB\s*;/i);
  assert.doesNotMatch(migration, /DROP\s+(?:COLUMN|TABLE)|DELETE\s+FROM|TRUNCATE/i);
});

test('billingMode se agrega con migración aditiva y compatible con servicios legacy', async () => {
  const migration = await fs.readFile(billingModeMigrationUrl, 'utf8');
  assert.match(migration, /CREATE TYPE "DispatchBillingMode" AS ENUM \('PERSON', 'PRODUCTION'\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "billingMode" "DispatchBillingMode"/);
  assert.doesNotMatch(migration, /NOT NULL|DROP\s+(?:COLUMN|TABLE)|DELETE\s+FROM|TRUNCATE/i);
});

test('backend exige una modalidad exclusiva y estructura las tarifas', async () => {
  const source = await fs.readFile(new URL('../src/routes/dispatchBridgeCore.js', import.meta.url), 'utf8');
  assert.match(source, /\['PERSON', 'PRODUCTION'\]\.includes\(billingMode\)/);
  assert.match(source, /billingRates:\s*\[\{ rate: normalizePositiveBillingRate\(body\.personRate/);
  assert.match(source, /return \{ concept, rate: normalizePositiveBillingRate\(rates\[index\]/);
  assert.doesNotMatch(source, /normalizeBillingRates\(/);
});

test('UI no pide JSON y ofrece persona o producción con concepto y tarifa dinámicos', async () => {
  const view = await fs.readFile(new URL('../src/views/operacionesClienteOperaciones.ejs', import.meta.url), 'utf8');
  assert.match(view, /name="billingMode" value="PERSON"/);
  assert.match(view, /name="billingMode" value="PRODUCTION"/);
  assert.match(view, /name="personRate"/);
  assert.match(view, /name="productionConcept"/);
  assert.match(view, /name="productionRate"/);
  assert.match(view, /data-add-production-rate/);
  assert.doesNotMatch(view, /name="billingRates"/);
});
