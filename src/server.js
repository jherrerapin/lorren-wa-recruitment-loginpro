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
import { lorenV2CvAnalysisRouter } from './routes/lorenV2CvAnalysis.js';
import { dispatchAuditMiddleware } from './services/dispatchAuditMiddleware.js';
import { campaignAttributionMiddleware } from './services/campaignAttribution.js';
import { referralAttributionMiddleware } from './services/referralAttribution.js';
import { canManageLorenV2, canSeeLorenV2 } from './services/lorenV2Gate.js';
import { getMetaAdsConfig } from './services/metaAdsClient.js';
import { syncMetaAdsInsights } from './services/metaAdsInsightsSync.js';
import { getOpenAiModelConfig } from './services/openAiModelConfig.js';

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
const META_ADS_AUTO_SYNC_INTERVAL_MS = Number(process.env.META_ADS_AUTO_SYNC_INTERVAL_MS || 15 * 60 * 1000);
const META_ADS_DEFAULT_LOOKBACK_DAYS = Number(process.env.META_ADS_DEFAULT_LOOKBACK_DAYS || 90);

let metaAdsLastAutoSyncAt = 0;
let metaAdsAutoSyncInFlight = null;

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

function normalizeDateInput(value) {
  const text = normalizeString(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
}

function dateOnlyFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function metaDefaultDateRange() {
  const until = new Date();
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - META_ADS_DEFAULT_LOOKBACK_DAYS);
  return { since: dateOnlyFromDate(since), until: dateOnlyFromDate(until) };
}

function metaDateRangeFromQuery(query = {}) {
  const fallback = metaDefaultDateRange();
  return {
    since: normalizeDateInput(query.from || query.since) || fallback.since,
    until: normalizeDateInput(query.to || query.until) || fallback.until
  };
}

function metaDateBounds(range = {}) {
  return {
    gte: new Date(`${range.since}T00:00:00.000Z`),
    lte: new Date(`${range.until}T23:59:59.999Z`)
  };
}

function currentRequestPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function canManageStats(req = {}) {
  return canManageLorenV2(req);
}

function isStatsCampaignsPage(req = {}) {
  return req.method === 'GET' && currentRequestPath(req) === `${LOREN_STATS_BASE_PATH}/campaigns`;
}

function asNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asInt(value) {
  return Math.round(asNumber(value));
}

function metricCost(totalSpend, count) {
  if (!totalSpend || !count) return null;
  return Math.round(totalSpend / count);
}

function hasCompleteCoreDataForMeta(candidate = {}) {
  return Boolean(candidate.fullName && candidate.documentNumber && candidate.phone);
}

function hasCvForMeta(candidate = {}) {
  return Boolean(candidate.cvStorageKey || candidate.cvData || candidate.cvOriginalName);
}

function isAptForMeta(candidate = {}) {
  return ['APROBADO', 'CONTRATADO'].includes(candidate.status);
}

async function maybeAutoSyncMetaAds(req = {}) {
  if (!canManageStats(req) || !isStatsCampaignsPage(req)) return;
  const config = getMetaAdsConfig();
  if (!config.enabled) return;
  const now = Date.now();
  if (metaAdsAutoSyncInFlight) return metaAdsAutoSyncInFlight;
  if (metaAdsLastAutoSyncAt && now - metaAdsLastAutoSyncAt < META_ADS_AUTO_SYNC_INTERVAL_MS) return;

  const range = metaDateRangeFromQuery(req.query || {});
  metaAdsAutoSyncInFlight = syncMetaAdsInsights(prisma, range)
    .catch((error) => {
      console.warn('[metaAdsAutoSync] error', error?.message || error);
      return null;
    })
    .finally(() => {
      metaAdsLastAutoSyncAt = Date.now();
      metaAdsAutoSyncInFlight = null;
    });

  return metaAdsAutoSyncInFlight;
}

