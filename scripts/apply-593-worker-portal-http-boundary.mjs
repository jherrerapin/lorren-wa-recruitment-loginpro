import { readFileSync, writeFileSync } from 'node:fs';

const read = (file) => readFileSync(file, 'utf8');
const write = (file, content) => writeFileSync(file, content, 'utf8');

function replaceOnce(file, source, target, label) {
  const content = read(file);
  if (content.includes(target)) return;
  const count = content.split(source).length - 1;
  if (count !== 1) throw new Error(`${label}: se esperaba una sola ancla y se encontraron ${count}`);
  write(file, content.replace(source, target));
}

const serverFile = 'src/server.js';
{
  let content = read(serverFile);
  const mount = "app.use('/operaciones/portal', wrapAsyncRouter(workerPortalRouter(prisma)));";
  const earlyBlock = [
    "app.use(morgan('combined'));",
    mount,
    "app.use(express.json({ limit: '2mb' }));"
  ].join('\n');
  if (!content.includes(earlyBlock)) {
    const anchor = "app.use(morgan('combined'));\napp.use(express.json({ limit: '2mb' }));";
    const count = content.split(anchor).length - 1;
    if (count !== 1) throw new Error(`server: ancla de parsers encontrada ${count} veces`);
    content = content.replace(anchor, earlyBlock);
  }
  const firstMount = content.indexOf(mount);
  const secondMount = content.indexOf(mount, firstMount + mount.length);
  if (firstMount < 0) throw new Error('server: no se encontró montaje del portal');
  if (secondMount >= 0) {
    content = `${content.slice(0, secondMount)}${content.slice(secondMount + mount.length + 1)}`;
  }
  write(serverFile, content);
}

const testFile = 'test/workerPortalActivationRouter.test.js';
replaceOnce(
  testFile,
  "import fs from 'node:fs';\n",
  "import fs from 'node:fs';\nimport express from 'express';\nimport { once } from 'node:events';\n",
  'test: importar servidor HTTP'
);

replaceOnce(
  testFile,
  "  applyWorkerPortalSecurityHeaders,\n",
  "  applyWorkerPortalSecurityHeaders,\n  createWorkerPortalActivationAttemptMiddleware,\n",
  'test: importar middleware de intentos'
);
replaceOnce(
  testFile,
  "  setWorkerPortalInstallationCookie,\n",
  "  setWorkerPortalInstallationCookie,\n  workerPortalActivationJsonErrorHandler,\n",
  'test: importar error handler JSON'
);

{
  let content = read(testFile);
  if (!content.includes('function workerPortalTestOptions(')) {
    const oldBlock = `function buildRouter(options = {}) {
  return workerPortalRouter({}, {
    repository: {},
    installationPepper: PEPPER,
    nowFn: () => NOW,
    randomUUIDFn: () => INSTALLATION_ID,
    nonceBytesFn: (size) => Buffer.alloc(size, 7),
    activateSessionFn: async () => ({
      rawSessionToken: SESSION_TOKEN,
      cookie: {
        name: WORKER_PORTAL_SESSION_COOKIE_NAME,
        options: workerPortalCookieOptions(EXPIRES_AT.getTime() - NOW.getTime())
      }
    }),
    resolveSessionFn: async () => null,
    ...options
  });
}`;
    const newBlock = `function workerPortalTestOptions(options = {}) {
  return {
    repository: {},
    installationPepper: PEPPER,
    nowFn: () => NOW,
    randomUUIDFn: () => INSTALLATION_ID,
    nonceBytesFn: (size) => Buffer.alloc(size, 7),
    activateSessionFn: async () => ({
      rawSessionToken: SESSION_TOKEN,
      cookie: {
        name: WORKER_PORTAL_SESSION_COOKIE_NAME,
        options: workerPortalCookieOptions(EXPIRES_AT.getTime() - NOW.getTime())
      }
    }),
    resolveSessionFn: async () => null,
    ...options
  };
}

function buildRouter(options = {}) {
  return workerPortalRouter({}, workerPortalTestOptions(options));
}

async function withPortalServer(options, callback) {
  const app = express();
  const globalErrors = [];
  app.use('/operaciones/portal', workerPortalRouter({}, workerPortalTestOptions(options)));
  app.use((error, _req, res, _next) => {
    globalErrors.push(error);
    return res.status(500).json({ error: 'global_error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const origin = \`http://127.0.0.1:\${address.port}\`;
  try {
    return await callback({ origin, globalErrors });
  } finally {
    server.close();
    await once(server, 'close');
  }
}`;
    const count = content.split(oldBlock).length - 1;
    if (count !== 1) throw new Error(`test: buildRouter encontrado ${count} veces`);
    content = content.replace(oldBlock, newBlock);
    write(testFile, content);
  }
}

