import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { adminRouter } from '../src/routes/admin.js';

function completeCandidate(overrides = {}) {
  return {
    fullName: 'Ana Perez',
    documentType: 'CC',
    documentNumber: '123',
    age: 22,
    neighborhood: 'Centro',
    experienceInfo: 'Si',
    experienceTime: '1 ano',
    medicalRestrictions: 'No',
    transportMode: 'Bus',
    cvData: Buffer.from('cv'),
    createdAt: new Date(),
    phone: '573001112233',
    ...overrides
  };
}

function createPrismaMock(candidates, vacancies = []) {
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
    },
    vacancy: {
      async findMany() {
        return vacancies.map((v) => ({ ...v }));
      }
    }
  };
}

async function createServer(candidates, vacancies = []) {
  const prisma = createPrismaMock(candidates, vacancies);
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

test('GET /admin?status=registered muestra operativos y conserva APROBADO visible', async () => {
  const server = await createServer([
    completeCandidate({ id: 'legacy-validando', status: 'VALIDANDO' }),
    completeCandidate({ id: 'legacy-aprobado', status: 'APROBADO' }),
    completeCandidate({ id: 'contactado', status: 'CONTACTADO', fullName: 'Carlos Contactado' }),
    completeCandidate({ id: 'nuevo', status: 'NUEVO', cvData: null }),
    completeCandidate({ id: 'rechazado', status: 'RECHAZADO', fullName: 'Rex Rechazado' })
  ]);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin?status=registered`, { headers: { Cookie: cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Mostrando 2 candidato\(s\) registrados/);
    assert.match(html, /badge-registrado">Registrado/);
    assert.match(html, /badge-aprobado">Aprobado/);
    assert.doesNotMatch(html, /Carlos Contactado/);
    assert.doesNotMatch(html, /Rex Rechazado/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /admin?status=contacted muestra solo candidatos contactados', async () => {
  const server = await createServer([
    completeCandidate({ id: 'contactado', status: 'CONTACTADO', fullName: 'Carlos Contactado' }),
    completeCandidate({ id: 'legacy-validando', status: 'VALIDANDO', fullName: 'Val Legacy' }),
    completeCandidate({ id: 'legacy-aprobado', status: 'APROBADO', fullName: 'Aprob Legacy' }),
    completeCandidate({ id: 'rechazado', status: 'RECHAZADO', fullName: 'Rex Rechazado' })
  ]);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin?status=contacted`, { headers: { Cookie: cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Mostrando 1 candidato\(s\) contactados/);
    assert.match(html, /Carlos Contactado/);
    assert.doesNotMatch(html, /Val Legacy/);
    assert.doesNotMatch(html, /Aprob Legacy/);
    assert.doesNotMatch(html, /Rex Rechazado/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('recruiter no ve pestaña de nuevos ni candidatos incompletos en status=all', async () => {
  const server = await createServer([
    completeCandidate({ id: 'legacy-validando', status: 'VALIDANDO', fullName: 'Val Legacy' }),
    completeCandidate({ id: 'legacy-aprobado', status: 'APROBADO', fullName: 'Aprob Legacy' }),
    completeCandidate({ id: 'nuevo-incompleto', status: 'NUEVO', fullName: 'Nuevo Incompleto', cvData: null }),
    completeCandidate({ id: 'contactado', status: 'CONTACTADO', fullName: 'Carlos Contactado' })
  ]);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin?status=all`, { headers: { Cookie: cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.doesNotMatch(html, />Nuevos</);
    assert.match(html, /Val Legacy/);
    assert.match(html, /Aprob Legacy/);
    assert.match(html, /Carlos Contactado/);
    assert.doesNotMatch(html, /Nuevo Incompleto/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test('GET /admin muestra hojas de vida de vacante pausada en revisión', async () => {
  const registeredCandidate = completeCandidate({
    id: 'ibague-registered',
    status: 'REGISTRADO',
    fullName: 'Laura Ibague',
    vacancyId: 'vac-ibague-coordinador',
    interviewBookings: []
  });
  const server = await createServer([], [
    {
      id: 'vac-ibague-coordinador',
      title: 'Coordinador de operaciones',
      city: 'Ibagué',
      isActive: true,
      acceptingApplications: false,
      dashboardReviewEnabled: true,
      schedulingEnabled: false,
      interviewBookings: [],
      candidates: [registeredCandidate]
    }
  ]);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin?city=${encodeURIComponent('Ibagué')}`, { headers: { Cookie: cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Coordinador de operaciones/);
    assert.match(html, /Revisi[oó]n de HV · bot pausado/);
    assert.match(html, /Modo <strong>revisi[oó]n de hojas de vida<\/strong> con bot pausado\./);
    assert.match(html, /Laura Ibague/);
    assert.match(html, /✓ HV/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('detail.ejs deja NUEVO solo para dev', async () => {
  const detailTemplate = await fs.readFile(path.resolve(process.cwd(), 'src/views/detail.ejs'), 'utf8');
  assert.match(detailTemplate, /<% if \(role === 'dev'\) \{ %>\s*<option value="NUEVO"/);
});

test('detail.ejs ya no renderiza la tarjeta Traza AI/CV', async () => {
  const detailTemplate = await fs.readFile(path.resolve(process.cwd(), 'src/views/detail.ejs'), 'utf8');
  assert.doesNotMatch(detailTemplate, /Traza AI\/CV \(ultimos mensajes inbound\)/i);
});
