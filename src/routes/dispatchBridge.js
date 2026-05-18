import express from 'express';
import { prisma } from '../lib/prisma.js';
import { upsertDispatchWorkerFromCandidate } from '../services/dispatchWorkerSync.js';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
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


function requireDev(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (role !== 'dev') return res.status(403).send('Solo DEV');
  return next();
}

function renderOperationsDashboard(res, options = {}) {
  return res.render('operacionesDashboard', {
    pageTitle: 'Operaciones / Despacho',
    subtitle: 'Gestión operativa de solicitudes, asignaciones, novedades y reemplazos.',
    activeSection: 'dashboard',
    ...options
  });
}

export function dispatchBridgeRouter() {
  const router = express.Router();

  router.get('/', requireOps, (_req, res) => {
    return renderOperationsDashboard(res);
  });

  router.get('/abrir', requireOps, (_req, res) => {
    return renderOperationsDashboard(res);
  });

  router.get('/solicitudes', requireOps, (_req, res) => {
    return renderOperationsDashboard(res, {
      pageTitle: 'Solicitudes operativas',
      activeSection: 'solicitudes'
    });
  });

  router.get('/asignaciones', requireOps, (_req, res) => {
    return renderOperationsDashboard(res, {
      pageTitle: 'Asignaciones operativas',
      activeSection: 'asignaciones'
    });
  });


  router.get('/personal', requireOps, async (req, res) => {
    const operationalCityId = normalizeString(req.query.operationalCityId);
    const vacancyId = normalizeString(req.query.vacancyId);
    const status = normalizeString(req.query.status);

    const workers = await prisma.dispatchWorker.findMany({
      where: {
        ...(status ? { operationalStatus: status } : {}),
        ...(operationalCityId ? { cities: { some: { cityId: operationalCityId } } } : {}),
        ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {})
      },
      include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const cities = await prisma.city.findMany({ orderBy: { name: 'asc' } });
    const vacancies = await prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } });

    return res.render('operacionesPersonal', {
      pageTitle: 'Personal operativo',
      subtitle: 'Equipo disponible para asignación.',
      activeSection: 'personal',
      workers,
      cities,
      vacancies,
      filters: { operationalCityId: operationalCityId || '', vacancyId: vacancyId || '', status: status || '' },
      message: normalizeString(req.query.message),
      role: req.userRole,
      canAccessDispatch: req.canAccessDispatch
    });
  });

  router.post('/sync-contratados', requireOps, requireDev, async (_req, res) => {
    const contracted = await prisma.candidate.findMany({ where: { status: 'CONTRATADO' }, select: { id: true } });
    for (const candidate of contracted) await upsertDispatchWorkerFromCandidate(prisma, candidate.id);
    return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent(`Sincronización completada: ${contracted.length} contratados procesados.`)}`);
  });

  router.get('/novedades', requireOps, (_req, res) => {
    return renderOperationsDashboard(res, {
      pageTitle: 'Novedades operativas',
      activeSection: 'novedades'
    });
  });

  return router;
}
