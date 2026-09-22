import test from 'node:test';
import assert from 'node:assert/strict';
import { RECRUITMENT_EXTRACTION_SCHEMA } from '../src/ai/recruitmentExtractionSchema.js';

test('schema incluye experienceTime en fields requeridos', () => {
  const required = RECRUITMENT_EXTRACTION_SCHEMA.schema.properties.fields.required;
  assert.ok(required.includes('experienceTime'));
});

test('fieldEvidence exige todos los campos declarados en modo strict', () => {
  const fieldEvidence = RECRUITMENT_EXTRACTION_SCHEMA.schema.properties.fieldEvidence;
  assert.deepEqual(
    [...fieldEvidence.required].sort(),
    Object.keys(fieldEvidence.properties).sort()
  );
});

test('schema incluye evidence y conflicts para experienceTime', () => {
  const fieldEvidence = RECRUITMENT_EXTRACTION_SCHEMA.schema.properties.fieldEvidence.properties;
  const conflictsEnum = RECRUITMENT_EXTRACTION_SCHEMA.schema.properties.conflicts.items.properties.field.enum;
  assert.ok(Object.hasOwn(fieldEvidence, 'experienceTime'));
  assert.ok(conflictsEnum.includes('experienceTime'));
});