{
  let content = read(testFile);
  const marker = "test('el límite se aplica antes de interpretar el JSON'";
  if (!content.includes(marker)) {
    const insertionAnchor = "test('las cookies del portal son Secure, HttpOnly, Strict y limitadas al portal', () => {";
    const index = content.indexOf(insertionAnchor);
    if (index < 0) throw new Error('test: no se encontró primera prueba');
    const block = `test('el límite se aplica antes de interpretar el JSON y de consultar la autoridad', async () => {
  let activationCalls = 0;
  const errorLogs = [];
  const originalError = console.error;
  console.error = (...args) => errorLogs.push(args);
  try {
    await withPortalServer({
      activateSessionFn: async () => {
        activationCalls += 1;
        throw new Error('must_not_run');
      }
    }, async ({ origin, globalErrors }) => {
      const response = await fetch(\`${'${origin}'}/operaciones/portal/activar\`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'worker-portal'
        },
        body: JSON.stringify({ activationToken: 'A'.repeat(5_000) })
      });
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { ok: false, error: 'activation_invalid_or_expired' });
      assert.equal(activationCalls, 0);
      assert.deepEqual(globalErrors, []);
      assert.deepEqual(errorLogs, []);
    });
  } finally {
    console.error = originalError;
  }
});

test('JSON malformado no llega al logger global ni expone el token', async () => {
  let activationCalls = 0;
  const errorLogs = [];
  const originalError = console.error;
  console.error = (...args) => errorLogs.push(args);
  try {
    await withPortalServer({
      activateSessionFn: async () => {
        activationCalls += 1;
        throw new Error('must_not_run');
      }
    }, async ({ origin, globalErrors }) => {
      const malformedBody = \`{\\"activationToken\\":\\"${'${ACTIVATION_TOKEN}'}\\"\`;
      const response = await fetch(\`${'${origin}'}/operaciones/portal/activar\`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'worker-portal'
        },
        body: malformedBody
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { ok: false, error: 'activation_invalid_or_expired' });
      assert.equal(activationCalls, 0);
      assert.deepEqual(globalErrors, []);
      assert.deepEqual(errorLogs, []);
      assert.equal(JSON.stringify(errorLogs).includes(ACTIVATION_TOKEN), false);
    });
  } finally {
    console.error = originalError;
  }
});

test('el guard devuelve 429 antes del parser y de PostgreSQL', async () => {
  let activationCalls = 0;
  let guardCalls = 0;
  await withPortalServer({
    activationAttemptGuard: {
      consume() {
        guardCalls += 1;
        return { allowed: false, retryAfterSeconds: 45 };
      }
    },
    activateSessionFn: async () => {
      activationCalls += 1;
      throw new Error('must_not_run');
    }
  }, async ({ origin, globalErrors }) => {
    const response = await fetch(\`${'${origin}'}/operaciones/portal/activar\`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'worker-portal'
      },
      body: '{not-json'
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '45');
    assert.deepEqual(await response.json(), { ok: false, error: 'activation_temporarily_limited' });
    assert.equal(guardCalls, 1);
    assert.equal(activationCalls, 0);
    assert.deepEqual(globalErrors, []);
  });
});

test('middleware y error handler rechazan dependencias o errores ajenos', () => {
  assert.throws(
    () => createWorkerPortalActivationAttemptMiddleware(null),
    /worker_portal_activation_attempt_guard_required/
  );

  const { res } = responseDouble();
  const unrelated = new Error('unrelated');
  let forwarded;
  workerPortalActivationJsonErrorHandler(unrelated, requestDouble(), res, (error) => {
    forwarded = error;
  });
  assert.equal(forwarded, unrelated);
});

`;
    content = `${content.slice(0, index)}${block}${content.slice(index)}`;
    write(testFile, content);
  }
}

