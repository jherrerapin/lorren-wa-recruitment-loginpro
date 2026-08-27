import express from 'express';
import { prisma } from './lib/prisma.js';
import { approvedOutreachActionsRouter } from './routes/approvedOutreachActions.js';

const PATCH_MARK = Symbol.for('lorren.approvedOutreachActionsRegistered');
const APP_MOUNT_MARK = Symbol.for('lorren.approvedOutreachActionsMounted');

function isRecruitmentAdminRouter(handler) {
  if (!handler || !Array.isArray(handler.stack)) return false;
  const routePaths = new Set(handler.stack
    .map((layer) => layer?.route?.path)
    .filter((path) => typeof path === 'string'));
  return routePaths.has('/outreach/approved')
    && routePaths.has('/outreach/approved/prepare');
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
    const isAdminMount = mountPath === '/admin'
      && handlers.some((handler) => isRecruitmentAdminRouter(handler));

    if (isAdminMount && !this[APP_MOUNT_MARK]) {
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
