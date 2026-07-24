import express from 'express';
import { prisma } from '../lib/prisma.js';
import { dispatchAttendanceAdminRouter } from './dispatchAttendanceAdmin.js';
import { dispatchAttendancePointConfigRouter } from './dispatchAttendancePointConfig.js';
import { dispatchWorkerPortalActivationAdminRouter } from './dispatchWorkerPortalActivationAdmin.js';
import { dispatchBridgeRouter as dispatchBridgeCoreRouter } from './dispatchBridgeCore.js';
import {
  resolveAttendanceFeatureAccess,
  setRecruiterGeneralAttendanceEnabled
} from '../services/attendanceFeatureAccess.js';
import { geocodeAttendanceAddress } from '../services/attendanceGeocoding.js';

export const ATTENDANCE_PORTAL_RELEASE_ID = 'attendance-portal-2026-07-23-r7';
export const WORKER_PORTAL_PUBLIC_PATH = '/operaciones/portal';

const LEAFLET_1_9_4_SCRIPT_URL = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_1_9_4_SCRIPT_INTEGRITY = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
const NOMINATIM_BROWSER_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const ATTENDANCE_GEOCODING_PATH = '/admin/operaciones/asistencia/geocodificar';

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
  if (role !== 'dev') return res.status(403).send('Acceso restringido a DEV');
  return next();
}

function requireAttendanceAccess(req, res, next) {
  if (!req.canAccessAttendanceFeature) {
    return res.status(403).send('La asistencia operativa esta habilitada temporalmente solo para DEV.');
  }
  return next();
}

function requestIpDetails(req) {
  const forwardedFor = normalizeString(req.get?.('x-forwarded-for'));
  const forwardedIp = forwardedFor
    ? forwardedFor.split(',').map((entry) => entry.trim()).find(Boolean)
    : null;
  return {
    ipAddress: forwardedIp || req.ip || req.socket?.remoteAddress || null,
    forwardedFor,
    userAgent: normalizeString(req.get?.('user-agent'))
  };
}

function requestOrigin(req) {
  const forwardedProto = normalizeString(req.get?.('x-forwarded-proto'))?.split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol || 'https';
  const host = normalizeString(req.get?.('host'));
  if (!host) return 'https://lorren.app';
  return `${protocol}://${host}`;
}

async function loadAttendanceFeatureAccess(req, res, next) {
  try {
    const access = await resolveAttendanceFeatureAccess(prisma, {
      userRole: req.session?.userRole || req.userRole,
      username: req.session?.username || req.username
    });
    req.canAccessAttendanceFeature = access.allowed;
    req.recruiterGeneralAttendanceEnabled = access.recruiterGeneralEnabled;
    res.locals.canAccessAttendanceFeature = access.allowed;
    res.locals.recruiterGeneralAttendanceEnabled = access.recruiterGeneralEnabled;
  } catch (error) {
    console.error('[ATTENDANCE_FEATURE_ACCESS_LOAD_FAILED]', error);
    req.canAccessAttendanceFeature = false;
    req.recruiterGeneralAttendanceEnabled = false;
    res.locals.canAccessAttendanceFeature = false;
    res.locals.recruiterGeneralAttendanceEnabled = false;
  }
  return next();
}

function attendanceDevControlHtml(enabled) {
  const nextEnabled = enabled ? 'false' : 'true';
  const actionLabel = enabled
    ? 'Desactivar para reclutador-general'
    : 'Activar para reclutador-general';
  const buttonClass = enabled ? 'btn' : 'btn btn-primary';
  const statusClass = enabled ? 'pill pill-green' : 'pill pill-amber';
  const statusLabel = enabled ? 'Habilitada' : 'Solo DEV';

  return `
    <section class="card" data-attendance-dev-control style="margin-bottom:18px;">
      <div class="card-head">
        <div>
          <div class="eyebrow">Control temporal DEV</div>
          <h2>Acceso a asistencia operativa</h2>
          <p>La configuracion de asistencia permanece bloqueada para todos los reclutadores. Puedes habilitarla temporalmente solo para el perfil protegido <strong>reclutador-general</strong>.</p>
        </div>
        <span class="${statusClass}">${statusLabel}</span>
      </div>
      <div class="card-body">
        <form method="post" action="/admin/operaciones/asistencia-acceso/reclutador-general">
          <input type="hidden" name="enabled" value="${nextEnabled}" />
          <button class="${buttonClass}" type="submit">${actionLabel}</button>
        </form>
      </div>
    </section>`;
}

