import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { adminRouter } from '../src/routes/admin.js';

const ORIGINAL_R2_ENV = {
  R2_ENDPOINT: process.env.R2_ENDPOINT,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET: process.env.R2_BUCKET,
};

test.before(() => {
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET;
});

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINAL_R2_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const SAMPLE_PDF_BYTES = Buffer.from(
  '%PDF-1.1\n' +
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n' +
  '4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 72 120 Td (PDF de prueba) Tj ET\nendstream\nendobj\n' +
  'xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000202 00000 n \n' +
  'trailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n292\n%%EOF\n',
  'utf8'
);

function createPrismaMock(initialCandidate) {
  const state = {
    candidateAdminEvents: Array.isArray(initialCandidate.adminEvents)
      ? initialCandidate.adminEvents.map((event, index) => ({
        id: event.id || `event-${index + 1}`,
        candidateId: initialCandidate.id,
        createdAt: event.createdAt || new Date(),
        ...event
      }))
      : [],
    candidate: {
      vacancy: null,
      interviewBookings: [],
      messages: [],
      ...initialCandidate
    }
  };

  return {
    state,
    candidate: {
      async findUnique({ where }) {
        if (where.id !== state.candidate.id) return null;
        return {
          ...state.candidate,
          vacancy: state.candidate.vacancy || null,
          interviewBookings: Array.isArray(state.candidate.interviewBookings)
            ? [...state.candidate.interviewBookings]
            : [],
          messages: Array.isArray(state.candidate.messages)
            ? [...state.candidate.messages]
            : []
        };
      },
      async update({ where, data }) {
        if (where.id !== state.candidate.id) throw new Error('Candidate not found');
        state.candidate = { ...state.candidate, ...data };
        return { ...state.candidate };
      }
    },
    message: {
      async findFirst() {
        return null;
      },
      async findMany() {
        return [];
      },
      async create() {
        return {};
      }
    },
    vacancy: {
      async findMany() {
        return [];
      }
    },
    candidateAdminEvent: {
      async findMany({ where, orderBy, take } = {}) {
        let rows = state.candidateAdminEvents.filter((event) => !where?.candidateId || event.candidateId === where.candidateId);
        if (orderBy?.createdAt === 'desc') {
          rows = [...rows].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((event) => ({ ...event }));
      },
      async create({ data }) {
        const row = {
          id: data.id || `event-${state.candidateAdminEvents.length + 1}`,
          createdAt: data.createdAt || new Date(),
          ...data
        };
        state.candidateAdminEvents.push(row);
        return { ...row };
      }
    }
  };
}

async function createServer(initialCandidate) {
  const prisma = createPrismaMock(initialCandidate);
  const app = express();
  const sessions = new Map();

  app.set('view engine', 'ejs');
  app.set('views', path.resolve(process.cwd(), 'src/views'));

  app.use((req, _res, next) => {
    const cookieHeader = req.headers.cookie || '';
    const cookieMatch = cookieHeader.match(/sid=([^;]+)/);
    const sid = cookieMatch?.[1];
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

  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });

  return { prisma, server };
}

async function loginAndGetCookie(baseUrl, role = 'admin') {
  const response = await fetch(`${baseUrl}/test-login/${role}`);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';')[0];
}

