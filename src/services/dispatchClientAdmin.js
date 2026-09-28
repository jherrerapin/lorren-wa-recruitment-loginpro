import { randomBytes } from 'node:crypto';
import {
  dispatchClientBranchErrorStatus,
  resolveDispatchClientBranchSelection
} from './dispatchClientBranches.js';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function normalizeStringList(value) {
  const source = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return source.map((item) => normalizeString(item)).filter(Boolean);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function initialServiceNames(body = {}) {
  const seen = new Set();
  return normalizeStringList(body.services).filter((name) => {
    const key = normalizeText(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clientProfileData(body = {}, { canManageTestClient = false } = {}) {
  return {
    name: normalizeString(body.name),
    nit: normalizeString(body.nit),
    contactName: normalizeString(body.contactName),
    contactPhone: normalizeString(body.contactPhone),
    contactEmail: normalizeString(body.contactEmail),
    notes: normalizeString(body.notes),
    isActive: normalizeString(body.isActive) !== 'false',
    ...(canManageTestClient ? { isTestClient: normalizeString(body.isTestClient) === 'true' } : {})
  };
}

function requireClientName(data) {
  if (data.name) return;
  const error = new Error('Nombre requerido');
  error.code = 'dispatch_client_name_required';
  throw error;
}

export async function createDispatchClient(prisma, source, body = {}, options = {}) {
  const profile = clientProfileData(body, options);
  requireClientName(profile);
  const branches = await resolveDispatchClientBranchSelection(
    prisma,
    source,
    normalizeStringList(body.cityIds)
  );
  const serviceNames = initialServiceNames(body);
  const createdByUsername = normalizeString(source?.session?.username || source?.username);

  return prisma.dispatchClient.create({
    data: {
      ...profile,
      branchCityIds: branches.branchCityIds,
      cityName: branches.cityName,
      publicToken: randomBytes(24).toString('hex'),
      createdByUsername,
      ...(serviceNames.length ? {
        services: {
          create: serviceNames.map((name) => ({ name, createdByUsername }))
        }
      } : {})
    }
  });
}

export async function updateDispatchClient(prisma, source, clientId, body = {}, options = {}) {
  const existing = await prisma.dispatchClient.findUnique({
    where: { id: clientId },
    select: { id: true, cityName: true, branchCityIds: true }
  });
  if (!existing) {
    const error = new Error('Cliente no encontrado');
    error.code = 'dispatch_client_not_found';
    throw error;
  }

  const profile = clientProfileData(body, options);
  requireClientName(profile);
  const branches = await resolveDispatchClientBranchSelection(
    prisma,
    source,
    normalizeStringList(body.cityIds),
    { existingClient: existing }
  );

  return prisma.dispatchClient.update({
    where: { id: existing.id },
    data: {
      ...profile,
      branchCityIds: branches.branchCityIds,
      cityName: branches.cityName
    }
  });
}

export function dispatchClientAdminErrorStatus(error) {
  if (error?.code === 'dispatch_client_not_found') return 404;
  if (error?.code === 'dispatch_client_name_required') return 400;
  return dispatchClientBranchErrorStatus(error);
}
