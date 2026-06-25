import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { webhookRouter } from './routes/webhook.js';
import { adminRouter } from './routes/admin.js';
import { botKnowledgeCrudRouter } from './routes/botKnowledgeCrud.js';
import { locationsRouter } from './routes/locations.js';
import { dispatchDashboardMetricsRouter } from './routes/dispatchDashboardMetrics.js';
import { dispatchClientStatsRouter } from './routes/dispatchClientStats.js';
import { dispatchOpsExtrasRouter } from './routes/dispatchOpsExtras.js';
import { dispatchWorkerStatsRouter } from './routes/dispatchWorkerStats.js';
import { dispatchBridgeRouter } from './routes/dispatchBridge.js';
import { dispatchWhatsappNotificationsRouter } from './routes/dispatchWhatsappNotifications.js';
import { dispatchProgrammingNotificationsRouter } from './routes/dispatchProgrammingNotifications.js';
import { publicDispatchClientRouter } from './routes/publicDispatchClient.js';
import { dispatchMultiShiftRequestsRouter } from './routes/dispatchMultiShiftRequests.js';
import { lorenV2Router } from './routes/lorenV2.js';
import { lorenV2DailySummaryRouter } from './routes/lorenV2DailySummary.js';
import { lorenV2ReportsRouter } from './routes/lorenV2Reports.js';
import { lorenV2DataConsentsRouter } from './routes/lorenV2DataConsents.js';
import { lorenV2CvAnalysisRouter } from './routes/lorenV2CvAnalysis.js';
import { dispatchAuditMiddleware } from './services/dispatchAuditMiddleware.js';
import { campaignAttributionMiddleware } from './services/campaignAttribution.js';
import { referralAttributionMiddleware } from './services/referralAttribution.js';
import { canSeeLorenV2 } from './services/lorenV2Gate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const prisma = new PrismaClient();
const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const sessionCookieName = process.env.SESSION_COOKIE_NAME || 'loginpro.sid';
const sessionSecret = process.env.SESSION_SECRET || 'dev-session-secret-change-me';
const LOREN_STATS_UI_LABEL = 'Estadísticas';
const LOREN_STATS_BASE_PATH = '/admin/estadisticas';
const LOREN_STATS_LEGACY_BASE_PATH = '/admin/v2';

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET no esta configurada. Usa un valor robusto en produccion.');
}