test('sube PDF valido y descarga posterior funciona', async () => {
  const { prisma, server } = await createServer({
    id: 'cand-1',
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'admin');
    const form = new FormData();
    form.append('cvFile', new Blob([SAMPLE_PDF_BYTES], { type: 'application/pdf' }), 'cv.pdf');

    const uploadResponse = await fetch(`${baseUrl}/admin/candidates/cand-1/cv/upload`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
      redirect: 'manual'
    });
    assert.equal(uploadResponse.status, 302);
    assert.match(uploadResponse.headers.get('location') || '', /cvSuccess=/);

    assert.equal(prisma.state.candidate.cvOriginalName, 'cv.pdf');
    assert.equal(prisma.state.candidate.cvMimeType, 'application/pdf');
    assert.equal(Buffer.isBuffer(prisma.state.candidate.cvData), true);
    assert.deepEqual(prisma.state.candidate.cvData, SAMPLE_PDF_BYTES);

    const downloadResponse = await fetch(`${baseUrl}/admin/candidates/cand-1/cv`, {
      headers: { Cookie: cookie }
    });
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get('content-type'), 'application/pdf');
    assert.equal(downloadResponse.headers.get('content-length'), String(SAMPLE_PDF_BYTES.length));
    assert.match(downloadResponse.headers.get('content-disposition') || '', /filename="cv\.pdf"/);
    const downloadedBytes = Buffer.from(await downloadResponse.arrayBuffer());
    assert.deepEqual(downloadedBytes, SAMPLE_PDF_BYTES);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('sube reemplazo valido y luego permite eliminar', async () => {
  const { prisma, server } = await createServer({
    id: 'cand-2',
    cvData: Buffer.from('anterior'),
    cvOriginalName: 'old.pdf',
    cvMimeType: 'application/pdf'
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'dev');
    const form = new FormData();
    form.append(
      'cvFile',
      new Blob([SAMPLE_PDF_BYTES], { type: 'application/pdf' }),
      'nuevo.pdf'
    );

    const replaceResponse = await fetch(`${baseUrl}/admin/candidates/cand-2/cv/upload`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
      redirect: 'manual'
    });
    assert.equal(replaceResponse.status, 302);
    assert.match(replaceResponse.headers.get('location') || '', /cvSuccess=/);
    assert.equal(prisma.state.candidate.cvOriginalName, 'nuevo.pdf');
    assert.equal(prisma.state.candidate.cvMimeType, 'application/pdf');
    assert.deepEqual(prisma.state.candidate.cvData, SAMPLE_PDF_BYTES);

    const downloadResponse = await fetch(`${baseUrl}/admin/candidates/cand-2/cv`, {
      headers: { Cookie: cookie }
    });
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get('content-length'), String(SAMPLE_PDF_BYTES.length));
    const downloadedBytes = Buffer.from(await downloadResponse.arrayBuffer());
    assert.deepEqual(downloadedBytes, SAMPLE_PDF_BYTES);

    const deleteResponse = await fetch(`${baseUrl}/admin/candidates/cand-2/cv/delete`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual'
    });
    assert.equal(deleteResponse.status, 302);
    assert.equal(prisma.state.candidate.cvData, null);
    assert.equal(prisma.state.candidate.cvOriginalName, null);
    assert.equal(prisma.state.candidate.cvMimeType, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('descarga normaliza Uint8Array a Buffer conservando bytes exactos', async () => {
  const uintBytes = new Uint8Array(SAMPLE_PDF_BYTES);
  const { server } = await createServer({
    id: 'cand-5',
    cvData: uintBytes,
    cvOriginalName: 'uint.pdf',
    cvMimeType: 'application/pdf'
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'admin');
    const downloadResponse = await fetch(`${baseUrl}/admin/candidates/cand-5/cv`, {
      headers: { Cookie: cookie }
    });

    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get('content-type'), 'application/pdf');
    assert.equal(downloadResponse.headers.get('content-length'), String(SAMPLE_PDF_BYTES.length));
    const downloadedBytes = Buffer.from(await downloadResponse.arrayBuffer());
    assert.deepEqual(downloadedBytes, SAMPLE_PDF_BYTES);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('rechaza archivo invalido por MIME/extensión', async () => {
  const { prisma, server } = await createServer({
    id: 'cand-3',
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'admin');
    const form = new FormData();
    form.append('cvFile', new Blob([Buffer.from('txt')], { type: 'text/plain' }), 'notas.txt');

    const invalidResponse = await fetch(`${baseUrl}/admin/candidates/cand-3/cv/upload`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
      redirect: 'manual'
    });

    assert.equal(invalidResponse.status, 302);
    assert.match(invalidResponse.headers.get('location') || '', /cvError=/);
    assert.equal(prisma.state.candidate.cvData, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('acepta extensión permitida cuando llega mimetype genérico', async () => {
  const { prisma, server } = await createServer({
    id: 'cand-4',
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'admin');
    const fallbackBytes = Buffer.from('contenido docx en binario', 'utf8');
    const form = new FormData();
    form.append('cvFile', new Blob([fallbackBytes], { type: 'application/octet-stream' }), 'cv.docx');

    const uploadResponse = await fetch(`${baseUrl}/admin/candidates/cand-4/cv/upload`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
      redirect: 'manual'
    });

    assert.equal(uploadResponse.status, 302);
    assert.match(uploadResponse.headers.get('location') || '', /cvSuccess=/);
    assert.deepEqual(prisma.state.candidate.cvData, fallbackBytes);
    assert.equal(prisma.state.candidate.cvOriginalName, 'cv.docx');
    assert.equal(prisma.state.candidate.cvMimeType, 'application/octet-stream');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('admin no ve diagnosticos tecnicos de CV en detalle', async () => {
  const { server } = await createServer({
    id: 'cand-6',
    phone: '573001112233',
    cvData: Buffer.from('pdf'),
    cvOriginalName: 'hv.pdf',
    cvMimeType: 'application/pdf'
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'admin');
    const response = await fetch(`${baseUrl}/admin/candidates/cand-6`, {
      headers: { Cookie: cookie }
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(html, /Diagn(?:Ã³|ó)stico HV \(nombre\)/);
    assert.match(html, /Archivo actual/);
    assert.match(html, /Descargar/);
    assert.match(html, /Reemplazar/);
    assert.match(html, /Eliminar/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('dev si ve diagnosticos tecnicos de CV en detalle', async () => {
  const { server } = await createServer({
    id: 'cand-7',
    phone: '573001112244',
    cvData: Buffer.from('pdf'),
    cvOriginalName: 'hv_dev.pdf',
    cvMimeType: 'application/pdf',
    messages: []
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'dev');
    const response = await fetch(`${baseUrl}/admin/candidates/cand-7`, {
      headers: { Cookie: cookie }
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Diagn(?:Ã³|ó)stico HV \(nombre\)/);
    assert.match(html, /Diagn(?:Ã³|ó)stico HV \(MIME\)/);
    assert.match(html, /Diagn(?:Ã³|ó)stico HV \(bytes\)/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('acciones de mensajes salientes solo aparecen para dev', async () => {
  const candidate = {
    id: 'cand-8',
    phone: '573001000111',
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null,
    messages: []
  };
  const adminCtx = await createServer(candidate);
  const devCtx = await createServer({ ...candidate, id: 'cand-9', phone: '573001000222' });

  try {
    const adminBase = `http://127.0.0.1:${adminCtx.server.address().port}`;
    const adminCookie = await loginAndGetCookie(adminBase, 'admin');
    const adminRes = await fetch(`${adminBase}/admin/candidates/cand-8`, { headers: { Cookie: adminCookie } });
    const adminHtml = await adminRes.text();
    assert.doesNotMatch(adminHtml, /Mensajes salientes/);

    const devBase = `http://127.0.0.1:${devCtx.server.address().port}`;
    const devCookie = await loginAndGetCookie(devBase, 'dev');
    const devRes = await fetch(`${devBase}/admin/candidates/cand-9`, { headers: { Cookie: devCookie } });
    const devHtml = await devRes.text();
    assert.match(devHtml, /Mensajes salientes/);
    assert.match(devHtml, /Solicitar Hoja de vida/);
  } finally {
    await new Promise(resolve => adminCtx.server.close(resolve));
    await new Promise(resolve => devCtx.server.close(resolve));
  }
});

test('movimientos del reclutador solo aparecen en perfil dev', async () => {
  const baseCandidate = {
    phone: '573001000333',
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null,
    messages: [],
    adminEvents: [
      {
        id: 'event-1',
        actorRole: 'admin',
        eventType: 'STATUS_CHANGED',
        eventLabel: 'Cambio de estado',
        fromValue: 'Registrado',
        toValue: 'Aprobado',
        createdAt: new Date('2026-04-08T15:12:00.000Z')
      }
    ]
  };
  const adminCtx = await createServer({
    id: 'cand-10',
    ...baseCandidate
  });
  const devCtx = await createServer({
    id: 'cand-11',
    ...baseCandidate,
    phone: '573001000444'
  });

  try {
    const adminBase = `http://127.0.0.1:${adminCtx.server.address().port}`;
    const adminCookie = await loginAndGetCookie(adminBase, 'admin');
    const adminResponse = await fetch(`${adminBase}/admin/candidates/cand-10`, {
      headers: { Cookie: adminCookie }
    });
    const adminHtml = await adminResponse.text();
    assert.equal(adminResponse.status, 200);
    assert.doesNotMatch(adminHtml, /Movimientos del reclutador/);

    const devBase = `http://127.0.0.1:${devCtx.server.address().port}`;
    const devCookie = await loginAndGetCookie(devBase, 'dev');
    const devResponse = await fetch(`${devBase}/admin/candidates/cand-11`, {
      headers: { Cookie: devCookie }
    });
    const devHtml = await devResponse.text();
    assert.equal(devResponse.status, 200);
    assert.match(devHtml, /Movimientos del reclutador/);
    assert.match(devHtml, /Cambio de estado/);
    assert.match(devHtml, /Reclutador/);
    assert.match(devHtml, /Registrado/);
    assert.match(devHtml, /Aprobado/);
  } finally {
    await new Promise(resolve => adminCtx.server.close(resolve));
    await new Promise(resolve => devCtx.server.close(resolve));
  }
});

test('cambio de estado registra trazabilidad administrativa', async () => {
  const { prisma, server } = await createServer({
    id: 'cand-12',
    phone: '573001000555',
    status: 'REGISTRADO',
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null,
    messages: []
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'admin');
    const form = new URLSearchParams();
    form.set('status', 'APROBADO');
    form.set('returnTo', '/admin');

    const response = await fetch(`${baseUrl}/admin/candidates/cand-12/status`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString(),
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.equal(prisma.state.candidate.status, 'APROBADO');
    assert.equal(prisma.state.candidateAdminEvents.length, 1);
    assert.equal(prisma.state.candidateAdminEvents[0].eventType, 'STATUS_CHANGED');
    assert.equal(prisma.state.candidateAdminEvents[0].actorRole, 'admin');
    assert.equal(prisma.state.candidateAdminEvents[0].fromValue, 'Registrado');
    assert.equal(prisma.state.candidateAdminEvents[0].toValue, 'Aprobado');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
