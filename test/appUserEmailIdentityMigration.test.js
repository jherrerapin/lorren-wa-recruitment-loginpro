import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migrationPath = '../prisma/migrations/20260819205500_app_user_email_identity/migration.sql';

function readMigration() {
  return readFileSync(new URL(migrationPath, import.meta.url), 'utf8');
}

test('la migración de identidad AppUser es reintentable después de un fallo parcial', () => {
  const migration = readMigration();

  assert.match(migration, /\bBEGIN;/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "displayName" TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "email" TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "identityMigratedAt" TIMESTAMP\(3\)/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS "AppUser_email_key" ON "AppUser"\("email"\)/
  );
  assert.match(migration, /\bCOMMIT;/);

  const beginIndex = migration.indexOf('BEGIN;');
  const alterIndex = migration.indexOf('ALTER TABLE "AppUser"');
  const uniqueIndex = migration.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "AppUser_email_key"');
  const commitIndex = migration.indexOf('COMMIT;');

  assert.ok(beginIndex >= 0 && beginIndex < alterIndex);
  assert.ok(alterIndex < uniqueIndex);
  assert.ok(uniqueIndex < commitIndex);
});

test('la recuperación conserva la expansión aditiva y no oculta integridad de email', () => {
  const migration = readMigration();

  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /\bDELETE\b/i);
  assert.doesNotMatch(migration, /\bUPDATE\b/i);
  assert.doesNotMatch(migration, /ALTER\s+COLUMN/i);
  assert.doesNotMatch(migration, /SET\s+NOT\s+NULL/i);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "AppUser_email_key"/);
});