if (isProduction) {
  app.set('trust proxy', 1);
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isOperationsOnlyUsername(username) {
  return Boolean(normalizeString(username)?.startsWith('operaciones-despacho'));
}

function buildLoginViewModel(overrides = {}) {
  return {
    error: null,
    username: '',
    success: null,
    ...overrides
  };
}

function wrapAsyncRouter(router) {
  for (const layer of router.stack || []) {
    if (layer.route?.stack) {
      for (const routeLayer of layer.route.stack) {
        const handler = routeLayer.handle;
        if (typeof handler !== 'function' || handler.length >= 4 || handler.__asyncWrapped) continue;
        routeLayer.handle = function asyncRouteHandler(req, res, next) {
          try {
            const result = handler(req, res, next);
            if (result && typeof result.catch === 'function') result.catch(next);
            return result;
          } catch (error) {
            return next(error);
          }
        };
        routeLayer.handle.__asyncWrapped = true;
      }
    } else if (layer.handle?.stack) {
      wrapAsyncRouter(layer.handle);
    }
  }
  return router;
}

function appendMessageToPath(pathValue, message) {
  const [pathname, query = ''] = String(pathValue || '').split('?');
  const params = new URLSearchParams(query);
  params.set('message', message);
  return `${pathname || '/admin/operaciones'}?${params.toString()}`;
}

function safeDispatchRefererPath(req, fallbackPath = '/admin/operaciones') {
  const referer = req.get('referer');
  if (!referer) return fallbackPath;

  try {
    const parsed = new URL(referer);
    const currentOrigin = `${req.protocol}://${req.get('host')}`;
    const isSameOrigin = parsed.origin === currentOrigin;
    const isDispatchPath = parsed.pathname.startsWith('/admin/operaciones') || parsed.pathname.startsWith('/operaciones/admin-');
    if (isSameOrigin && isDispatchPath) return `${parsed.pathname}${parsed.search}`;
  } catch (error) {
    console.warn('No fue posible interpretar el referer de operaciones.', error);
  }

  return fallbackPath;
}

function dispatchErrorHandler(fallbackPath = '/admin/operaciones') {
  return (err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    if (req.accepts('html')) {
      const safePath = safeDispatchRefererPath(req, fallbackPath);
      return res.redirect(appendMessageToPath(safePath, 'No fue posible completar la accion de despacho. Revisa los datos e intenta nuevamente.'));
    }
    return res.status(500).json({ error: 'dispatch_operation_failed' });
  };
}

function replaceLorenV2UiLabel(html) {
  if (typeof html !== 'string') return html;
  return html.replace(/Loren V2/g, LOREN_STATS_UI_LABEL);
}

function shouldReplaceLorenV2UiLabel(body, res) {
  if (typeof body !== 'string') return false;
  const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
  return contentType.includes('text/html') || body.trimStart().startsWith('<!doctype html') || body.trimStart().startsWith('<html');
}

function injectLorenV2NavbarLink(html, req) {
  if (typeof html !== 'string') return html;
  if (!canSeeLorenV2(req)) return html;
  if (html.includes(`href="${LOREN_STATS_BASE_PATH}"`)) return html;
  if (!html.includes('<span class="spacer"></span>')) return html;

  return html.replace(
    '<span class="spacer"></span>',
    `  <a href="${LOREN_STATS_BASE_PATH}">${LOREN_STATS_UI_LABEL}</a>\n  <span class="spacer"></span>`
  );
}

function mapDbRoleToSessionRole(role) {
  return role === 'DEV' ? 'dev' : 'admin';
}

function buildUserSessionPayload(user) {
  return {
    userId: user.id,
    userRole: mapDbRoleToSessionRole(user.role),
    username: user.username,
    userAccessScope: user.accessScope || 'ALL',
    userAccessCity: user.scopeCity || null,
    userAccessVacancyId: user.scopeVacancyId || null,
    userSource: 'db',
    canAccessDispatch: Boolean(user.canAccessDispatch)
  };
}

function applySessionPayload(req, payload) {
  req.session.userId = payload.userId || null;
  req.session.userRole = payload.userRole;
  req.session.username = payload.username;
  req.session.userAccessScope = payload.userAccessScope || 'ALL';
  req.session.userAccessCity = payload.userAccessCity || null;
  req.session.userAccessVacancyId = payload.userAccessVacancyId || null;
  req.session.userSource = payload.userSource || 'env';
  req.session.canAccessDispatch = Boolean(payload.canAccessDispatch);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  const originalSend = res.send.bind(res);
  res.send = (body) => originalSend(shouldReplaceLorenV2UiLabel(body, res) ? replaceLorenV2UiLabel(body) : body);
  next();
});
app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = (view, locals = {}, callback) => {
    originalRender(view, locals, (error, html) => {
      if (error) {
        if (typeof callback === 'function') return callback(error);
        return next(error);
      }
      const shouldInjectDispatchScripts = view === 'operacionesAsignacionesConfirmacion' && typeof html === 'string';
      const htmlWithDispatchScripts = shouldInjectDispatchScripts
        ? html.replace('</body>', '<script src="/public/assignment-confirm-dialog.js"></script><script src="/public/assignment-template-sync.js"></script></body>')
        : html;
      const output = injectLorenV2NavbarLink(htmlWithDispatchScripts, req);
      if (typeof callback === 'function') return callback(null, output);
      return res.send(output);
    });
  };
  next();
});
app.use(morgan('combined'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const PgStore = connectPgSimple(session);
const sessionStore = new PgStore({
  conString: process.env.DATABASE_URL,
  tableName: 'session',
  createTableIfMissing: true,
  pruneSessionInterval: 60 * 60
});

sessionStore.on('error', (err) => {
  console.error('[SESSION_STORE_ERROR]', err);
});

app.use(session({
  name: sessionCookieName,
  secret: sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use((req, res, next) => {
  req.userRole = req.session?.userRole || null;
  req.userId = req.session?.userId || null;
  req.username = req.session?.username || null;
  req.userAccessScope = req.session?.userAccessScope || 'ALL';
  req.userAccessCity = req.session?.userAccessCity || null;
  req.userAccessVacancyId = req.session?.userAccessVacancyId || null;
  req.userSource = req.session?.userSource || null;
  req.canAccessDispatch = Boolean(req.session?.canAccessDispatch);
  res.locals.role = req.userRole;
  res.locals.canAccessDispatch = req.userRole === 'dev' || req.canAccessDispatch;
  res.locals.canSeeLorenV2 = canSeeLorenV2(req);
  next();
});

app.use(dispatchAuditMiddleware(prisma));

app.get('/health', async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.status(200).json({ ok: true });
});

app.get('/login', (req, res) => {
  if (req.session?.userRole) return res.redirect('/admin');
  res.render('login', buildLoginViewModel({
    success: normalizeString(req.query.success),
    username: normalizeString(req.query.username) || ''
  }));
});

async function verifyCredential(plain, envValue) {
  if (!envValue) return false;
  if (envValue.startsWith('$2b$') || envValue.startsWith('$2a$')) {
    return bcrypt.compare(plain, envValue);
  }
  return plain === envValue;
}

async function authenticateDatabaseUser(username, password) {
  if (!normalizeString(username) || !password) return null;
  const user = await prisma.appUser.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      passwordHash: true,
      role: true,
      accessScope: true,
      scopeCity: true,
      scopeVacancyId: true,
      canAccessDispatch: true,
      isActive: true
    }
  });
  if (!user || !user.isActive) return null;
  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) return null;
  return buildUserSessionPayload(user);
}

