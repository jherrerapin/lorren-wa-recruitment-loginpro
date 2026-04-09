import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { adminRouter } from '../src/routes/admin.js';

function dashboardCandidate(overrides = {}) {
  return {
    id: overrides.id || 'candidate-1',
    fullName: 'Candidato Prueba',
    phone: '573001112233',
    documentType: 'CC',
    documentNumber: '123456789',
    age: 28,
    neighborhood: 'Centro',
    locality: null,
    zone: null,
    status: 'REGISTRADO',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    interviewNotes: null,
    cvOriginalName: 'hv.pdf',
    cvMimeType: 'application/pdf',
    cvStorageKey: 'cv/test.pdf',
    gender: 'UNKNOWN',
    createdAt: new Date('2026-04-08T12:00:00.000Z'),
    lastInboundAt: new Date('2026-04-08T12:05:00.000Z'),
    lastOutboundAt: new Date('2026-04-08T12:06:00.000Z'),
    devLastSeenAt: null,
    botPaused: false,
    botPauseReason: null,
    currentStep: 'DONE',
    interviewBookings: [],
    ...overrides
  };
}

function createDashboardPrismaMock({ candidateCount = 0, vacancies = [] } = {}) {
  return {
    candidate: {
      async count() {
        return candidateCount;
      },
      async findMany() {
        return [];
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
        return vacancies.map((vacancy) => structuredClone(vacancy));
      }
    }
  };
}

async function createServer(prisma, sessionData) {
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

  app.get('/test-login', (_req, res) => {
    const sid = `sid-${Math.random().toString(16).slice(2)}`;
    sessions.set(sid, sessionData);
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
  const response = await fetch(`${baseUrl}/test-login`);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';')[0];
}

test('dashboard severe regression: contador global y contratados quedan separados por vacante', async () => {
  const approvedCandidate = dashboardCandidate({
    id: 'cand-approved',
    fullName: 'Andres Aprobado',
    status: 'APROBADO'
  });
  const contractedCandidate = dashboardCandidate({
    id: 'cand-contracted',
    fullName: 'Camila Contratada',
    status: 'CONTRATADO'
  });
  const registeredCandidate = dashboardCandidate({
    id: 'cand-registered',
    fullName: 'Rosa Registrada',
    status: 'REGISTRADO',
    cvOriginalName: null,
    cvMimeType: null,
    cvStorageKey: null
  });

  const prisma = createDashboardPrismaMock({
    candidateCount: 8,
    vacancies: [
      {
        id: 'vac-iba-1',
        title: 'Coordinador de Operaciones Ibague',
        role: 'Coordinador de operaciones',
        city: 'Ibague',
        acceptingApplications: true,
        isActive: true,
        schedulingEnabled: false,
        interviewBookings: [],
        candidates: [approvedCandidate, contractedCandidate, registeredCandidate]
      }
    ]
  });

  const server = await createServer(prisma, {
    userRole: 'admin',
    userSource: 'db',
    userAccessScope: 'CITY',
    userAccessCity: 'Ibague'
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin?city=Ibague&date=2026-04-08`, {
      headers: { Cookie: cookie }
    });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Chats acumulados[\s\S]*metric-pill-value">8</);
    assert.match(html, /personas que han escrito en total/);
    assert.match(html, /section-title">Aprobados</);
    assert.match(html, /section-title">Contratados</);
    assert.equal((html.match(/Camila Contratada/g) || []).length, 1);
    assert.match(html, /Andres Aprobado/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('dashboard severe regression: la alerta manual solo muestra chats no revisados por dev', async () => {
  const reviewedCandidate = dashboardCandidate({
    id: 'cand-reviewed',
    fullName: 'Revisado Manual',
    status: 'REGISTRADO',
    botPaused: true,
    botPauseReason: 'Duda posterior requiere intervencion manual',
    lastInboundAt: new Date('2026-04-08T12:05:00.000Z'),
    botPausedAt: new Date('2026-04-08T12:06:00.000Z'),
    devLastSeenAt: new Date('2026-04-08T12:10:00.000Z')
  });
  const pendingCandidate = dashboardCandidate({
    id: 'cand-pending',
    fullName: 'Pendiente Manual',
    status: 'REGISTRADO',
    botPaused: true,
    botPauseReason: 'Duda posterior requiere intervencion manual',
    lastInboundAt: new Date('2026-04-08T12:08:00.000Z'),
    botPausedAt: new Date('2026-04-08T12:09:00.000Z'),
    devLastSeenAt: new Date('2026-04-08T12:07:00.000Z')
  });

  const prisma = createDashboardPrismaMock({
    candidateCount: 2,
    vacancies: [
      {
        id: 'vac-iba-2',
        title: 'Auxiliar Cargue y Descargue',
        role: 'Auxiliar de cargue y descargue',
        city: 'Ibague',
        acceptingApplications: true,
        isActive: true,
        schedulingEnabled: false,
        interviewBookings: [],
        candidates: [reviewedCandidate, pendingCandidate]
      }
    ]
  });

  const server = await createServer(prisma, {
    userRole: 'dev',
    userSource: 'env'
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin?city=Ibague&date=2026-04-08`, {
      headers: { Cookie: cookie }
    });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Hay 1 chat/);
    assert.match(html, /Atencion manual pendiente[\s\S]*\(1\)/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