async function loadMetaAdsSummary(query = {}) {
  const range = metaDateRangeFromQuery(query);
  const bounds = metaDateBounds(range);
  const [adSnapshots, candidates] = await Promise.all([
    prisma.metaAdSnapshot.findMany({
      where: { date: bounds },
      select: {
        metaCampaignId: true,
        metaCampaignName: true,
        metaAdId: true,
        metaAdName: true,
        spend: true,
        impressions: true,
        reach: true,
        clicks: true,
        inlineLinkClicks: true
      },
      orderBy: [{ date: 'desc' }, { metaAdName: 'asc' }]
    }),
    prisma.candidate.findMany({
      where: { sourceType: 'META_ADS', createdAt: bounds },
      select: {
        metaAdId: true,
        fullName: true,
        documentNumber: true,
        phone: true,
        cvStorageKey: true,
        cvData: true,
        cvOriginalName: true,
        status: true
      }
    })
  ]);

  const totals = { spend: 0, impressions: 0, reach: 0, clicks: 0, inlineLinkClicks: 0, completedRegistrations: 0, cvReceived: 0, apt: 0, hired: 0 };
  const ads = new Map();

  for (const row of adSnapshots) {
    const adId = String(row.metaAdId || '').trim();
    if (!adId) continue;
    if (!ads.has(adId)) {
      ads.set(adId, { metaAdId: adId, metaAdName: row.metaAdName || `Anuncio ${adId}`, metaCampaignId: row.metaCampaignId || null, metaCampaignName: row.metaCampaignName || null, spend: 0, impressions: 0, reach: 0, clicks: 0, inlineLinkClicks: 0, completedRegistrations: 0, cvReceived: 0, apt: 0, hired: 0 });
    }
    const item = ads.get(adId);
    item.metaAdName = row.metaAdName || item.metaAdName;
    item.metaCampaignName = row.metaCampaignName || item.metaCampaignName;
    item.spend += asNumber(row.spend);
    item.impressions += asInt(row.impressions);
    item.reach += asInt(row.reach);
    item.clicks += asInt(row.clicks);
    item.inlineLinkClicks += asInt(row.inlineLinkClicks);
    totals.spend += asNumber(row.spend);
    totals.impressions += asInt(row.impressions);
    totals.reach += asInt(row.reach);
    totals.clicks += asInt(row.clicks);
    totals.inlineLinkClicks += asInt(row.inlineLinkClicks);
  }

  for (const candidate of candidates) {
    const completed = hasCompleteCoreDataForMeta(candidate);
    const cv = hasCvForMeta(candidate);
    const apt = isAptForMeta(candidate);
    const hired = candidate.status === 'CONTRATADO';
    if (completed) totals.completedRegistrations += 1;
    if (cv) totals.cvReceived += 1;
    if (apt) totals.apt += 1;
    if (hired) totals.hired += 1;
    const adId = String(candidate.metaAdId || '').trim();
    if (adId && ads.has(adId)) {
      const item = ads.get(adId);
      if (completed) item.completedRegistrations += 1;
      if (cv) item.cvReceived += 1;
      if (apt) item.apt += 1;
      if (hired) item.hired += 1;
    }
  }

  const topAds = [...ads.values()]
    .map((ad) => ({
      ...ad,
      costPerLinkClick: metricCost(ad.spend, ad.inlineLinkClicks || ad.clicks),
      costPerCompletedRegistration: metricCost(ad.spend, ad.completedRegistrations),
      costPerCv: metricCost(ad.spend, ad.cvReceived),
      costPerApt: metricCost(ad.spend, ad.apt),
      completionRateFromClick: ad.inlineLinkClicks ? Math.round((ad.completedRegistrations / ad.inlineLinkClicks) * 100) : null
    }))
    .sort((a, b) => b.spend - a.spend || b.completedRegistrations - a.completedRegistrations)
    .slice(0, 12);

  return {
    ok: true,
    since: range.since,
    until: range.until,
    totals: {
      ...totals,
      adsWithSpend: topAds.filter((ad) => ad.spend > 0).length,
      costPerLinkClick: metricCost(totals.spend, totals.inlineLinkClicks || totals.clicks),
      costPerCompletedRegistration: metricCost(totals.spend, totals.completedRegistrations),
      costPerCv: metricCost(totals.spend, totals.cvReceived),
      costPerApt: metricCost(totals.spend, totals.apt),
      costPerHired: metricCost(totals.spend, totals.hired)
    },
    ads: topAds
  };
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

function injectMetaAdsSyncButton(html) {
  return html;
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
    canAccessDispatch: Boolean(user.canAccessDispatch),
    canAccessMetaAds: Boolean(user.canAccessMetaAds),
    canAccessCvAnalysis: Boolean(user.canAccessCvAnalysis)
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
  req.session.canAccessMetaAds = Boolean(payload.canAccessMetaAds);
  req.session.canAccessCvAnalysis = Boolean(payload.canAccessCvAnalysis);
  req.session.canAccessStatistics = req.session.canAccessMetaAds || req.session.canAccessCvAnalysis;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    let output = body;
    if (shouldReplaceLorenV2UiLabel(output, res)) {
      output = replaceLorenV2UiLabel(output);
      output = injectMetaAdsSyncButton(output, req);
    }
    return originalSend(output);
  };
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

app.use(dispatchAuditMiddleware(prisma));

app.use((req, res, next) => {
  req.userRole = req.session?.userRole || null;
  req.userId = req.session?.userId || null;
  req.username = req.session?.username || null;
  req.userAccessScope = req.session?.userAccessScope || 'ALL';
  req.userAccessCity = req.session?.userAccessCity || null;
  req.userAccessVacancyId = req.session?.userAccessVacancyId || null;
  req.userSource = req.session?.userSource || null;
  req.canAccessDispatch = Boolean(req.session?.canAccessDispatch);
  req.canAccessMetaAds = Boolean(req.session?.canAccessMetaAds);
  req.canAccessCvAnalysis = Boolean(req.session?.canAccessCvAnalysis);
  req.canAccessStatistics = req.canAccessMetaAds || req.canAccessCvAnalysis;
  res.locals.role = req.userRole;
  res.locals.canAccessDispatch = req.userRole === 'dev' || req.canAccessDispatch;
  res.locals.canSeeLorenV2 = canSeeLorenV2(req);
  next();
});

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
      canAccessMetaAds: true,
      canAccessCvAnalysis: true,
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
        canAccessDispatch: role === 'dev',
        canAccessMetaAds: role === 'dev',
        canAccessCvAnalysis: role === 'dev'
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
app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/reports`, (_req, res) => res.redirect(301, LOREN_STATS_BASE_PATH));
app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/daily-summary`, (_req, res) => res.redirect(301, LOREN_STATS_BASE_PATH));
app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/data-consents`, (_req, res) => res.redirect(301, LOREN_STATS_BASE_PATH));
app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/cv-analysis`, (_req, res) => res.redirect(301, `${LOREN_STATS_BASE_PATH}/cv-analysis`));

