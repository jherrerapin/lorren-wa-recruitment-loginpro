import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

export const ADMIN_SESSION_SECRET_ENV = 'SESSION_SECRET';
export const ADMIN_SESSION_SECRET_MIN_LENGTH = 32;
export const KNOWN_INSECURE_SESSION_SECRETS = Object.freeze([
  'dev-session-secret-change-me',
  'cambia-este-secreto',
  'ci-only-placeholder-not-for-production'
]);

export const ADMIN_SESSION_DEFAULTS = Object.freeze({
  cookieName: 'loginpro.sid',
  maxAgeMs: 1000 * 60 * 60 * 8,
  storeTableName: 'session',
  pruneSessionIntervalSeconds: 60 * 60
});

export function resolveAdminSessionSecret(env = process.env) {
  const configured = typeof env?.[ADMIN_SESSION_SECRET_ENV] === 'string'
    ? env[ADMIN_SESSION_SECRET_ENV].trim()
    : '';

  if (!configured) {
    throw new Error('admin_session_secret_required');
  }

  if (env.NODE_ENV === 'production') {
    const knownInsecure = KNOWN_INSECURE_SESSION_SECRETS.includes(configured);
    if (knownInsecure || configured.length < ADMIN_SESSION_SECRET_MIN_LENGTH) {
      throw new Error('admin_session_secret_insecure');
    }
  }

  return configured;
}

export function resolveAdminSessionConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const secret = resolveAdminSessionSecret(env);

  return {
    isProduction,
    hasConfiguredSecret: true,
    databaseUrl: env.DATABASE_URL,
    cookieName: env.SESSION_COOKIE_NAME || ADMIN_SESSION_DEFAULTS.cookieName,
    secret,
    storeOptions: {
      conString: env.DATABASE_URL,
      tableName: ADMIN_SESSION_DEFAULTS.storeTableName,
      createTableIfMissing: true,
      pruneSessionInterval: ADMIN_SESSION_DEFAULTS.pruneSessionIntervalSeconds
    },
    sessionOptions: {
      name: env.SESSION_COOKIE_NAME || ADMIN_SESSION_DEFAULTS.cookieName,
      secret,
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
  connectPgSimpleModule = connectPgSimple
} = {}) {
  const config = resolveAdminSessionConfig(env);
  const PgStore = connectPgSimpleModule(sessionModule);
  const store = new PgStore(config.storeOptions);
  store.on('error', (error) => {
    logger.error('[SESSION_STORE_ERROR]', error);
  });

  const middleware = sessionModule({
    ...config.sessionOptions,
    store
  });

  return { middleware, store, config };
}
