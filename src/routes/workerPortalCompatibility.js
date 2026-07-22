import express from 'express';

export const ATTENDANCE_PORTAL_RELEASE_ID = 'attendance-portal-2026-07-22-r1';
export const ATTENDANCE_PORTAL_RELEASE_PATH = '/public/attendance-portal-release.json';
export const WORKER_PORTAL_LEGACY_ADMIN_PATH = '/admin/operaciones/portal';
export const WORKER_PORTAL_PUBLIC_PATH = '/operaciones/portal';

function applyNoStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

export function workerPortalCompatibilityRouter() {
  const router = express.Router();

  router.get(WORKER_PORTAL_LEGACY_ADMIN_PATH, (_req, res) => {
    applyNoStore(res);
    return res.redirect(302, WORKER_PORTAL_PUBLIC_PATH);
  });

  router.get(`${WORKER_PORTAL_LEGACY_ADMIN_PATH}/activar`, (_req, res) => {
    applyNoStore(res);
    return res.redirect(302, `${WORKER_PORTAL_PUBLIC_PATH}/activar`);
  });

  router.get(ATTENDANCE_PORTAL_RELEASE_PATH, (_req, res) => {
    applyNoStore(res);
    return res.status(200).json({
      service: 'lorren-attendance-portal',
      release: ATTENDANCE_PORTAL_RELEASE_ID,
      legacyAdminRedirect: true,
      publicPortalPath: WORKER_PORTAL_PUBLIC_PATH
    });
  });

  return router;
}
