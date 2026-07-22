import express from 'express';
import { issuePrimaryDeviceActivation } from '../modules/dispatch-attendance/application/primaryDeviceActivation.js';
import { createPrismaPrimaryDeviceActivationRepository } from '../modules/dispatch-attendance/infrastructure/prismaPrimaryDeviceActivationRepository.js';
import { buildWorkerPortalActivationUrl } from './workerPortal.js';

const ACTIVE_DISPATCH_WORKER_STATUS = 'CONTRATADO';
const DEFAULT_ACTIVATION_TTL_MINUTES = 30;
const ADMIN_REQUEST_HEADER = 'attendance-admin';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

function setNoStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function currentRole(req) {
  return normalizeString(req.session?.userRole || req.userRole)?.toLowerCase();
}

function currentUsername(req) {
  return normalizeString(req.session?.username || req.username) || 'dev';
}

function requireDev(req, res, next) {
  setNoStore(res);
  if (!currentRole(req)) {
    if (req.method === 'GET') return res.redirect('/login');
    return res.status(401).json({ ok: false, error: 'authentication_required' });
  }
  if (currentRole(req) !== 'dev') {
    if (req.method === 'GET') return res.status(403).send('Acceso restringido a DEV');
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  return next();
}

function requireAdminJson(req, res, next) {
  if (req.get?.('x-requested-with') !== ADMIN_REQUEST_HEADER || !req.is?.('application/json')) {
    return res.status(400).json({ ok: false, error: 'activation_request_invalid' });
  }
  return next();
}

function normalizeOriginCandidate(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return normalized.includes('://') ? normalized : `https://${normalized}`;
}

export function resolveWorkerPortalPublicOrigin(env = process.env) {
  const explicit = normalizeOriginCandidate(env.ATTENDANCE_PORTAL_PUBLIC_ORIGIN);
  const railway = normalizeString(env.RAILWAY_PUBLIC_DOMAIN);
  const candidate = explicit || (railway ? `https://${railway}` : null);
  if (!candidate) throw new Error('attendance_portal_public_origin_required');

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('attendance_portal_public_origin_invalid');
  }

  if (url.protocol !== 'https:') throw new Error('attendance_portal_public_origin_https_required');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('attendance_portal_public_origin_invalid');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('attendance_portal_public_origin_path_not_allowed');
  }
  return url.origin;
}

function activationTtlMinutes(env = process.env) {
  const raw = normalizeString(env.ATTENDANCE_ACTIVATION_TTL_MINUTES);
  return raw ? Number(raw) : DEFAULT_ACTIVATION_TTL_MINUTES;
}

function safeErrorCode(error) {
  const candidate = typeof error?.message === 'string' ? error.message : 'unknown';
  return /^[A-Za-z0-9_]{1,100}$/.test(candidate) ? candidate : 'worker_portal_activation_admin_error';
}

function contractTypeLabel(value) {
  return normalizeString(value)?.toUpperCase() === 'CONTRATISTA' ? 'Contratista' : 'Directo';
}

function workerLabel(worker) {
  return `${worker.fullName} · ${contractTypeLabel(worker.contractType)}`;
}

async function loadActiveWorkers(prisma) {
  return prisma.dispatchWorker.findMany({
    where: { operationalStatus: ACTIVE_DISPATCH_WORKER_STATUS },
    select: {
      id: true,
      fullName: true,
      contractType: true,
      operationalStatus: true,
      isTestProfile: true
    },
    orderBy: { fullName: 'asc' }
  });
}

async function findActiveWorker(prisma, workerId) {
  return prisma.dispatchWorker.findFirst({
    where: {
      id: workerId,
      operationalStatus: ACTIVE_DISPATCH_WORKER_STATUS
    },
    select: {
      id: true,
      fullName: true,
      contractType: true,
      operationalStatus: true,
      isTestProfile: true
    }
  });
}

