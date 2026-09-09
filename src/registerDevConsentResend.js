import express from 'express';
import { prisma } from './lib/prisma.js';
import {
  devConsentResendRouter,
  devConsentResendUiMiddleware
} from './routes/devConsentResend.js';

const PATCH_MARK = Symbol.for('lorren.devConsentResendRegistered');
const APP_MOUNT_MARK = Symbol.for('lorren.devConsentResendMounted');

function isRecruitmentAdminRouter(handler) {
  if (!handler || !Array.isArray(handler.stack)) return false;
  const routePaths = new Set(handler.stack
    .map((layer) => layer?.route?.path)
    .filter((path) => typeof path === 'string'));
  return routePaths.has('/outreach/approved')
    && routePaths.has('/candidates/:id');
}

if (!express.application[PATCH_MARK]) {
  const originalUse = express.application.use;

  Object.defineProperty(express.application, PATCH_MARK, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  express.application.use = function useWithDevConsentResend(...args) {
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
      originalUse.call(this, '/admin', devConsentResendUiMiddleware());
      originalUse.call(this, '/admin', devConsentResendRouter(prisma));
    }

    return originalUse.apply(this, args);
  };
}
