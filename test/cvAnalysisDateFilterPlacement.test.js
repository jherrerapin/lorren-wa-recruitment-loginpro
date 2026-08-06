import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync('src/routes/lorenV2CvAnalysis.js', 'utf8');
const relocationSource = readFileSync('src/services/relocateAdminDateRangeToCvAnalysis.js', 'utf8');

test('el rango de fechas está en Análisis HV y no se conserva en el listado general', () => {
  assert.match(routeSource, /name="dateFrom"/);
  assert.match(routeSource, /name="dateTo"/);
  assert.match(routeSource, /reviewVacancyCandidates\(prisma, \{ vacancyId, desiredProfile, dateFrom, dateTo \}\)/);
  assert.match(routeSource, /orderBy:\s*\[\{ createdAt: 'desc' \}, \{ id: 'asc' \}\]/);

  assert.match(relocationSource, /delete sanitized\.dateFrom/);
  assert.match(relocationSource, /delete sanitized\.dateTo/);
  assert.match(relocationSource, /applicant-date-range/);
  assert.match(relocationSource, /removeApplicantDateRangeControl/);
});
