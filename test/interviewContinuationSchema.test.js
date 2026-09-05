import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schemaSource = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const migrationSource = readFileSync(
  new URL('../prisma/migrations/20260905000500_add_interview_continuation_status/migration.sql', import.meta.url),
  'utf8'
);

test('Prisma expande InterviewCandidateReview con continuidad post-entrevista sin tocar CandidateStatus', () => {
  assert.match(
    schemaSource,
    /enum InterviewContinuationStatus \{[\s\S]*CONTINUES[\s\S]*WITHDREW[\s\S]*\}/
  );
  assert.match(
    schemaSource,
    /continuationStatus\s+InterviewContinuationStatus\s+@default\(CONTINUES\)/
  );
  assert.match(schemaSource, /continuationUpdatedByUserId\s+String\?/);
  assert.match(schemaSource, /continuationUpdatedByLabel\s+String\?/);
  assert.match(schemaSource, /continuationUpdatedAt\s+DateTime\?/);
  assert.match(schemaSource, /@@index\(\[vacancyId, continuationStatus\]\)/);

  const candidateStatusEnum = /enum CandidateStatus \{([\s\S]*?)\n\}/.exec(schemaSource)?.[1] || '';
  assert.doesNotMatch(candidateStatusEnum, /WITHDREW|DESIST/);
});

test('la migración de continuidad es expand-only y deja registros previos en CONTINUES', () => {
  assert.match(
    migrationSource,
    /CREATE TYPE "InterviewContinuationStatus" AS ENUM \('CONTINUES', 'WITHDREW'\)/
  );
  assert.match(
    migrationSource,
    /ADD COLUMN "continuationStatus" "InterviewContinuationStatus" NOT NULL DEFAULT 'CONTINUES'/
  );
  assert.match(migrationSource, /ADD COLUMN "continuationUpdatedByUserId" TEXT/);
  assert.match(migrationSource, /ADD COLUMN "continuationUpdatedByLabel" TEXT/);
  assert.match(migrationSource, /ADD COLUMN "continuationUpdatedAt" TIMESTAMP\(3\)/);
  assert.match(
    migrationSource,
    /CREATE INDEX "InterviewCandidateReview_vacancyId_continuationStatus_idx"/
  );
  assert.doesNotMatch(migrationSource, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/);
});
