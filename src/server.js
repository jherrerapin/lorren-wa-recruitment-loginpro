import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';
import { webhookRouter } from './routes/webhook.js';
import { adminRouter } from './routes/admin.js';
import { runReminderDispatcher } from './services/reminder.js';
import { createRedisClient, buildSessionStore } from './services/redisClient.js';
import { verifyPassword } from './services/authUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const prisma = new PrismaClient();
const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const sessionCookieName = process.env.SESSION_COOKIE_NAME || 'loginpro.sid';
const sessionSecret = process.env.SESSION_SECRET || 'dev-session-secret-change-me';

if (!process.env.SESSION_SECRET) {
  console.warn('[WARN] SESSION_SECRET no está configurada. Usa un valor robusto en producción.');
}

// Validación de hashes bcrypt al arranque (falla rápido si las vars están mal configuradas)
const AUTH_HASHES = {
  dev:   { user: process.env.DEV_USER,   hash: process.env.DEV_PASS },
  admin: { user: process.env.ADMIN_USER, hash: process.env.ADMIN_PASS }
};

for (const [role, creds] of Object.entries(AUTH_HASHES)) {
  if (creds.hash && !creds.hash.startsWith('$2')) {
    console.warn(`[WARN] ${role.toUpperCase()}_PASS no parece ser un hash bcrypt. Ejecuta: npm run hash-password`);
  }
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

// ─── REDIS + SESIONES ───────────────────────────────────────────────────────
const redisClient = await createRedisClient();
const sessionStore = buildSessionStore(redisClient);

app.use(session({
  name: sessionCookieName,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 8   // 8 horas
  }
}));

app.use((req, _res, next) => {
  req.userRole = req.session?.userRole || null;
  next();
});

// ─── RATE LIMITING ───────────────────────────────────────────────────────────
const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_WEBHOOK_MAX) || 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_requests', retryAfter: 60 },
  skip: (req) => req.method === 'GET'
});

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_LOGIN_MAX) || 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_requests', retryAfter: 900 },
  skipSuccessfulRequests: true
});

// ─── RUTAS PÚBLICAS ──────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  const redisOk = redisClient ? redisClient.status === 'ready' : false;
  res.status(200).json({ ok: true, redis: redisOk ? 'connected' : 'unavailable' });
});

app.get('/login', (req, res) => {
  if (req.session?.userRole) return res.redirect('/admin');
  res.render('login', { error: null, username: '' });
});

app.post('/login', loginRateLimit, async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  // Tiempo de respuesta constante para evitar timing attacks:
  // bcrypt.compare corre siempre con el mismo costo incluso si el usuario no existe.
  let role = null;

  if (username === AUTH_HASHES.dev.user) {
    const ok = await verifyPassword(password, AUTH_HASHES.dev.hash);
    if (ok) role = 'dev';
  } else if (username === AUTH_HASHES.admin.user) {
    const ok = await verifyPassword(password, AUTH_HASHES.admin.hash);
    if (ok) role = 'admin';
  } else {
    // Usuario no reconocido: correr un bcrypt dummy para igualar tiempo de respuesta
    await verifyPassword(password, '$2b$12$invalidhashpaddingtomatchcostXXXXXXXXXXXXXXXXX');
  }

  if (!role) {
    return res.status(401).render('login', { error: 'Usuario o contraseña inválidos.', username });
  }

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

// ─── RUTAS PROTEGIDAS ────────────────────────────────────────────────────────
app.use('/webhook', webhookRateLimit, webhookRouter(prisma));
app.use('/admin', adminRouter(prisma));

// ─── ERROR HANDLER ───────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[UNHANDLED_ERROR]', err);
  res.status(500).json({ error: 'internal_server_error' });
});

// ─── ARRANQUE ────────────────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[SERVER] Escuchando en puerto ${port} (${isProduction ? 'production' : 'development'})`);
  if (redisClient) console.log('[SERVER] Sesiones persistidas en Redis.');
  else console.log('[WARN] Sesiones en MemoryStore (solo desarrollo).');
});

// ─── REMINDER DISPATCHER ─────────────────────────────────────────────────────
const reminderIntervalMs = 60_000;
setInterval(async () => {
  try {
    await runReminderDispatcher(prisma, { redisClient });
  } catch (error) {
    console.error('[REMINDER_DISPATCHER_ERROR]', error);
  }
}, reminderIntervalMs);