function normalizeLeafletScriptIntegrity(html) {
  const escapedUrl = LEAFLET_1_9_4_SCRIPT_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scriptPattern = new RegExp(
    `(<script\\s+[^>]*src=["']${escapedUrl}["'][^>]*integrity=["'])[^"']*(["'][^>]*>)`,
    'i'
  );
  return html.replace(scriptPattern, `$1${LEAFLET_1_9_4_SCRIPT_INTEGRITY}$2`);
}

function normalizeAttendanceGeocodingEndpoint(html) {
  return html.split(NOMINATIM_BROWSER_SEARCH_URL).join(ATTENDANCE_GEOCODING_PATH);
}

function defaultAttendanceEnablement(html) {
  return html.replace(
    /<input\b(?=[^>]*\bname=["']attendanceEnabled["'])(?=[^>]*\bvalue=["']true["'])[^>]*>/gi,
    (tag) => {
      if (/\bchecked\b/i.test(tag)) return tag;
      return tag.replace(/\s*\/?\>$/, (ending) => ` checked${ending}`);
    }
  );
}

export function filterAttendanceFeatureHtml(html, { allowed = false, isDev = false, recruiterGeneralEnabled = false } = {}) {
  if (typeof html !== 'string') return html;
  let output = normalizeLeafletScriptIntegrity(html);
  output = normalizeAttendanceGeocodingEndpoint(output);
  output = defaultAttendanceEnablement(output);

  if (!allowed) {
    output = output.replace(
      /\s*<details\s+[^>]*class=["'][^"']*\battendance-config\b[^"']*["'][^>]*>[\s\S]*?<\/details>/gi,
      ''
    );
  }

  if (isDev && !output.includes('data-attendance-dev-control')) {
    output = output.replace(
      /(<main\s+[^>]*class=["'][^"']*\bpage\b[^"']*["'][^>]*>)/i,
      `$1${attendanceDevControlHtml(recruiterGeneralEnabled)}`
    );
  }

  return output;
}

function installAttendanceRenderGate(req, res, next) {
  const originalRender = res.render.bind(res);
  res.render = (view, locals, callback) => {
    let renderLocals = locals || {};
    let renderCallback = callback;

    if (typeof locals === 'function') {
      renderCallback = locals;
      renderLocals = {};
    }

    if (view !== 'operacionesClienteOperaciones') {
      return originalRender(view, renderLocals, renderCallback);
    }

    return originalRender(view, renderLocals, (error, html) => {
      if (error) {
        if (typeof renderCallback === 'function') return renderCallback(error);
        return next(error);
      }

      const output = filterAttendanceFeatureHtml(html, {
        allowed: Boolean(req.canAccessAttendanceFeature),
        isDev: (req.session?.userRole || req.userRole) === 'dev',
        recruiterGeneralEnabled: Boolean(req.recruiterGeneralAttendanceEnabled)
      });

      if (typeof renderCallback === 'function') return renderCallback(null, output);
      return res.send(output);
    });
  };
  return next();
}

function applyRedirectNoStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function attendanceGeocodingErrorStatus(error) {
  const code = typeof error?.message === 'string' ? error.message : '';
  if (code.endsWith('_required') || code.endsWith('_too_short') || code.endsWith('_too_long')) return 400;
  return 503;
}

export function dispatchBridgeRouter() {
  const router = express.Router();

  router.get('/portal', requireDev, (_req, res) => {
    applyRedirectNoStore(res);
    return res.redirect(302, WORKER_PORTAL_PUBLIC_PATH);
  });

  router.get('/portal/activar', requireDev, (_req, res) => {
    applyRedirectNoStore(res);
    return res.redirect(302, `${WORKER_PORTAL_PUBLIC_PATH}/activar`);
  });

  router.get('/portal-release', requireDev, (_req, res) => {
    applyRedirectNoStore(res);
    return res.status(200).json({
      service: 'lorren-attendance-portal',
      release: ATTENDANCE_PORTAL_RELEASE_ID,
      legacyAdminRedirect: true,
      publicPortalPath: WORKER_PORTAL_PUBLIC_PATH
    });
  });

  router.use(loadAttendanceFeatureAccess);
  router.use(installAttendanceRenderGate);

  router.get(
    '/asistencia/geocodificar',
    requireOps,
    requireAttendanceAccess,
    async (req, res) => {
      applyRedirectNoStore(res);
      try {
        const results = await geocodeAttendanceAddress(req.query?.q, {
          origin: requestOrigin(req)
        });
        return res.status(200).json(results);
      } catch (error) {
        const code = typeof error?.message === 'string' ? error.message : 'attendance_geocoding_failed';
        console.warn('[ATTENDANCE_GEOCODING_FAILED]', { code });
        return res.status(attendanceGeocodingErrorStatus(error)).json({
          ok: false,
          error: attendanceGeocodingErrorStatus(error) === 400
            ? 'attendance_geocoding_query_invalid'
            : 'attendance_geocoding_unavailable'
        });
      }
    }
  );

  router.use(
    '/asistencia',
    requireOps,
    requireAttendanceAccess,
    dispatchAttendanceAdminRouter(prisma)
  );

  router.post(
    '/asistencia-acceso/reclutador-general',
    requireDev,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      const enabled = normalizeString(req.body.enabled);
      if (!['true', 'false'].includes(enabled)) {
        return res.redirect('/admin/users?error=' + encodeURIComponent('Selecciona un estado valido para la asistencia.'));
      }

      try {
        const ipDetails = requestIpDetails(req);
        const result = await setRecruiterGeneralAttendanceEnabled(prisma, {
          enabled: enabled === 'true',
          actorUsername: req.session?.username || req.username || 'dev',
          actorRole: req.session?.userRole || req.userRole,
          actorSource: req.session?.userSource || req.userSource,
          ipAddress: ipDetails.ipAddress,
          forwardedFor: ipDetails.forwardedFor,
          userAgent: ipDetails.userAgent,
          method: req.method,
          path: req.originalUrl || req.url
        });
        const message = result.enabled
          ? 'Asistencia habilitada para reclutador-general.'
          : 'Asistencia deshabilitada para reclutador-general. Solo DEV conserva acceso.';
        return res.redirect('/admin/users?success=' + encodeURIComponent(message) + '&username=reclutador-general');
      } catch (error) {
        console.error('[ATTENDANCE_FEATURE_ACCESS_UPDATE_FAILED]', error);
        const message = error?.message === 'attendance_access_recruiter_general_not_found'
          ? 'No existe el perfil reclutador-general en la base de datos.'
          : 'No fue posible actualizar el acceso temporal de asistencia.';
        return res.redirect('/admin/users?error=' + encodeURIComponent(message));
      }
    }
  );

  router.use(
    '/portal-activaciones',
    requireDev,
    dispatchWorkerPortalActivationAdminRouter(prisma)
  );

  router.use(
    '/clientes/:clientId/operaciones/:operationId/asistencia',
    requireOps,
    requireAttendanceAccess,
    dispatchAttendancePointConfigRouter(prisma)
  );
  router.use(dispatchBridgeCoreRouter());
  return router;
}
