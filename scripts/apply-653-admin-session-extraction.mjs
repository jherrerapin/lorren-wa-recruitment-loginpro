import fs from 'node:fs';
import crypto from 'node:crypto';

const filePath = 'src/server.js';
const expectedBlobSha = 'd7778e4b5fb4f5368a3d3dda392570223822fb23';
let source = fs.readFileSync(filePath, 'utf8');

function gitBlobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex');
}

function replaceExact(oldText, newText, expectedCount = 1) {
  const count = source.split(oldText).length - 1;
  if (count !== expectedCount) {
    throw new Error(`Reemplazo inseguro: se esperaban ${expectedCount} ocurrencias y se encontraron ${count}`);
  }
  source = source.replaceAll(oldText, newText);
}

if (gitBlobSha(source) !== expectedBlobSha) {
  throw new Error(`server.js cambió antes de aplicar #653. SHA observado: ${gitBlobSha(source)}`);
}

replaceExact(
  "import session from 'express-session';\nimport connectPgSimple from 'connect-pg-simple';\n",
  ''
);

replaceExact(
  "import { getOpenAiModelConfig } from './services/openAiModelConfig.js';",
  "import { getOpenAiModelConfig } from './services/openAiModelConfig.js';\nimport { createAdminSessionMiddleware } from './services/adminSession.js';"
);

replaceExact(
  "const sessionCookieName = process.env.SESSION_COOKIE_NAME || 'loginpro.sid';\nconst sessionSecret = process.env.SESSION_SECRET || 'dev-session-secret-change-me';\n",
  ''
);

replaceExact(
`if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET no esta configurada. Usa un valor robusto en produccion.');
}

`,
  ''
);

replaceExact(
`const PgStore = connectPgSimple(session);
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
}));`,
`const { middleware: adminSessionMiddleware } = createAdminSessionMiddleware();
app.use(adminSessionMiddleware);`
);

fs.writeFileSync(filePath, source, 'utf8');
console.log(`Extracción #653 aplicada. Nuevo blob SHA: ${gitBlobSha(source)}`);
