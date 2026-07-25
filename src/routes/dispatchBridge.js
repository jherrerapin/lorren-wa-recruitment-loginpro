import express from 'express';
import { prisma } from '../lib/prisma.js';
import { dispatchAttendanceAdminRouter } from './dispatchAttendanceAdmin.js';
import { dispatchAttendancePointConfigRouter } from './dispatchAttendancePointConfig.js';
import { dispatchWorkerPortalActivationAdminRouter } from './dispatchWorkerPortalActivationAdmin.js';
import { dispatchBridgeRouter as dispatchBridgeCoreRouter } from './dispatchBridgeCore.js';
import { resolveAttendanceFeatureAccess } from '../services/attendanceFeatureAccess.js';
import { geocodeAttendanceAddress } from '../services/attendanceGeocoding.js';

export const ATTENDANCE_PORTAL_RELEASE_ID = 'attendance-portal-2026-07-23-r7';
export const WORKER_PORTAL_PUBLIC_PATH = '/operaciones/portal';

const LEAFLET_1_9_4_SCRIPT_URL = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_1_9_4_SCRIPT_INTEGRITY = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
const ATTENDANCE_MAP_RELIABILITY_SCRIPT = '/public/attendance-map-reliability.js';
const ATTENDANCE_ADMIN_RUNTIME_SCRIPT = '/public/attendance-admin-runtime.js';
const NOMINATIM_BROWSER_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const ATTENDANCE_GEOCODING_PATH = '/admin/operaciones/asistencia/geocodificar';
const WORKER_PORTAL_ACTIVATION_ADMIN_PATH = '/admin/operaciones/portal-activaciones';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function comparableLocation(value) {
  return (normalizeString(value) || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('es-CO');
}

function operationLocationChanged(operation, nextLocation) {
  return comparableLocation(operation?.cityName) !== comparableLocation(nextLocation?.cityName)
    || comparableLocation(operation?.address) !== comparableLocation(nextLocation?.address);
}

function operationListRedirect(clientId, message) {
  const suffix = message ? `?message=${encodeURIComponent(message)}` : '';
  return `/admin/operaciones/clientes/${encodeURIComponent(clientId)}/operaciones${suffix}`;
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
    return res.status(403).send('No tienes permiso para acceder a Asistencia operativa.');
  }
  return next();
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
    res.locals.canAccessAttendanceFeature = access.allowed;
  } catch (error) {
    console.error('[ATTENDANCE_FEATURE_ACCESS_LOAD_FAILED]', error);
    req.canAccessAttendanceFeature = false;
    res.locals.canAccessAttendanceFeature = false;
  }
  return next();
}

function normalizeLeafletScriptIntegrity(html) {
  const escapedUrl = LEAFLET_1_9_4_SCRIPT_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scriptPattern = new RegExp(
    `(<script\\s+[^>]*src=["']${escapedUrl}["'][^>]*integrity=["'])[^"']*(["'][^>]*>)`,
    'i'
  );
  return html.replace(scriptPattern, `$1${LEAFLET_1_9_4_SCRIPT_INTEGRITY}$2`);
}

