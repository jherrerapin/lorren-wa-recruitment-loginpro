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

/**
 * Convierte el valor histórico de scopeCity en una lista de ciudades.
 *
 * Compatibilidad:
 * - Usuarios antiguos: "Bogotá"
 * - Usuarios con acceso múltiple: '["Bogotá","Ibagué"]'
 * - Sesiones ya normalizadas: ["Bogotá", "Ibagué"]
 */
export function normalizeUserAccessCities(value) {
  if (Array.isArray(value)) return uniqueNormalizedStrings(value);

  const normalized = normalizeString(value);
  if (!normalized) return [];

  if (normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) return uniqueNormalizedStrings(parsed);
    } catch (_error) {
      // Conserva compatibilidad con valores históricos que no sean JSON válido.
    }
  }

  return [normalized];
}

export function encodeUserAccessCities(cities = []) {
  const normalized = uniqueNormalizedStrings(cities);
  if (!normalized.length) return null;
  if (normalized.length === 1) return normalized[0];
  return JSON.stringify(normalized);
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
  const cities = normalizeUserAccessCities(source.userAccessCities ?? source.userAccessCity);

  return {
    role,
    username: source.username || null,
    userId: source.userId || null,
    scope,
    city: cities[0] || null,
    cities,
    vacancyId: normalizeString(source.userAccessVacancyId),
    isDev: role === 'dev',
    isAdmin: role === 'admin'
  };
}

export function hasFullAccess(context = {}) {
  return context.isDev || context.scope === 'ALL';
}

export function buildVacancyAccessWhere(context = {}) {
  if (hasFullAccess(context)) return {};
  if (context.scope === 'CITY') {
    const cities = normalizeUserAccessCities(context.cities?.length ? context.cities : context.city);
    return cities.length
      ? { city: { in: cities } }
      : { city: '__OUT_OF_SCOPE__' };
  }
  if (context.scope === 'VACANCY') {
    return { id: context.vacancyId || '__OUT_OF_SCOPE__' };
  }
  return {};
}

export function buildCandidateAccessWhere(context = {}) {
  if (hasFullAccess(context)) return {};
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
  if (context.scope === 'VACANCY') {
    return { vacancyId: context.vacancyId || '__OUT_OF_SCOPE__' };
  }
  return {};
}

export function canAccessVacancy(context = {}, vacancy = {}) {
  if (hasFullAccess(context)) return true;
  if (context.scope === 'CITY') {
    const cities = normalizeUserAccessCities(context.cities?.length ? context.cities : context.city);
    return cities.includes(normalizeString(vacancy?.city));
  }
  if (context.scope === 'VACANCY') {
    return vacancy?.id === context.vacancyId;
  }
  return false;
}

export function canAccessCandidate(context = {}, candidate = {}) {
  if (hasFullAccess(context)) return true;
  if (context.scope === 'CITY') {
    const cities = normalizeUserAccessCities(context.cities?.length ? context.cities : context.city);
    return cities.includes(normalizeString(candidate?.vacancy?.city));
  }
  if (context.scope === 'VACANCY') {
    return candidate?.vacancyId === context.vacancyId || candidate?.vacancy?.id === context.vacancyId;
  }
  return false;
}

export function describeUserScope(user = {}) {
  const scope = normalizeUserAccessScope(user.accessScope);
  if (scope === 'CITY') {
    const cities = normalizeUserAccessCities(user.scopeCity);
    if (!cities.length) return 'Ciudades: Sin ciudad';
    return `${cities.length === 1 ? 'Ciudad' : 'Ciudades'}: ${cities.join(', ')}`;
  }
  if (scope === 'VACANCY') return `Vacante: ${user.scopeVacancy?.title || user.scopeVacancyId || 'Sin vacante'}`;
  return 'Todas las vacantes';
}
