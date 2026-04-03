import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import { adminRouter } from '../src/routes/admin.js';

function completeCandidate(overrides = {}) {
  return {
    fullName: 'Ana Perez',
    documentType: 'CC',
    documentNumber: '123',
    age: 22,
    neighborhood: 'Centro',
    experienceInfo: 'Sí',
    experienceTime: '1 año',
    medicalRestrictions: 'No',
    transportMode: 'Bus',
    cvData: Buffer.from('cv'),
    createdAt: new Date(),
    phone: '573001112233',
    ...overrides
  };
}

function createPrismaMock(candidates) {
  return {
    candidate: {
      async findMany() {
        return candidates.map((c) => ({ ...c }));
      },
      async findUnique() {
        return null;
      }
    },
    message: {
      async findFirst() {
        return null;
      },
      async findMany() {
        return [];
      }
    }
  };
}

async function createServer(candidates) {
  const prisma = createPrismaMock(candidates);
  const app = express();
  const sessions = new Map();

  app.set('view engine', 'ejs');
  app.set('views', path.resolve(process.cwd(), 'src/views'));

  app.use((req, _res, next) => {
    const cookieHeader = req.headers.cookie || '';
    const sid = cookieHeader.match(/sid=([^;]+)/)?.[1];
    req.session = sid && sessions.has(sid) ? sessions.get(sid) : {};
    next();
  });

  app.get('/test-login/:role', (req, res) => {
    const sid = `sid-${Math.random().toString(16).slice(2)}`;
    sessions.set(sid, { userRole: req.params.role });
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly`);
    res.status(204).end();
  });

  app.use('/admin', adminRouter(prisma));

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  return server;
}

async function loginAndGetCookie(baseUrl) {
  const response = await fetch(`${baseUrl}/test-login/admin`);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';')[0];
}

test('GET /admin usa status=registered por defecto y mapea legacy como registrados', async () => {
  const server = await createServer([
    completeCandidate({ id: 'legacy-validando', status: 'VALIDANDO' }),
    completeCandidate({ id: 'legacy-aprobado', status: 'APROBADO' }),
    completeCandidate({ id: 'contactado', status: 'CONTACTADO', fullName: 'Candidato Contactado' }),
    completeCandidate({ id: 'nuevo', status: 'NUEVO', cvData: null }),
    completeCandidate({ id: 'rechazado', status: 'RECHAZADO' })
  ]);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Mostrando 2 candidato\(s\) registrados/);
    assert.match(html, /badge-registrado">Registrado/);
    assert.doesNotMatch(html, /Candidato Contactado/);
    assert.doesNotMatch(html, /En revisión/);
    assert.doesNotMatch(html, /Aprobado/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /admin?status=contacted muestra solo contactados', async () => {
  const server = await createServer([
    completeCandidate({ id: 'legacy-validando', status: 'VALIDANDO' }),
    completeCandidate({ id: 'contactado', status: 'CONTACTADO', fullName: 'Candidato Contactado' }),
    completeCandidate({ id: 'rechazado', status: 'RECHAZADO', fullName: 'Candidato Rechazado' })
  ]);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin?status=contacted`, { headers: { Cookie: cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Mostrando 1 candidato\(s\) contactados/);
    assert.match(html, /Candidato Contactado/);
    assert.doesNotMatch(html, /Candidato Rechazado/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
