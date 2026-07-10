import express from 'express';
import { prisma } from '../lib/prisma.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const ASSIGNMENT_UI_FIXES_SCRIPT = '<script src="/public/dispatch-assignment-ui-fixes.js?v=20260710-ui1" defer></script>';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeText(value) {
  return normalizeString(value)?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() || '';
}

function isBogotaSiberiaName(cityName) {
  const normalized = normalizeText(cityName);
  return normalized === 'bogota' || normalized === 'bogota d.c.' || normalized === 'bogota dc' || normalized === 'siberia';
}

function isOpsUser(req) {
  const username = normalizeString(req.session?.username || req.username);
  return Boolean(username?.startsWith('operaciones-despacho'));
}

function canUseOps(req) {
  const role = req.session?.userRole || req.userRole;
  const canAccessDispatch = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch);
  return role === 'dev' || canAccessDispatch || isOpsUser(req);
}

function requireOps(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (!role) return res.redirect('/login');
  if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario');
  return next();
}

async function resolveCompatibleOperationalCityIds(operationalCityId) {
  if (!operationalCityId) return [];
  const selectedCity = await prisma.city.findFirst({ where: { id: operationalCityId, usedForDispatch: true }, select: { id: true, name: true } });
  if (!selectedCity) return [operationalCityId];
  if (!isBogotaSiberiaName(selectedCity.name)) return [selectedCity.id];
  const cities = await prisma.city.findMany({ where: { usedForDispatch: true }, select: { id: true, name: true } });
  const compatibleIds = cities.filter((city) => isBogotaSiberiaName(city.name)).map((city) => city.id);
  return compatibleIds.length ? compatibleIds : [selectedCity.id];
}

function buildOperationalCityFilter(compatibleOperationalCityIds) {
  if (!compatibleOperationalCityIds.length) return {};
  return { cities: { some: { cityId: { in: compatibleOperationalCityIds } } } };
}

async function loadDispatchCities() {
  return prisma.city.findMany({ where: { usedForDispatch: true }, orderBy: { name: 'asc' } });
}

function renderAssignmentsBoard(res, locals) {
  return res.render('operacionesAsignacionesConfirmacion', locals, (error, html) => {
    if (error) throw error;
    const output = typeof html === 'string' && html.includes('</body>') && !html.includes('/public/dispatch-assignment-ui-fixes.js')
      ? html.replace('</body>', `${ASSIGNMENT_UI_FIXES_SCRIPT}\n</body>`)
      : html;
    return res.send(output);
  });
}

export function dispatchAssignmentConfirmationsRouter() {
  const router = express.Router();

  router.get('/asignaciones', requireOps, async (req, res, next) => {
    try {
      const q = normalizeString(req.query.q);
      const operationalCityId = normalizeString(req.query.operationalCityId);
      const vacancyId = normalizeString(req.query.vacancyId);
      const transportMode = normalizeString(req.query.transportMode);
      const locality = normalizeString(req.query.locality);
      const status = normalizeString(req.query.status);
      const serviceRequestId = normalizeString(req.query.serviceRequestId);

      const compatibleOperationalCityIds = await resolveCompatibleOperationalCityIds(operationalCityId);
      const operationalCityFilter = buildOperationalCityFilter(compatibleOperationalCityIds);
      const baseWorkerWhere = {
        ...(status ? { operationalStatus: status } : {}),
        ...(q ? { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { documentNumber: { contains: q, mode: 'insensitive' } }, { phone: { contains: q, mode: 'insensitive' } }] } : {}),
        ...operationalCityFilter,
        ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}),
        ...(transportMode ? { transportMode } : {}),
        ...(locality ? { residenceLocality: locality } : {})
      };

      const localityWhere = {
        ...operationalCityFilter,
        ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}),
        ...(transportMode ? { transportMode } : {}),
        ...(status ? { operationalStatus: status } : {})
      };

      const [workers, cities, vacancies, transportModeRows, localityRows, serviceRequests, clients] = await Promise.all([
        prisma.dispatchWorker.findMany({ where: baseWorkerWhere, include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } }, orderBy: { createdAt: 'desc' } }),
        loadDispatchCities(),
        prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } }),
        prisma.dispatchWorker.findMany({ select: { transportMode: true }, distinct: ['transportMode'], orderBy: { transportMode: 'asc' } }),
        prisma.dispatchWorker.findMany({ where: localityWhere, select: { residenceLocality: true }, distinct: ['residenceLocality'], orderBy: { residenceLocality: 'asc' } }),
        prisma.dispatchServiceRequest.findMany({ include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }] }),
        prisma.dispatchClient.findMany({ where: { isActive: true }, include: { operationPoints: { where: { isActive: true }, orderBy: { name: 'asc' } }, services: { where: { isActive: true }, orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } })
      ]);

      const selectedServiceRequest = serviceRequestId ? serviceRequests.find((item) => item.id === serviceRequestId) || null : serviceRequests[0] || null;
      const blockedWorkerIds = new Set(selectedServiceRequest ? selectedServiceRequest.assignments.map((assignment) => assignment.workerId) : []);
      const availableWorkers = workers.filter((worker) => !blockedWorkerIds.has(worker.id));

      return renderAssignmentsBoard(res, {
        activeStatuses: ACTIVE_ASSIGNMENT_STATUSES,
        workers,
        availableWorkers,
        cities,
        vacancies,
        serviceRequests,
        selectedServiceRequest,
        selectedServiceRequestId: selectedServiceRequest?.id || '',
        clients,
        message: normalizeString(req.query.message),
        filters: { q: q || '', operationalCityId: operationalCityId || '', vacancyId: vacancyId || '', transportMode: transportMode || '', locality: locality || '', status: status || '' },
        transportModes: transportModeRows.map((row) => row.transportMode).filter(Boolean),
        localities: localityRows.map((row) => row.residenceLocality).filter(Boolean),
        role: req.session?.userRole || req.userRole,
        canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
