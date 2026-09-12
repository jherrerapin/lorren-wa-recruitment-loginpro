import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync('src/routes/lorenV2CvAnalysis.js', 'utf8');
const relocationSource = readFileSync('src/services/relocateAdminDateRangeToCvAnalysis.js', 'utf8');

test('Análisis HV conserva su rango propio y el listado general no borra dateFrom/dateTo', () => {
  assert.match(routeSource, /name="dateFrom"/);
  assert.match(routeSource, /name="dateTo"/);
  assert.match(routeSource, /reviewVacancyCandidates\(prisma, \{ vacancyId, desiredProfile, dateFrom, dateTo \}\)/);
  assert.match(routeSource, /orderBy:\s*\[\{ createdAt: 'desc' \}, \{ id: 'asc' \}\]/);

  assert.doesNotMatch(relocationSource, /delete sanitized\.dateFrom/);
  assert.doesNotMatch(relocationSource, /delete sanitized\.dateTo/);
  assert.doesNotMatch(relocationSource, /withoutDateRange/);
  assert.doesNotMatch(relocationSource, /response\.req\.query\s*=/);
  assert.match(relocationSource, /applicant-date-range/);
  assert.match(relocationSource, /removeApplicantDateRangeControl/);
});