app.get(`${LOREN_STATS_BASE_PATH}/daily-summary`, (_req, res) => res.redirect(301, LOREN_STATS_BASE_PATH));
app.get(`${LOREN_STATS_BASE_PATH}/reports`, (_req, res) => res.redirect(301, LOREN_STATS_BASE_PATH));
app.get(`${LOREN_STATS_BASE_PATH}/data-consents`, (_req, res) => res.redirect(301, LOREN_STATS_BASE_PATH));
app.use(`${LOREN_STATS_BASE_PATH}/cv-analysis`, wrapAsyncRouter(lorenV2CvAnalysisRouter(prisma)));
app.post(`${LOREN_STATS_BASE_PATH}/meta/sync-form`, async (req, res, next) => {
  if (!canManageStats(req)) return res.status(403).send('No tienes permisos para sincronizar Meta Ads.');
  const metaConfig = getMetaAdsConfig();
  if (!metaConfig.enabled) return res.redirect(`${LOREN_STATS_BASE_PATH}/campaigns`);
  try {
    await syncMetaAdsInsights(prisma, {
      since: normalizeDateInput(req.body.since),
      until: normalizeDateInput(req.body.until)
    });
    return res.redirect(`${LOREN_STATS_BASE_PATH}/campaigns`);
  } catch (error) {
    console.error('[META_ADS_SYNC_FORM_ERROR]', error);
    return next(error);
  }
});
app.get(`${LOREN_STATS_BASE_PATH}/meta/summary`, async (req, res) => {
  if (!canManageStats(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  try {
    const summary = await loadMetaAdsSummary(req.query || {});
    return res.json(summary);
  } catch (error) {
    console.error('[META_ADS_SUMMARY_ERROR]', error);
    return res.status(500).json({ ok: false, error: 'summary_failed' });
  }
});
app.use(`${LOREN_STATS_BASE_PATH}/campaigns`, async (req, _res, next) => {
  try {
    await maybeAutoSyncMetaAds(req);
  } catch (error) {
    console.warn('[META_ADS_AUTO_SYNC_MIDDLEWARE_ERROR]', error?.message || error);
  }
  return next();
});
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
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
  console.info('[OPENAI_MODEL_CONFIG]', JSON.stringify(getOpenAiModelConfig()));
});
