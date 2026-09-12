import express from 'express';
import { prisma } from './lib/prisma.js';
import { approvedOutreachActionsRouter } from './routes/approvedOutreachActions.js';

const PATCH_MARK = Symbol.for('lorren.approvedOutreachActionsRegistered');
const APP_MOUNT_MARK = Symbol.for('lorren.approvedOutreachActionsMounted');
const APPROVAL_HOOK_MARK = Symbol.for('lorren.approvedOutreachStatusHook');

export function shouldTriggerApprovedOutreach(previousStatus, nextStatus) {
  const previous = String(previousStatus || '').trim().toUpperCase();
  const next = String(nextStatus || '').trim().toUpperCase();
  return next === 'APROBADO' && previous !== 'APROBADO';
}

function findRouteLayer(router, path, method = 'post') {
  if (!router || !Array.isArray(router.stack)) return null;
  return router.stack.find((layer) => (
    layer?.route?.path === path
    && layer.route.methods?.[method] === true
  )) || null;
}

function findFinalRouteHandler(router, path, method = 'post') {
  const routeLayer = findRouteLayer(router, path, method);
  if (!routeLayer || !Array.isArray(routeLayer.route?.stack)) return null;
  const handlers = routeLayer.route.stack.filter((layer) => typeof layer?.handle === 'function');
  return handlers.length ? handlers[handlers.length - 1] : null;
}

function isRecruitmentAdminRouter(handler) {
  if (!handler || !Array.isArray(handler.stack)) return false;
  const routePaths = new Set(handler.stack
    .map((layer) => layer?.route?.path)
    .filter((path) => typeof path === 'string'));
  return routePaths.has('/outreach/approved')
    && routePaths.has('/outreach/approved/prepare')
    && routePaths.has('/candidates/:id/status')
    && routePaths.has('/candidates/:id/edit');
}

function redirectTargetFromArgs(args = []) {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (typeof args[index] === 'string') return args[index];
  }
  return '/admin';
}

function withApprovalFlash(target, type, message) {
  const safeTarget = String(target || '').startsWith('/admin') ? String(target) : '/admin';
  const url = new URL(safeTarget, 'https://admin.local');
  url.searchParams.delete('success');
  url.searchParams.delete('error');
  url.searchParams.set(type, message);
  return `${url.pathname}${url.search}`;
}

function redirectWithCapturedSignature(originalRedirect, args, target) {
  if (typeof args?.[0] === 'number') return originalRedirect(args[0], target);
  return originalRedirect(target);
}

async function loadCandidateStatus(prismaClient, candidateId) {
  if (!candidateId) return null;
  const candidate = await prismaClient.candidate.findUnique({
    where: { id: candidateId },
    select: { status: true }
  });
  return candidate?.status || null;
}

async function invokeApprovedOutreachPrepare(adminRouter, req, candidateId) {
  const prepareLayer = findFinalRouteHandler(adminRouter, '/outreach/approved/prepare');
  if (!prepareLayer) throw new Error('approved_outreach_prepare_handler_missing');

  const outreachReq = Object.create(req);
  outreachReq.body = { candidateIds: [candidateId] };
  let renderData = null;
  const outreachRes = {
    render(_view, data) {
      renderData = data || {};
      return this;
    }
  };

  await prepareLayer.handle(outreachReq, outreachRes, (error) => {
    if (error) throw error;
  });
  return renderData || {};
}

function installAutomaticApprovedOutreach(adminRouter, prismaClient) {
  const prepareLayer = findFinalRouteHandler(adminRouter, '/outreach/approved/prepare');
  if (!prepareLayer) return;

  for (const path of ['/candidates/:id/status', '/candidates/:id/edit']) {
    const handlerLayer = findFinalRouteHandler(adminRouter, path);
    if (!handlerLayer || handlerLayer[APPROVAL_HOOK_MARK]) continue;

    const originalHandler = handlerLayer.handle;
    Object.defineProperty(handlerLayer, APPROVAL_HOOK_MARK, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });

    handlerLayer.handle = async function handleStatusWithApprovedOutreach(req, res, next) {
      const requestedStatus = String(req.body?.status || '').trim().toUpperCase();
      if (requestedStatus !== 'APROBADO') {
        return originalHandler(req, res, next);
      }

      const candidateId = String(req.params?.id || '').trim();
      const previousStatus = await loadCandidateStatus(prismaClient, candidateId);
      if (!candidateId || previousStatus === 'APROBADO') {
        return originalHandler(req, res, next);
      }

      const originalRedirect = res.redirect.bind(res);
      let capturedRedirectArgs = null;
      res.redirect = (...args) => {
        capturedRedirectArgs = args;
        return res;
      };

      try {
        await originalHandler(req, res, next);
      } finally {
        res.redirect = originalRedirect;
      }

      if (!capturedRedirectArgs) return undefined;

      const persistedStatus = await loadCandidateStatus(prismaClient, candidateId);
      const originalTarget = redirectTargetFromArgs(capturedRedirectArgs);
      if (!shouldTriggerApprovedOutreach(previousStatus, persistedStatus)) {
        return redirectWithCapturedSignature(originalRedirect, capturedRedirectArgs, originalTarget);
      }

      let prepared = null;
      try {
        prepared = await invokeApprovedOutreachPrepare(adminRouter, req, candidateId);
      } catch (error) {
        console.error('[approved_outreach_status_hook]', {
          candidateId,
          error: error?.message || error
        });
      }

      const finalStatus = await loadCandidateStatus(prismaClient, candidateId);
      if (finalStatus === 'CONTACTADO') {
        const successTarget = withApprovalFlash(
          originalTarget,
          'success',
          'Candidato aprobado, citación aceptada por Meta y movido a Contactado.'
        );
        return redirectWithCapturedSignature(originalRedirect, capturedRedirectArgs, successTarget);
      }

      const preparedError = String(prepared?.preparedError || '').trim();
      const errorTarget = withApprovalFlash(
        originalTarget,
        'error',
        `${preparedError || 'El candidato quedó Aprobado, pero no fue posible confirmar la citación por WhatsApp.'} Revisa Aprobados antes de reintentar.`
      );
      return redirectWithCapturedSignature(originalRedirect, capturedRedirectArgs, errorTarget);
    };
  }
}

if (!express.application[PATCH_MARK]) {
  const originalUse = express.application.use;

  Object.defineProperty(express.application, PATCH_MARK, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  express.application.use = function useWithApprovedOutreachActions(...args) {
    const result = originalUse.apply(this, args);
    const [mountPath, ...handlers] = args;
    const adminRouter = mountPath === '/admin'
      ? handlers.find((handler) => isRecruitmentAdminRouter(handler))
      : null;

    if (adminRouter) {
      installAutomaticApprovedOutreach(adminRouter, prisma);
    }

    if (adminRouter && !this[APP_MOUNT_MARK]) {
      Object.defineProperty(this, APP_MOUNT_MARK, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false
      });
      originalUse.call(
        this,
        '/admin/outreach/approved',
        approvedOutreachActionsRouter(prisma)
      );
    }

    return result;
  };
}
