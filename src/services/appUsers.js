import { randomInt } from 'node:crypto';

export const USER_ACCESS_SCOPES = ['ALL', 'CITY', 'VACANCY'];

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function uniqueNormalizedStrings(values = []) {
  return [...new Set(values.map(normalizeString).filter(Boolean))];
}

function parseUserAccessMetadata(value) {
  if (Array.isArray(value)) {
    return {
      cities: uniqueNormalizedStrings(value),
      vacancyIds: []
    };
  }

  const normalized = normalizeString(value);
  if (!normalized) return { cities: [], vacancyIds: [] };

  if (normalized.startsWith('{')) {
    try {
      const parsed = JSON.parse(normalized);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          cities: uniqueNormalizedStrings(Array.isArray(parsed.cities) ? parsed.cities : []),
          vacancyIds: uniqueNormalizedStrings(Array.isArray(parsed.vacancyIds) ? parsed.vacancyIds : [])
        };
      }
    } catch (_error) {
      // Conserva compatibilidad con valores históricos que no sean JSON válido.
    }
  }

  if (normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        return {
          cities: uniqueNormalizedStrings(parsed),
          vacancyIds: []
        };
      }
    } catch (_error) {
      // Conserva compatibilidad con valores históricos que no sean JSON válido.
    }
  }

  return {
    cities: [normalized],
    vacancyIds: []
  };
}

/**
 * Convierte el valor histórico de scopeCity en una lista de ciudades.
 *
 * Compatibilidad:
 * - Usuarios antiguos: "Bogotá"
 * - Usuarios con acceso territorial anterior: '["Bogotá","Ibagué"]'
 * - Usuarios con vacantes seleccionadas: '{"cities":["Bogotá"],"vacancyIds":["vac-1"]}'
 */
export function normalizeUserAccessCities(value) {
  return parseUserAccessMetadata(value).cities;
}

export function normalizeUserAccessVacancyIds(value, fallbackVacancyId = null) {
  return uniqueNormalizedStrings([
    ...parseUserAccessMetadata(value).vacancyIds,
    fallbackVacancyId
  ]);
}

export function encodeUserAccessCities(cities = []) {
  const normalized = uniqueNormalizedStrings(cities);
  if (!normalized.length) return null;
  if (normalized.length === 1) return normalized[0];
  return JSON.stringify(normalized);
}

export function encodeUserAccessSelection({ cities = [], vacancyIds = [] } = {}) {
  const normalizedCities = uniqueNormalizedStrings(cities);
  const normalizedVacancyIds = uniqueNormalizedStrings(vacancyIds);
  if (!normalizedCities.length && !normalizedVacancyIds.length) return null;
  return JSON.stringify({
    cities: normalizedCities,
    vacancyIds: normalizedVacancyIds
  });
}