{
  let content = read(testFile);
  const oldLogTest = `test('los logs sanitizan mensajes arbitrarios y nunca incluyen el token', async () => {
  const originalWarn = console.warn;
  let observedLog;
  console.warn = (...args) => { observedLog = args; };
  try {
    const router = buildRouter({
      activateSessionFn: async () => {
        throw new Error(\`sensitive ${'${ACTIVATION_TOKEN}'}\`);
      }
    });
    const { res } = responseDouble();

    await routeHandler(router, '/activar', 'post')(activationRequest(), res);

    assert.deepEqual(observedLog, [
      '[WORKER_PORTAL_ACTIVATION_REJECTED]',
      { code: 'worker_portal_error' }
    ]);
    assert.equal(JSON.stringify(observedLog).includes(ACTIVATION_TOKEN), false);
  } finally {
    console.warn = originalWarn;
  }
});`;
  const newLogTest = `test('los errores inesperados se registran con código sanitizado y nunca incluyen el token', async () => {
  const originalError = console.error;
  let observedLog;
  console.error = (...args) => { observedLog = args; };
  try {
    const router = buildRouter({
      activateSessionFn: async () => {
        throw new Error(\`sensitive ${'${ACTIVATION_TOKEN}'}\`);
      }
    });
    const { res } = responseDouble();

    await routeHandler(router, '/activar', 'post')(activationRequest(), res);

    assert.deepEqual(observedLog, [
      '[WORKER_PORTAL_ACTIVATION_ERROR]',
      { code: 'worker_portal_error' }
    ]);
    assert.equal(JSON.stringify(observedLog).includes(ACTIVATION_TOKEN), false);
  } finally {
    console.error = originalError;
  }
});

test('rechazos esperados de activación no generan warnings ni errores por solicitud', async () => {
  const originalWarn = console.warn;
  const originalError = console.error;
  const warnings = [];
  const errors = [];
  console.warn = (...args) => warnings.push(args);
  console.error = (...args) => errors.push(args);
  try {
    const router = buildRouter({
      activateSessionFn: async () => {
        throw new Error('worker_portal_session_repository_result_invalid');
      }
    });
    const { res, state } = responseDouble();

    await routeHandler(router, '/activar', 'post')(activationRequest(), res);

    assert.equal(state.statusCode, 400);
    assert.deepEqual(state.json, { ok: false, error: 'activation_invalid_or_expired' });
    assert.deepEqual(warnings, []);
    assert.deepEqual(errors, []);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});`;
  if (!content.includes(newLogTest)) {
    const count = content.split(oldLogTest).length - 1;
    if (count !== 1) throw new Error(`test: prueba de logs encontrada ${count} veces`);
    content = content.replace(oldLogTest, newLogTest);
    write(testFile, content);
  }
}

replaceOnce(
  testFile,
  "  assert.ok(server.indexOf(mountStatement) < server.indexOf(\"app.use('/operaciones', wrapAsyncRouter(publicDispatchClientRouter()));\"));\n",
  "  assert.ok(server.indexOf(mountStatement) < server.indexOf(\"app.use(express.json({ limit: '2mb' }));\"));\n  assert.equal(server.split(mountStatement).length - 1, 1);\n",
  'test: exigir montaje antes del parser global'
);

const docsFile = 'docs/architecture/14_asistencia_operativa_activacion_http_portal.md';
{
  let content = read(docsFile);
  const marker = '## Frontera HTTP reforzada';
  if (!content.includes(marker)) {
    content = `${content.trimEnd()}\n\n## Frontera HTTP reforzada\n\nLa ruta del portal se monta antes de los parsers JSON globales. `POST /activar` aplica su propio límite de 4 KB, captura localmente JSON inválido o demasiado grande y no propaga el cuerpo al logger global.\n\nAntes del parser y de PostgreSQL se ejecuta un guard de intentos por dirección de red. La implementación predeterminada mantiene una ventana acotada, un número máximo de intentos y un máximo de claves; expulsa entradas vencidas o menos recientes. El guard es inyectable para sustituirlo por un adaptador compartido cuando el servicio opere con múltiples réplicas.\n\nLos rechazos esperados de tokens inválidos, vencidos, consumidos o revocados no generan un warning por solicitud. Los errores inesperados o de configuración se registran únicamente mediante códigos sanitizados.\n`;
    write(docsFile, content);
  }
}

console.log('Hotfix #593 aplicado correctamente.');
