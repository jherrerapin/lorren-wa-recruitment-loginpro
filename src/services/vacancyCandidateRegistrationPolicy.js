const VACANCY_CANDIDATE_LIST_FIELDS = Object.freeze([
  'registeredNoBooking',
  'registeredComplete',
  'completeWithoutCv',
  'approvedCandidates',
  'contractedCandidates'
]);

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDateKey(value) {
  const text = String(value || '').trim();
  if (!DATE_KEY_PATTERN.test(text)) return '';
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return text;
}

function colombiaDayStart(dateKey) {
  if (!dateKey) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 5, 0, 0, 0));
}

function colombiaDayEnd(dateKey) {
  if (!dateKey) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1, 4, 59, 59, 999));
}

export function normalizeCandidateRegistrationRange(source = {}) {
  let dateFrom = validDateKey(source.dateFrom);
  let dateTo = validDateKey(source.dateTo);
  if (dateFrom && dateTo && dateFrom > dateTo) {
    [dateFrom, dateTo] = [dateTo, dateFrom];
  }
  return { dateFrom, dateTo };
}

export function normalizeVacancyRegistrationDateFilters(query = {}) {
  const filters = {};
  for (const [key, rawValue] of Object.entries(query || {})) {
    const match = /^vr_(.+)_(dateFrom|dateTo)$/.exec(String(key));
    if (!match) continue;
    const [, vacancyId, field] = match;
    filters[vacancyId] ||= { dateFrom: '', dateTo: '' };
    filters[vacancyId][field] = validDateKey(rawValue);
  }
  for (const [vacancyId, filter] of Object.entries(filters)) {
    filters[vacancyId] = normalizeCandidateRegistrationRange(filter);
    if (!filters[vacancyId].dateFrom && !filters[vacancyId].dateTo) delete filters[vacancyId];
  }
  return filters;
}

export function buildCandidateRegistrationCreatedAtWhere(range = {}) {
  const normalized = normalizeCandidateRegistrationRange(range);
  const createdAt = {};
  if (normalized.dateFrom) createdAt.gte = colombiaDayStart(normalized.dateFrom);
  if (normalized.dateTo) createdAt.lte = colombiaDayEnd(normalized.dateTo);
  return Object.keys(createdAt).length ? createdAt : null;
}

export function candidateIsInsideRegistrationRange(candidate = {}, range = {}) {
  const createdAtWhere = buildCandidateRegistrationCreatedAtWhere(range);
  if (!createdAtWhere) return true;
  const createdAt = candidate.createdAt instanceof Date ? candidate.createdAt : new Date(candidate.createdAt);
  if (Number.isNaN(createdAt.getTime())) return false;
  if (createdAtWhere.gte && createdAt < createdAtWhere.gte) return false;
  if (createdAtWhere.lte && createdAt > createdAtWhere.lte) return false;
  return true;
}

function registrationTime(candidate = {}) {
  const value = candidate.createdAt instanceof Date ? candidate.createdAt : new Date(candidate.createdAt);
  return Number.isNaN(value.getTime()) ? 0 : value.getTime();
}

export function compareCandidatesByRegistrationDesc(left = {}, right = {}) {
  const timeDifference = registrationTime(right) - registrationTime(left);
  if (timeDifference !== 0) return timeDifference;
  return String(right.id || '').localeCompare(String(left.id || ''), 'es');
}

export function filterAndSortCandidatesByRegistration(candidates = [], range = {}) {
  return [...(candidates || [])]
    .filter((candidate) => candidateIsInsideRegistrationRange(candidate, range))
    .sort(compareCandidatesByRegistrationDesc);
}

export function applyVacancyCandidateRegistrationPolicy(vacancy = {}, range = {}) {
  for (const field of VACANCY_CANDIDATE_LIST_FIELDS) {
    vacancy[field] = filterAndSortCandidatesByRegistration(vacancy[field], range);
  }
  return vacancy;
}

export function buildVacancyRegistrationCandidateWhere(vacancyId, range = {}) {
  const createdAt = buildCandidateRegistrationCreatedAtWhere(range);
  return {
    vacancyId,
    ...(createdAt ? { createdAt } : {})
  };
}
