import {
  operationalCityIdsAllowed,
  operationalCityNamesEquivalent,
  resolveUserCityScope
} from './cityOptions.js';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

export function normalizeDispatchClientBranchIds(value) {
  const source = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return [...new Set(source.map((item) => normalizeString(item)).filter(Boolean))];
}

export function dispatchClientBranchIds(client = {}) {
  return normalizeDispatchClientBranchIds(client?.branchCityIds);
}

export function dispatchClientBranchNames(client = {}, cities = []) {
  const namesById = new Map((Array.isArray(cities) ? cities : [])
    .map((city) => [normalizeString(city?.id), normalizeString(city?.name)])
    .filter(([id, name]) => id && name));
  const names = dispatchClientBranchIds(client)
    .map((cityId) => namesById.get(cityId))
    .filter(Boolean);
  if (names.length) return names;
  const legacy = normalizeString(client?.cityName);
  return legacy ? [legacy] : [];
}

function branchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Canonical write authority for a client's operational branches.
 *
 * Restricted users may replace only the branches inside their own territorial
 * scope. Existing branches outside that scope are preserved so editing a client
 * never destroys information the actor was not authorized to manage.
 */
export async function resolveDispatchClientBranchSelection(
  prisma,
  source,
  requestedCityIds,
  { existingClient = null } = {}
) {
  const requestedIds = normalizeDispatchClientBranchIds(requestedCityIds);
  if (!requestedIds.length) {
    throw branchError('dispatch_client_branch_required', 'Selecciona al menos una sucursal operativa.');
  }

  const scope = await resolveUserCityScope(prisma, source);
  if (!operationalCityIdsAllowed(scope, requestedIds)) {
    throw branchError(
      'dispatch_client_branch_scope_forbidden',
      'Una o más sucursales seleccionadas están fuera de tu alcance territorial.'
    );
  }

  const allowedIds = new Set(scope.allowedCityIds || []);
  const preservedIds = scope.restricted
    ? dispatchClientBranchIds(existingClient).filter((cityId) => !allowedIds.has(cityId))
    : [];
  const branchCityIds = [...new Set([...preservedIds, ...requestedIds])];

  const cities = await prisma.city.findMany({
    where: { id: { in: branchCityIds } },
    select: { id: true, name: true }
  });
  if (cities.length !== branchCityIds.length) {
    throw branchError('dispatch_client_branch_invalid', 'Una o más sucursales seleccionadas ya no existen.');
  }

  const cityById = new Map(cities.map((city) => [city.id, city]));
  const branchNames = branchCityIds.map((cityId) => cityById.get(cityId)?.name).filter(Boolean);
  const legacyPrimary = normalizeString(existingClient?.cityName);
  const cityName = legacyPrimary && branchNames.some((name) => operationalCityNamesEquivalent(name, legacyPrimary))
    ? legacyPrimary
    : cityById.get(requestedIds[0])?.name || branchNames[0] || null;

  return {
    branchCityIds,
    cityName,
    selectedCities: branchCityIds.map((cityId) => cityById.get(cityId)).filter(Boolean),
    scope
  };
}

export function dispatchClientBranchErrorStatus(error) {
  if (error?.code === 'dispatch_client_branch_scope_forbidden') return 403;
  if (error?.code === 'dispatch_client_branch_required' || error?.code === 'dispatch_client_branch_invalid') return 400;
  return 500;
}