export function dispatchWorkerPortalActivationAdminRouter(prisma, options = {}) {
  const router = express.Router();
  const issueActivationFn = options.issueActivationFn || issuePrimaryDeviceActivation;
  const repositoryFactory = options.repositoryFactory || (() => createPrismaPrimaryDeviceActivationRepository(prisma));
  const buildActivationUrlFn = options.buildActivationUrlFn || buildWorkerPortalActivationUrl;
  const resolveOriginFn = options.resolveOriginFn || (() => resolveWorkerPortalPublicOrigin(options.env || process.env));
  const loadWorkersFn = options.loadWorkersFn || (() => loadActiveWorkers(prisma));
  const findWorkerFn = options.findWorkerFn || ((workerId) => findActiveWorker(prisma, workerId));
  const nowFn = options.nowFn || (() => new Date());
  const ttlMinutes = options.ttlMinutes ?? activationTtlMinutes(options.env || process.env);
  let repository = options.repository || null;

  function getRepository() {
    if (!repository) repository = repositoryFactory();
    if (!repository) throw new Error('activation_repository_unavailable');
    return repository;
  }

  router.get('/', requireDev, async (req, res) => {
    try {
      const workers = await loadWorkersFn();
      return res.render('operacionesPortalActivaciones', {
        role: currentRole(req),
        workers: workers.map((worker) => ({
          id: worker.id,
          label: workerLabel(worker),
          fullName: worker.fullName,
          contractType: contractTypeLabel(worker.contractType),
          isTestProfile: Boolean(worker.isTestProfile)
        })),
        defaultTtlMinutes: ttlMinutes
      });
    } catch (error) {
      console.error('[WORKER_PORTAL_ACTIVATION_ADMIN_LIST_FAILED]', { code: safeErrorCode(error) });
      return res.status(503).render('operacionesPortalActivaciones', {
        role: currentRole(req),
        workers: [],
        defaultTtlMinutes: ttlMinutes,
        loadError: 'No fue posible cargar el personal operativo.'
      });
    }
  });

  router.post('/emitir', requireDev, requireAdminJson, async (req, res) => {
    const workerId = normalizeString(req.body?.workerId);
    if (!workerId) return res.status(400).json({ ok: false, error: 'worker_required' });

    try {
      const worker = await findWorkerFn(workerId);
      if (!worker) return res.status(404).json({ ok: false, error: 'worker_not_active' });

      const now = nowFn();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('activation_admin_now_invalid');
      }

      const activation = await issueActivationFn({
        repository: getRepository(),
        workerId: worker.id,
        createdByUsername: currentUsername(req),
        now,
        ttlMinutes
      });
      const activationUrl = buildActivationUrlFn(resolveOriginFn(), activation.rawToken);

      return res.status(201).json({
        ok: true,
        worker: {
          id: worker.id,
          fullName: worker.fullName,
          contractType: contractTypeLabel(worker.contractType),
          isTestProfile: Boolean(worker.isTestProfile)
        },
        activationUrl,
        expiresAt: activation.expiresAt.toISOString()
      });
    } catch (error) {
      const code = safeErrorCode(error);
      if (code === 'activation_worker_not_active') {
        return res.status(409).json({ ok: false, error: 'worker_not_active' });
      }
      if (code.startsWith('attendance_portal_public_origin_') || code.startsWith('activation_prisma_') || code === 'activation_repository_unavailable') {
        console.error('[WORKER_PORTAL_ACTIVATION_ADMIN_CONFIGURATION_FAILED]', { code });
        return res.status(503).json({ ok: false, error: 'activation_service_unavailable' });
      }
      console.error('[WORKER_PORTAL_ACTIVATION_ADMIN_FAILED]', { code });
      return res.status(500).json({ ok: false, error: 'activation_failed' });
    }
  });

  return router;
}

export const WORKER_PORTAL_ACTIVATION_ADMIN_HEADER = ADMIN_REQUEST_HEADER;
