export function normalizeCityKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function dedupeCitiesByNormalizedName(cities = []) {
  const seen = new Set();
  const result = [];

  for (const city of cities) {
    const key = normalizeCityKey(city?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(city);
  }

  return result.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es'));
}

export async function loadUnifiedCityOptions(prisma) {
  const cities = await prisma.city.findMany({ orderBy: { name: 'asc' } });
  return dedupeCitiesByNormalizedName(cities);
}

export async function resolveEquivalentCityIds(prisma, cityId) {
  if (!cityId) return [];

  const selectedCity = await prisma.city.findUnique({ where: { id: cityId }, select: { id: true, name: true } });
  if (!selectedCity) return [cityId];

  const selectedKey = normalizeCityKey(selectedCity.name);
  const cities = await prisma.city.findMany({ select: { id: true, name: true } });

  const equivalentIds = cities
    .filter((city) => normalizeCityKey(city.name) === selectedKey)
    .map((city) => city.id);

  return equivalentIds.length ? equivalentIds : [selectedCity.id];
}