export function toSlug(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeUserAccessScope(value) {
  const normalized = normalizeString(value)?.toUpperCase();
  return USER_ACCESS_SCOPES.includes(normalized) ? normalized : 'ALL';
}

export function buildRecruiterUsernameBase({ accessScope, scopeCity, vacancyTitle } = {}) {
  const scope = normalizeUserAccessScope(accessScope);
  if (scope === 'CITY') {
    const [firstCity] = normalizeUserAccessCities(scopeCity);
    return `reclutador-${toSlug(firstCity) || 'ciudad'}`;
  }
  if (scope === 'VACANCY') {
    return `reclutador-${toSlug(vacancyTitle) || 'vacante'}`;
  }
  return 'reclutador-general';
}

export async function buildUniqueRecruiterUsername(prisma, options = {}) {
  const base = buildRecruiterUsernameBase(options);
  const existingUsers = await prisma.appUser.findMany({
    where: {
      username: {
        startsWith: base
      }
    },
    select: { username: true }
  });

  const used = new Set(existingUsers.map((user) => user.username));
  if (!used.has(base)) return base;

  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export function generateRecoveryCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function getAccessContext(source = {}) {
  const role = source.userRole || null;
  const scope = role === 'dev'
    ? 'ALL'
    : normalizeUserAccessScope(source.userAccessScope || 'ALL');
  const rawAccessSelection = source.userAccessSelection
    ?? source.userAccessCities
    ?? source.userAccessCity;
  const cities = normalizeUserAccessCities(rawAccessSelection);
  const vacancyIds = normalizeUserAccessVacancyIds(rawAccessSelection, source.userAccessVacancyId);

  return {
    role,
    username: source.username || null,
    userId: source.userId || null,
    scope,
    city: cities[0] || null,
    cities,
    vacancyId: vacancyIds[0] || null,
    vacancyIds,
    isDev: role === 'dev',
    isAdmin: role === 'admin'
  };
}

export function hasFullAccess(context = {}) {
  return context.isDev || context.scope === 'ALL';
}

function accessVacancyIds(context = {}) {
  return uniqueNormalizedStrings([
    ...(Array.isArray(context.vacancyIds) ? context.vacancyIds : []),
    context.vacancyId
  ]);
}

function vacancyIdFilter(vacancyIds = []) {
  if (!vacancyIds.length) return '__OUT_OF_SCOPE__';
  if (vacancyIds.length === 1) return vacancyIds[0];
  return { in: vacancyIds };
}

export function buildVacancyAccessWhere(context = {}) {
  if (hasFullAccess(context)) return {};

  const vacancyIds = accessVacancyIds(context);
  if (vacancyIds.length) {
    return { id: vacancyIdFilter(vacancyIds) };
  }

  if (context.scope === 'CITY') {
    const cities = normalizeUserAccessCities(context.cities?.length ? context.cities : context.city);
    return cities.length
      ? { city: { in: cities } }
      : { city: '__OUT_OF_SCOPE__' };
  }

  return { id: '__OUT_OF_SCOPE__' };
}

export function buildCandidateAccessWhere(context = {}) {
  if (hasFullAccess(context)) return {};

  const vacancyIds = accessVacancyIds(context);
  if (vacancyIds.length) {
    return { vacancyId: vacancyIdFilter(vacancyIds) };
  }

  if (context.scope === 'CITY') {
    const cities = normalizeUserAccessCities(context.cities?.length ? context.cities : context.city);
    return cities.length
      ? {
          vacancy: {
            city: { in: cities }
          }
        }
      : {
          vacancy: {
            city: '__OUT_OF_SCOPE__'
          }
        };
  }

  return { vacancyId: '__OUT_OF_SCOPE__' };
}

export function canAccessVacancy(context = {}, vacancy = {}) {
  if (hasFullAccess(context)) return true;

  const vacancyIds = accessVacancyIds(context);
  if (vacancyIds.length) return vacancyIds.includes(normalizeString(vacancy?.id));

  if (context.scope === 'CITY') {
    const cities = normalizeUserAccessCities(context.cities?.length ? context.cities : context.city);
    return cities.includes(normalizeString(vacancy?.city));
  }

  return false;
}

export function canAccessCandidate(context = {}, candidate = {}) {
  if (hasFullAccess(context)) return true;

  const vacancyIds = accessVacancyIds(context);
  if (vacancyIds.length) {
    const candidateVacancyId = normalizeString(candidate?.vacancyId)
      || normalizeString(candidate?.vacancy?.id);
    return vacancyIds.includes(candidateVacancyId);
  }

  if (context.scope === 'CITY') {
    const cities = normalizeUserAccessCities(context.cities?.length ? context.cities : context.city);
    return cities.includes(normalizeString(candidate?.vacancy?.city));
  }

  return false;
}

export function describeUserScope(user = {}) {
  const scope = normalizeUserAccessScope(user.accessScope);
  const vacancyIds = normalizeUserAccessVacancyIds(user.scopeCity, user.scopeVacancyId);

  if (vacancyIds.length) {
    const selectedVacancies = Array.isArray(user.selectedVacancies)
      ? user.selectedVacancies
      : Array.isArray(user.vacancies)
        ? user.vacancies
        : [];
    if (selectedVacancies.length === 1) {
      const vacancy = selectedVacancies[0];
      return `Vacante: ${vacancy.title || vacancy.role || vacancy.id}`;
    }
    if (selectedVacancies.length > 1) {
      return `${selectedVacancies.length} vacantes seleccionadas`;
    }
    if (vacancyIds.length === 1 && user.scopeVacancy?.title) {
      return `Vacante: ${user.scopeVacancy.title}`;
    }
    return `${vacancyIds.length} vacante${vacancyIds.length === 1 ? '' : 's'} seleccionada${vacancyIds.length === 1 ? '' : 's'}`;
  }

  if (scope === 'CITY') {
    const cities = normalizeUserAccessCities(user.scopeCity);
    if (!cities.length) return 'Ciudades: Sin ciudad';
    return `${cities.length === 1 ? 'Ciudad' : 'Ciudades'}: ${cities.join(', ')}`;
  }

  if (scope === 'VACANCY') {
    return `Vacante: ${user.scopeVacancy?.title || user.scopeVacancyId || 'Sin vacante'}`;
  }

  return 'Todas las vacantes';
}
