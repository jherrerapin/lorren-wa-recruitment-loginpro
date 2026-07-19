import express from 'express';
import { prisma } from '../lib/prisma.js';
import { dispatchAttendancePointConfigRouter } from './dispatchAttendancePointConfig.js';
import { dispatchBridgeRouter as dispatchBridgeCoreRouter } from './dispatchBridgeCore.js';
import {
  resolveAttendanceFeatureAccess,
  setRecruiterGeneralAttendanceEnabled
} from '../services/attendanceFeatureAccess.js';

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

export function filterAttendanceFeatureHtml(html, { allowed = false, isDev = false, recruiterGeneralEnabled = false } = {}) {
  if (typeof html !== 'string') return html;
  let output = html;

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

export function dispatchBridgeRouter() {
  const router = express.Router();

  router.use(loadAttendanceFeatureAccess);
  router.use(installAttendanceRenderGate);

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
    '/clientes/:clientId/operaciones/:operationId/asistencia',
    requireOps,
    requireAttendanceAccess,
    dispatchAttendancePointConfigRouter(prisma)
  );
  router.use(dispatchBridgeCoreRouter());
  return router;
}
