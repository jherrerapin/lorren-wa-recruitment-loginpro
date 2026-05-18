import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomInt } from 'node:crypto';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { webhookRouter } from './routes/webhook.js';
import { adminRouter } from './routes/admin.js';
import { botKnowledgeCrudRouter } from './routes/botKnowledgeCrud.js';
import { locationsRouter } from './routes/locations.js';
import { dispatchBridgeRouter } from './routes/dispatchBridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const prisma = new PrismaClient();
const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const sessionCookieName = process.env.SESSION_COOKIE_NAME || 'loginpro.sid';
const sessionSecret = process.env.SESSION_SECRET || 'dev-session-secret-change-me';

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

function generateRecoveryCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

async function buildUniqueOperationsUsername() {
  const base = 'operaciones-despacho';
  const existingUsers = await prisma.appUser.findMany({
    where: { username: { startsWith: base } },
    select: { username: true }
  });
  const used = new Set(existingUsers.map((user) => user.username));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function buildLoginViewModel(overrides = {}) {
  return {
    error: null,
    username: '',
    success: null,
    ...overrides
  };
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
    userSource: 'db'
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
  req.userId = req.session?.userId || null;
  req.username = req.session?.username || null;
  req.userAccessScope = req.session?.userAccessScope || 'ALL';
  req.userAccessCity = req.session?.userAccessCity || null;
  req.userAccessVacancyId = req.session?.userAccessVacancyId || null;
  req.userSource = req.session?.userSource || null;
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
        userSource: 'env'
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
      return res.status(500).render('login', buildLoginViewModel({
        error: 'No fue posible iniciar sesion. Intenta nuevamente.',
        username
      }));
    }
    applySessionPayload(req, sessionPayload);
    req.session.save((saveError) => {
      if (saveError) {
        return res.status(500).render('login', buildLoginViewModel({
          error: 'No fue posible iniciar sesion. Intenta nuevamente.',
          username
        }));
      }
      return res.redirect(isOperationsOnlyUsername(sessionPayload.username) ? '/admin/operaciones/abrir' : '/admin');
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

app.get('/admin/users/create-operations', (req, res) => {
  if (!req.session?.userRole) return res.redirect('/login');
  if (req.session.userRole !== 'dev') return res.status(403).send('Acceso restringido a desarrolladores');

  return res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Crear usuario de Operaciones / Despacho | LoginPro</title>
</head>
<body>
  <main>
    <h1>Crear usuario de Operaciones / Despacho</h1>
    <p>Este formulario crea un usuario limitado al módulo Operaciones / Despacho.</p>
    <form method="post" action="/admin/users/create-operations">
      <div>
        <label for="password">Contraseña inicial</label>
        <input id="password" name="password" type="password" required minlength="6" autocomplete="new-password" />
      </div>
      <div>
        <label for="recoveryPhone">Teléfono de recuperación</label>
        <input id="recoveryPhone" name="recoveryPhone" type="tel" autocomplete="tel" />
      </div>
      <div>
        <label for="recoveryEmail">Email de recuperación</label>
        <input id="recoveryEmail" name="recoveryEmail" type="email" autocomplete="email" />
      </div>
      <button type="submit">Crear usuario de Operaciones / Despacho</button>
    </form>
    <p><a href="/admin/users">Volver a Usuarios</a></p>
  </main>
</body>
</html>`);
});

app.post('/admin/users/create-operations', express.urlencoded({ extended: true }), async (req, res) => {
  if (req.session?.userRole !== 'dev') return res.status(403).send('Acceso restringido a desarrolladores');
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 6) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('La contraseña inicial debe tener al menos 6 caracteres.'));
  }
  const username = await buildUniqueOperationsUsername();
  const passwordHash = await bcrypt.hash(password, 10);
  const recoveryCode = generateRecoveryCode();
  const recoveryCodeHash = await bcrypt.hash(recoveryCode, 10);
  await prisma.appUser.create({
    data: {
      username,
      passwordHash,
      recoveryCodeHash,
      role: 'ADMIN',
      accessScope: 'ALL',
      recoveryPhone: normalizeString(req.body.recoveryPhone),
      recoveryEmail: normalizeString(req.body.recoveryEmail),
      createdByUsername: req.session?.username || 'dev',
      lastPasswordResetAt: new Date(),
      isActive: true
    }
  });
  const params = new URLSearchParams();
  params.set('success', `Usuario ${username} creado con acceso a Operaciones / Despacho.`);
  params.set('username', username);
  params.set('recoveryCode', recoveryCode);
  return res.redirect(`/admin/users?${params.toString()}`);
});

app.use('/webhook', webhookRouter(prisma));
app.use('/admin/bot-knowledge', botKnowledgeCrudRouter(prisma));
app.use('/admin/operaciones', dispatchBridgeRouter());
app.use('/admin', (req, res, next) => {
  if (isOperationsOnlyUsername(req.session?.username || req.username)) {
    if (req.method === 'GET' && (req.path === '/' || req.path === '')) return res.redirect('/admin/operaciones/abrir');
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
