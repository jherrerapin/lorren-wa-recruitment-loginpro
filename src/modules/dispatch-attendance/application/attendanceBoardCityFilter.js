import {
  canonicalOperationalBranchName,
  operationalCityNamesEquivalent
} from '../../../services/cityOptions.js';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

function branchName(value) {
  return canonicalOperationalBranchName(normalizeString(value));
}

export function attendanceCitiesForRows(rows = []) {
  return [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => branchName(row?.cityName))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'es'));
}

export function applyAttendanceCityFilter(board = {}, requestedCity) {
  const sourceRows = Array.isArray(board?.rows) ? board.rows : [];
  const cities = attendanceCitiesForRows(sourceRows);
  const requested = normalizeString(requestedCity);
  const city = requested && requested !== 'ALL' ? (branchName(requested) || requested) : 'ALL';
  const rows = city === 'ALL'
    ? sourceRows
    : sourceRows.filter((row) => operationalCityNamesEquivalent(row?.cityName, city));

  return {
    ...board,
    filters: {
      ...(board?.filters || {}),
      city
    },
    cities,
    rows
  };
}
