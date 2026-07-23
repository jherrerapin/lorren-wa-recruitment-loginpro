import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

export const ADMIN_SESSION_DEFAULTS = Object.freeze({
  cookieName: 'loginpro.sid',
  developmentSecret: 'dev-session-secret-change-me',
  maxAgeMs: 1000 * 60 * 60 * 8,
  storeTableName: 'session',
  pruneSessionIntervalSeconds: 60 * 60
});

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
        maxAge: ADMIN_SESSION_DEFAULTS.maxAgeMs
      }
    }
  };
}

export function createAdminSessionMiddleware({
  env = process.env,
  logger = console,
  sessionModule = session,
  connectPgSimpleModule = connectPgSimple
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

  const middleware = sessionModule({
    ...config.sessionOptions,
    store
  });

  return { middleware, store, config };
}
