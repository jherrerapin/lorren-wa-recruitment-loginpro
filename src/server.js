import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { webhookRouter } from './routes/webhook.js';
import { adminRouter } from './routes/admin.js';
import { locationsRouter } from './routes/locations.js';
import { runReminderDispatcher } from './services/reminder.js';
import { runAutoCvMigration } from './services/cvMigration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const prisma = new PrismaClient();
const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const sessionCookieName = process.env.SESSION_COOKIE_NAME || 'loginpro.sid';
const sessionSecret = process.env.SESSION_SECRET || 'dev-session-secret-change-me';

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET no está configurada. Usa un valor robusto en producción.');
}

if (isProduction) {
  app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(morgan('combined'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const PgStore = connectPgSimple(session);
const sessionStore = new PgStore({
  conString: process.env.DATABASE_URL,
  tableName: 'session',
  createTableIfMissing: true,
  pruneSessionInterval: 60 * 60
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

app.use((req, _res, next) => {
  req.userRole = req.session?.userRole || null;
  next();
});

app.get('/health', async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.status(200).json({ ok: true });
});

app.get('/login', (req, res) => {
  if (req.session?.userRole) return res.redirect('/admin');
  res.render('login', { error: null, username: '' });
});

async function verifyCredential(plain, envValue) {
  if (!envValue) return false;
  if (envValue.startsWith('$2b$') || envValue.startsWith('$2a$')) {
    return bcrypt.compare(plain, envValue);
  }
  return plain === envValue;
}

app.post('/login', async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  let role = null;
  if (username === process.env.DEV_USER && await verifyCredential(password, process.env.DEV_PASS)) role = 'dev';
  else if (username === process.env.ADMIN_USER && await verifyCredential(password, process.env.ADMIN_PASS)) role = 'admin';
  if (!role) return res.status(401).render('login', { error: 'Usuario o contraseña inválidos.', username });
  req.session.regenerate((regenError) => {
    if (regenError) return res.status(500).render('login', { error: 'No fue posible iniciar sesión. Intenta nuevamente.', username });
    req.session.userRole = role;
    req.session.username = username;
    req.session.save((saveError) => {
      if (saveError) return res.status(500).render('login', { error: 'No fue posible iniciar sesión. Intenta nuevamente.', username });
      return res.redirect('/admin');
    });
  });
});

const destroySession = (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(sessionCookieName);
    res.redirect('/login');
  });
};

app.post('/logout', destroySession);
app.get('/logout', destroySession);

app.use('/webhook', webhookRouter(prisma));
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

const reminderIntervalMs = 60_000;
setInterval(async () => {
  try { await runReminderDispatcher(prisma); }
  catch (error) { console.error('[REMINDER_DISPATCHER_ERROR]', error); }
}, reminderIntervalMs);

const autoCvMigrationIntervalMs = Number.parseInt(process.env.AUTO_CV_MIGRATION_INTERVAL_MS || String(5 * 60_000), 10) || (5 * 60_000);
setInterval(async () => {
  try {
    const result = await runAutoCvMigration(prisma);
    if (result?.triggered) {
      const suffix = result.failed ? ` failed=${result.failed}` : '';
      console.log(`[AUTO_CV_MIGRATION] pending=${result.pendingCount} migrated=${result.migrated} batch=${result.batchSize}${suffix}`);
    } else if (result?.skipped === 'below_threshold' && result.pendingCount > 0) {
      console.log(`[AUTO_CV_MIGRATION] skipped=below_threshold pending=${result.pendingCount} threshold=${result.threshold}`);
    }
  } catch (error) {
    console.error('[AUTO_CV_MIGRATION_ERROR]', error);
  }
}, autoCvMigrationIntervalMs);