app.post('/login', async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  let sessionPayload = await authenticateDatabaseUser(username, password);

  if (!sessionPayload) {
    let role = null;
    if (username === process.env.DEV_USER && await verifyCredential(password, process.env.DEV_PASS)) role = 'dev';
    else if (username === process.env.ADMIN_USER && await verifyCredential(password, process.env.ADMIN_PASS)) role = 'admin';

    if (role) {
      sessionPayload = {
        userId: null,
        userRole: role,
        username,
        userAccessScope: 'ALL',
        userAccessCity: null,
        userAccessVacancyId: null,
        userSource: 'env',
        canAccessDispatch: role === 'dev'
      };
    }
  }

  if (!sessionPayload) {
    return res.status(401).render('login', buildLoginViewModel({
      error: 'Usuario o contrasena invalidos.',
      username
    }));
  }

  req.session.regenerate((regenError) => {
    if (regenError) {
      console.error('[LOGIN_REGEN_ERROR]', regenError);
      return res.status(500).render('login', buildLoginViewModel({
        error: 'No fue posible iniciar sesion. Intenta nuevamente.',
        username
      }));
    }
    applySessionPayload(req, sessionPayload);
    req.session.save((saveError) => {
      if (saveError) {
        console.error('[LOGIN_SAVE_ERROR]', saveError);
        return res.status(500).render('login', buildLoginViewModel({
          error: 'No fue posible iniciar sesion. Intenta nuevamente.',
          username
        }));
      }
      return res.redirect(isOperationsOnlyUsername(sessionPayload.username) ? '/admin/operaciones' : '/admin');
    });
  });
});

app.get('/recover', (req, res) => {
  if (req.session?.userRole) return res.redirect('/admin');
  res.render('recover', {
    error: null,
    username: normalizeString(req.query.username) || '',
    success: normalizeString(req.query.success)
  });
});

app.post('/recover', async (req, res) => {
  const username = normalizeString(req.body.username) || '';
  const recoveryCode = normalizeString(req.body.recoveryCode) || '';
  const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';

  if (!username || !recoveryCode || newPassword.length < 6) {
    return res.status(400).render('recover', {
      error: 'Debes ingresar usuario, codigo de recuperacion y una contrasena de al menos 6 caracteres.',
      username,
      success: null
    });
  }

  const user = await prisma.appUser.findUnique({
    where: { username },
    select: { id: true, isActive: true, recoveryCodeHash: true }
  });

  if (!user || !user.isActive || !user.recoveryCodeHash) {
    return res.status(400).render('recover', {
      error: 'No fue posible validar ese usuario para recuperacion. Si es un usuario antiguo por variables de entorno, recupera el acceso desde dev.',
      username,
      success: null
    });
  }

  const matchesRecoveryCode = await bcrypt.compare(recoveryCode, user.recoveryCodeHash);
  if (!matchesRecoveryCode) {
    return res.status(401).render('recover', {
      error: 'El codigo de recuperacion no es valido.',
      username,
      success: null
    });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.appUser.update({
    where: { id: user.id },
    data: {
      passwordHash,
      lastPasswordResetAt: new Date()
    }
  });

  const params = new URLSearchParams();
  params.set('success', 'Contrasena actualizada. Ya puedes iniciar sesion.');
  params.set('username', username);
  return res.redirect(`/login?${params.toString()}`);
});

const destroySession = (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(sessionCookieName);
    res.redirect('/login');
  });
};