function injectAttendanceMapReliability(html) {
  let output = html;
  if (!/<meta\s+name=["']referrer["']/i.test(output)) {
    output = output.replace(
      /(<meta\s+name=["']viewport["'][^>]*>)/i,
      '$1\n  <meta name="referrer" content="strict-origin-when-cross-origin" />'
    );
  }
  if (output.includes(ATTENDANCE_MAP_RELIABILITY_SCRIPT)) return output;

  const escapedUrl = LEAFLET_1_9_4_SCRIPT_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leafletScriptPattern = new RegExp(
    `(<script\\s+[^>]*src=["']${escapedUrl}["'][^>]*>\\s*<\\/script>)`,
    'i'
  );
  return output.replace(
    leafletScriptPattern,
    `$1\n  <script src="${ATTENDANCE_MAP_RELIABILITY_SCRIPT}"></script>`
  );
}

function injectAttendanceAdminRuntime(html) {
  if (html.includes(ATTENDANCE_ADMIN_RUNTIME_SCRIPT)) return html;
  return html.replace(
    /<\/body>/i,
    `  <script src="${ATTENDANCE_ADMIN_RUNTIME_SCRIPT}"></script>\n</body>`
  );
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

export function filterAttendanceFeatureHtml(html, { allowed = false } = {}) {
  if (typeof html !== 'string') return html;
  let output = normalizeLeafletScriptIntegrity(html);
  output = injectAttendanceMapReliability(output);
  output = normalizeAttendanceGeocodingEndpoint(output);
  output = defaultAttendanceEnablement(output);

  if (!allowed) {
    output = output.replace(
      /\s*<details\s+[^>]*class=["'][^"']*\battendance-config\b[^"']*["'][^>]*>[\s\S]*?<\/details>/gi,
      ''
    );
  }

  return output;
}

export function filterAttendanceAdminHtml(html) {
  if (typeof html !== 'string') return html;
  const reliableHtml = injectAttendanceMapReliability(normalizeLeafletScriptIntegrity(html));
  return injectAttendanceAdminRuntime(reliableHtml);
}

export function filterOperationsPersonalAttendanceHtml(html, { allowed = false } = {}) {
  if (typeof html !== 'string' || !allowed || html.includes(`href="${WORKER_PORTAL_ACTIVATION_ADMIN_PATH}"`)) {
    return html;
  }

  const returnAction = '<a class="btn btn-secondary" href="/admin/operaciones">Volver a Operaciones</a>';
  if (!html.includes(returnAction)) return html;

  const activationAction = `<a class="btn btn-success" href="${WORKER_PORTAL_ACTIVATION_ADMIN_PATH}">Activar Portal del Auxiliar</a>`;
  return html.replace(returnAction, `${activationAction}\n        ${returnAction}`);
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

    const isPointConfigView = view === 'operacionesClienteOperaciones';
    const isAttendanceAdminView = view === 'operacionesAsistencia';
    const isOperationsPersonalView = view === 'operacionesPersonal';
    if (!isPointConfigView && !isAttendanceAdminView && !isOperationsPersonalView) {
      return originalRender(view, renderLocals, renderCallback);
    }

    return originalRender(view, renderLocals, (error, html) => {
      if (error) {
        if (typeof renderCallback === 'function') return renderCallback(error);
        return next(error);
      }

      let output;
      if (isPointConfigView) {
        output = filterAttendanceFeatureHtml(html, {
          allowed: Boolean(req.canAccessAttendanceFeature)
        });
      } else if (isAttendanceAdminView) {
        output = filterAttendanceAdminHtml(html);
      } else {
        output = filterOperationsPersonalAttendanceHtml(html, {
          allowed: Boolean(req.canAccessAttendanceFeature)
        });
      }

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

  router.use(
    '/portal-activaciones',
    requireOps,
    requireAttendanceAccess,
    dispatchWorkerPortalActivationAdminRouter(prisma)
  );

  router.use(
    '/clientes/:clientId/operaciones/:operationId/asistencia',
    requireOps,
    requireAttendanceAccess,
    dispatchAttendancePointConfigRouter(prisma)
  );

  router.post(
    '/clientes/:clientId/operaciones/:operationId/editar',
    requireOps,
    express.urlencoded({ extended: true }),
    async (req, res, next) => {
      try {
        const name = normalizeString(req.body.name);
        if (!name) return res.status(400).send('Nombre requerido');

        const operation = await prisma.dispatchOperationPoint.findFirst({
          where: {
            id: req.params.operationId,
            clientId: req.params.clientId
          },
          select: {
            id: true,
            cityName: true,
            address: true,
            attendanceEnabled: true,
            attendanceLatitude: true,
            attendanceLongitude: true
          }
        });
        if (!operation) return res.status(404).send('Operación no encontrada');

        const cityName = normalizeString(req.body.cityName);
        const address = normalizeString(req.body.address);
        const locationChanged = operationLocationChanged(operation, { cityName, address });
        const hadAttendanceLocation = operation.attendanceEnabled === true
          || operation.attendanceLatitude !== null
          || operation.attendanceLongitude !== null;

        if (locationChanged && hadAttendanceLocation && !req.canAccessAttendanceFeature) {
          return res.status(403).send(
            'Cambiar la ciudad o dirección de un punto con asistencia requiere acceso autorizado a Asistencia.'
          );
        }

        const data = {
          name,
          cityName,
          address,
          contactName: normalizeString(req.body.contactName),
          contactPhone: normalizeString(req.body.contactPhone),
          notes: normalizeString(req.body.notes),
          isActive: normalizeString(req.body.isActive) !== 'false'
        };

        if (locationChanged && hadAttendanceLocation) {
          data.attendanceEnabled = false;
          data.attendanceLatitude = null;
          data.attendanceLongitude = null;
        }

        await prisma.dispatchOperationPoint.update({
          where: { id: operation.id },
          data
        });

        const message = locationChanged && hadAttendanceLocation
          ? 'Operación actualizada. La dirección cambió: vuelve a confirmar el punto exacto antes de habilitar asistencia.'
          : 'Operación actualizada.';
        return res.redirect(operationListRedirect(req.params.clientId, message));
      } catch (error) {
        return next(error);
      }
    }
  );

  router.use(dispatchBridgeCoreRouter());
  return router;
}
