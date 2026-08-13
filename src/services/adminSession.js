import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { prisma as defaultPrisma } from '../lib/prisma.js';

export const ADMIN_SESSION_DEFAULTS = Object.freeze({
  cookieName: 'loginpro.sid',
  developmentSecret: 'dev-session-secret-change-me',
  maxAgeMs: 1000 * 60 * 60 * 8,
  storeTableName: 'session',
  pruneSessionIntervalSeconds: 60 * 60
});

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function environmentSessionCanUseDispatch(sessionData = {}) {
  const username = normalizeString(sessionData.username);
  return sessionData.userRole === 'dev'
    || sessionData.canAccessDispatch === true
    || Boolean(username?.startsWith('operaciones-despacho'));
}

function environmentProfileData(sessionData, passwordHash) {
  const username = normalizeString(sessionData.username);
  const isDev = sessionData.userRole === 'dev';
  return {
    username,
    passwordHash,
    role: isDev ? 'DEV' : 'ADMIN',
    accessScope: 'ALL',
    scopeCity: null,
    scopeVacancyId: null,
    createdByUsername: username,
    canAccessDispatch: true,
    canAccessAttendance: isDev || sessionData.canAccessAttendance === true,
    canAccessStatistics: isDev || sessionData.canAccessStatistics === true,
    canAccessMetaAds: isDev || sessionData.canAccessMetaAds === true,
    canAccessCvAnalysis: isDev || sessionData.canAccessCvAnalysis === true,
    isActive: true
  };
}

export async function ensureEnvironmentDispatchProfile(sessionData, {
  prismaClient = defaultPrisma,
  bcryptModule = bcrypt,
  randomBytesFn = randomBytes
} = {}) {
  if (!sessionData || sessionData.userSource !== 'env' || sessionData.userId) return null;
  const username = normalizeString(sessionData.username);
  if (!username || !environmentSessionCanUseDispatch(sessionData) || !prismaClient?.appUser) return null;

  const existing = await prismaClient.appUser.findUnique({ where: { username } });
  if (existing) {
    if (existing.isActive !== false) sessionData.userId = existing.id;
    return existing;
  }

  const randomPassword = randomBytesFn(32).toString('hex');
  const passwordHash = await bcryptModule.hash(randomPassword, 10);
  let created;
  try {
    created = await prismaClient.appUser.create({
      data: environmentProfileData(sessionData, passwordHash)
    });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    created = await prismaClient.appUser.findUnique({ where: { username } });
  }

  if (created?.isActive !== false) sessionData.userId = created?.id || null;
  return created || null;
}

export function resolveAdminSessionConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const hasConfiguredSecret = Boolean(env.SESSION_SECRET);

  return {
    isProduction,
    hasConfiguredSecret,
    databaseUrl: env.DATABASE_URL,
    cookieName: env.SESSION_COOKIE_NAME || ADMIN_SESSION_DEFAULTS.cookieName,
    secret: env.SESSION_SECRET || ADMIN_SESSION_DEFAULTS.developmentSecret,
    storeOptions: {
      conString: env.DATABASE_URL,
      tableName: ADMIN_SESSION_DEFAULTS.storeTableName,
      createTableIfMissing: true,
      pruneSessionInterval: ADMIN_SESSION_DEFAULTS.pruneSessionIntervalSeconds
    },
    sessionOptions: {
      name: env.SESSION_COOKIE_NAME || ADMIN_SESSION_DEFAULTS.cookieName,
      secret: env.SESSION_SECRET || ADMIN_SESSION_DEFAULTS.developmentSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        path: '/',
        maxAge: ADMIN_SESSION_DEFAULTS.maxAgeMs
      }
    }
  };
}

export function buildAdminSessionCookieClearOptions(config = resolveAdminSessionConfig()) {
  const cookie = config?.sessionOptions?.cookie || {};
  return {
    path: cookie.path || '/',
    httpOnly: cookie.httpOnly !== false,
    sameSite: cookie.sameSite || 'lax',
    secure: Boolean(cookie.secure)
  };
}

export function createAdminLogoutHandler({
  config = resolveAdminSessionConfig(),
  logger = console
} = {}) {
  const cookieName = config.cookieName;
  const cookieOptions = buildAdminSessionCookieClearOptions(config);

  return function destroyAdminSession(req, res) {
    const finishLogout = () => {
      res.set('Cache-Control', 'no-store');
      res.clearCookie(cookieName, cookieOptions);
      return res.redirect(303, '/login');
    };

    if (!req.session || typeof req.session.destroy !== 'function') {
      return finishLogout();
    }

    return req.session.destroy((error) => {
      if (error) logger.error('[LOGOUT_DESTROY_ERROR]', error);
      return finishLogout();
    });
  };
}

export function createAdminSessionMiddleware({
  env = process.env,
  logger = console,
  sessionModule = session,
  connectPgSimpleModule = connectPgSimple,
  prismaClient = defaultPrisma,
  bcryptModule = bcrypt,
  randomBytesFn = randomBytes
} = {}) {
  const config = resolveAdminSessionConfig(env);

  if (!config.hasConfiguredSecret) {
    logger.warn('SESSION_SECRET no esta configurada. Usa un valor robusto en produccion.');
  }

  const PgStore = connectPgSimpleModule(sessionModule);
  const store = new PgStore(config.storeOptions);
  store.on('error', (error) => {
    logger.error('[SESSION_STORE_ERROR]', error);
  });

  const baseMiddleware = sessionModule({
    ...config.sessionOptions,
    store
  });

  const middleware = (req, res, next) => baseMiddleware(req, res, (sessionError) => {
    if (sessionError) return next(sessionError);
    return Promise.resolve()
      .then(() => ensureEnvironmentDispatchProfile(req.session, { prismaClient, bcryptModule, randomBytesFn }))
      .catch((error) => {
        logger.warn('[ENV_DISPATCH_PROFILE_BRIDGE_FAILED]', error);
      })
      .then(() => next());
  });

  return { middleware, store, config };
}