app.post('/logout', destroySession);
app.get('/logout', destroySession);

app.use(wrapAsyncRouter(dispatchMultiShiftRequestsRouter()));
app.use('/webhook', campaignAttributionMiddleware(prisma));
app.use('/webhook', referralAttributionMiddleware(prisma));
app.use('/webhook', webhookRouter(prisma));
app.use('/admin/bot-knowledge', botKnowledgeCrudRouter(prisma));
app.use('/operaciones', wrapAsyncRouter(publicDispatchClientRouter()));
app.use('/operaciones', dispatchErrorHandler('/admin/operaciones'));
app.use('/admin/operaciones', wrapAsyncRouter(dispatchDashboardMetricsRouter(prisma)));
app.use('/admin/operaciones', wrapAsyncRouter(dispatchClientStatsRouter(prisma)));
app.use('/admin/operaciones', wrapAsyncRouter(dispatchWorkerStatsRouter(prisma)));
app.use('/admin/operaciones', wrapAsyncRouter(dispatchOpsExtrasRouter(prisma)));
app.use('/admin/operaciones', wrapAsyncRouter(dispatchProgrammingNotificationsRouter(prisma)));
app.use('/admin/operaciones', wrapAsyncRouter(dispatchBridgeRouter()));
app.use('/admin/operaciones/whatsapp', wrapAsyncRouter(dispatchWhatsappNotificationsRouter(prisma)));
app.use('/admin/operaciones', dispatchErrorHandler('/admin/operaciones'));
app.get(LOREN_STATS_LEGACY_BASE_PATH, (_req, res) => res.redirect(301, LOREN_STATS_BASE_PATH));
app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/campaigns`, (_req, res) => res.redirect(301, `${LOREN_STATS_BASE_PATH}/campaigns`));
app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/campaigns/:id`, (req, res) => res.redirect(301, `${LOREN_STATS_BASE_PATH}/campaigns/${encodeURIComponent(req.params.id)}`));
app.post(`${LOREN_STATS_LEGACY_BASE_PATH}/campaigns`, (req, res) => res.redirect(308, `${LOREN_STATS_BASE_PATH}/campaigns`));
app.post(`${LOREN_STATS_LEGACY_BASE_PATH}/campaigns/associate`, (req, res) => res.redirect(308, `${LOREN_STATS_BASE_PATH}/campaigns/associate`));
app.post(`${LOREN_STATS_LEGACY_BASE_PATH}/campaigns/:id/edit`, (req, res) => res.redirect(308, `${LOREN_STATS_BASE_PATH}/campaigns/${encodeURIComponent(req.params.id)}/edit`));
app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/reports`, (_req, res) => res.redirect(301, `${LOREN_STATS_BASE_PATH}/reports`));
app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/daily-summary`, (_req, res) => res.redirect(301, `${LOREN_STATS_BASE_PATH}/daily-summary`));
app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/data-consents`, (_req, res) => res.redirect(301, `${LOREN_STATS_BASE_PATH}/data-consents`));
app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/cv-analysis`, (_req, res) => res.redirect(301, `${LOREN_STATS_BASE_PATH}/cv-analysis`));

app.use(`${LOREN_STATS_BASE_PATH}/daily-summary`, wrapAsyncRouter(lorenV2DailySummaryRouter(prisma)));
app.use(`${LOREN_STATS_BASE_PATH}/reports`, wrapAsyncRouter(lorenV2ReportsRouter(prisma)));
app.use(`${LOREN_STATS_BASE_PATH}/data-consents`, wrapAsyncRouter(lorenV2DataConsentsRouter(prisma)));
app.use(`${LOREN_STATS_BASE_PATH}/cv-analysis`, wrapAsyncRouter(lorenV2CvAnalysisRouter(prisma)));
app.use(LOREN_STATS_BASE_PATH, wrapAsyncRouter(lorenV2Router(prisma)));
app.use('/admin', (req, res, next) => {
  if (isOperationsOnlyUsername(req.session?.username || req.username)) {
    if (req.method === 'GET' && (req.path === '/' || req.path === '')) return res.redirect('/admin/operaciones');
    return res.status(403).send('Usuario limitado a Operaciones / Despacho');
  }
  return next();
});
app.use('/admin', adminRouter(prisma));
app.use('/admin/locations', locationsRouter(prisma));

app.use((err, _req, res, next) => {
  console.error(err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'internal_server_error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));