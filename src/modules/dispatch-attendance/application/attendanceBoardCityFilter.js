function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

export function attendanceCitiesForRows(rows = []) {
  return [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => normalizeString(row?.cityName))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'es'));
}

export function applyAttendanceCityFilter(board = {}, requestedCity) {
  const sourceRows = Array.isArray(board?.rows) ? board.rows : [];
  const cities = attendanceCitiesForRows(sourceRows);
  const requested = normalizeString(requestedCity) || 'ALL';
  const city = requested === 'ALL' || cities.includes(requested) ? requested : 'ALL';
  const rows = city === 'ALL'
    ? sourceRows
    : sourceRows.filter((row) => row?.cityName === city);

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
